// REST：主机接口（contracts/rest-api.md）
// Phase 3（US1）：GET /api/hosts 只读
// Phase 4（US2）：完整 CRUD + 指纹确认 + 分组维护（T045/T046/T047）
import { randomBytes } from 'node:crypto';
import { sendJson, sendError, readJsonBody } from '../net/router.js';
import { resolveIdentity } from '../net/auth.js';
import { encryptSecret, decryptSecret } from '../crypto/secret.js';
import { createPassTicket } from '../net/tickets.js';
import { appendKnownHost } from '../ssh/hostkey.js';
import { require2fa } from './twofa.js';
import { normalizeDefaultGroup } from './groups.js';

const SHORT_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * 会话连接的授权范围（连接内「范围」选项）：
 * - all：全选（默认）——终端与 MCP 均可使用
 * - terminal：仅终端——该连接对 MCP 不可见（list_hosts 不列出，工具调用判定越权）
 * - mcp：仅 MCP——网页终端入口关闭（不可点连接），只能编辑，且编辑需 2FA 二次验证
 */
export const HOST_SCOPES = ['all', 'terminal', 'mcp'];

/** 未知/缺省范围一律按最宽的 all 处理（历史记录无该字段时保持原有行为） */
export function normalizeScope(v) {
  return HOST_SCOPES.includes(v) ? v : 'all';
}

/** MCP 终端提示词（仅 MCP 范围可携带）取值约束 */
const MCP_PROMPT_SCENARIO_MAX = 500;
const MCP_PROMPT_PREFER_ID_MAX = 128;
/** MCP 使用顺序：未指定「优先使用」时的基准值 */
export const MCP_ORDER_BASE = 1;

/** 4 位短随机后缀（base36，36^4≈168 万组合）：仅在名称无法用作 ID 时兜底 */
function shortSuffix() {
  return [...randomBytes(4)].map((b) => SHORT_ID_CHARS[b % 36]).join('');
}

/**
 * 设备 ID（主机 ID）：以会话名称（主机名称）为基准。
 * - 空白折叠为 `-`，去掉 URL 路径不安全的字符（/ \ ? # % & : 等），保留中英文、数字、. _ -
 * - 名称净化后为空 → 回退 h_ + 随机后缀
 * - 与既有设备 ID 冲突 → 追加 -2、-3…（ID 一经分配即固定，后续改名不影响）
 * - 唯一性按全量主机判定（不区分归属），确保设备 ID 全局不重复
 */
const ID_UNSAFE_RE = /[/\?#%&:\\\s]+/g;
function slugifyName(name) {
  return String(name ?? '')
    .trim()
    .replace(ID_UNSAFE_RE, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function nextHostId(store, name) {
  const base = slugifyName(name) || `h_${shortSuffix()}`;
  const free = async (id) => !(await store.getHostById(id)); // 全量主机：跨用户也保证不重复
  let id = base;
  for (let i = 2; i <= 999; i++) {
    if (await free(id)) return id;
    id = `${base}-${i}`;
  }
  for (let i = 0; i < 8; i++) {
    // 序号耗尽后回退随机后缀，仍保证唯一
    const rand = `${base}-${shortSuffix()}`;
    if (await free(rand)) return rand;
  }
  throw new Error('主机 ID 生成冲突超限');
}

/** host 字段允许的形态：域名或 IP 字面量，禁止分隔符与空白 */
const HOSTNAME_RE = /^[A-Za-z0-9._-]+$/;

function invalid(message) {
  const err = new Error(message);
  err.code = 'invalid_field';
  return err;
}

/**
 * 校验 MCP 终端提示词（仅「全选/MCP」范围可携带）。
 * @param {unknown} raw 请求体中的 mcpPrompt
 * @param {'all'|'terminal'|'mcp'} scope 生效范围
 * @returns {{preferHostId: string|null, scenario: string, requireConsent: boolean}|null}
 */
function validateMcpPrompt(raw, scope) {
  if (raw === null || raw === undefined) return null; // 不携带 / 显式清空
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid('mcpPrompt 必须为对象或 null');
  }
  // 终端模式：MCP 对该连接不可见，提示词无意义（明确拒绝而非静默丢弃，便于调用方纠错）
  if (scope === 'terminal') {
    throw invalid('终端范围（terminal）的会话连接不接受 mcpPrompt');
  }
  // 优先使用：默认（null）或同分组内另一条会话连接的 id（指向是否合法在路由层结合主机清单校验）
  const preferHostId = raw.preferHostId === undefined || raw.preferHostId === null ? null : raw.preferHostId;
  if (
    preferHostId !== null &&
    (typeof preferHostId !== 'string' || preferHostId.length === 0 || preferHostId.length > MCP_PROMPT_PREFER_ID_MAX)
  ) {
    throw invalid('mcpPrompt.preferHostId 必须为会话连接 id 或 null（默认）');
  }
  const scenario = raw.scenario === undefined || raw.scenario === null ? '' : raw.scenario;
  if (typeof scenario !== 'string' || scenario.length > MCP_PROMPT_SCENARIO_MAX) {
    throw invalid(`mcpPrompt.scenario 必须为不超过 ${MCP_PROMPT_SCENARIO_MAX} 字符的字符串`);
  }
  if (raw.requireConsent !== undefined && raw.requireConsent !== null && typeof raw.requireConsent !== 'boolean') {
    throw invalid('mcpPrompt.requireConsent 必须为布尔值');
  }
  // 「需 Agent 经用户同意后执行」默认关闭：显式 true 才开启
  return { preferHostId, scenario, requireConsent: raw.requireConsent === true };
}

/** 高级页允许的终端类型（TERM 变量）：白名单防任意注入 */
const SESSION_TERM_TYPES = ['xterm-256color', 'xterm', 'xterm-color', 'vt220', 'vt100', 'linux'];

/** 连接级会话参数（「高级」页）：仅对该连接生效，覆盖全局默认。
 *  整体替换语义：出现即全量校验，未携带字段归 null（= 跟随全局）。全空归 null。 */
function validateSessionConfig(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid('session 必须为对象或 null');
  }
  const out = {
    idleTimeoutMs: null,
    connectTimeoutMs: null,
    startDirectory: null,
    detachedTtlMs: null,
    termType: null,
    autoReconnect: null,
    env: null,
    auditOutput: null,
    blockedCommands: null,
  };
  // 空闲断开：null = 跟随全局；0 = 永不断开；否则 1 分钟 – 24 小时
  if (raw.idleTimeoutMs !== undefined && raw.idleTimeoutMs !== null) {
    const v = raw.idleTimeoutMs;
    if (!Number.isInteger(v) || (v !== 0 && (v < 60000 || v > 86400000))) {
      throw invalid('session.idleTimeoutMs 必须为 0（永不断开）或 60000–86400000 毫秒');
    }
    out.idleTimeoutMs = v;
  }
  // 连接超时：null = 跟随全局；3 秒 – 120 秒
  if (raw.connectTimeoutMs !== undefined && raw.connectTimeoutMs !== null) {
    const v = raw.connectTimeoutMs;
    if (!Number.isInteger(v) || v < 3000 || v > 120000) {
      throw invalid('session.connectTimeoutMs 必须为 3000–120000 毫秒');
    }
    out.connectTimeoutMs = v;
  }
  // 启动目录：登录成功后自动 cd（在脚本之前执行）；空白 = 未设置
  if (raw.startDirectory !== undefined && raw.startDirectory !== null) {
    const v = String(raw.startDirectory).trim();
    if (v) {
      if (v.length > 200 || /[\r\n\0]/.test(v)) {
        throw invalid('session.startDirectory 必须为 1–200 字符的合法路径（不含换行）');
      }
      out.startDirectory = v;
    }
  }
  // 会话保活：断开后服务端 detach 保留期；1 分钟 – 4 小时
  if (raw.detachedTtlMs !== undefined && raw.detachedTtlMs !== null) {
    const v = raw.detachedTtlMs;
    if (!Number.isInteger(v) || v < 60000 || v > 14400000) {
      throw invalid('session.detachedTtlMs 必须为 60000–14400000 毫秒');
    }
    out.detachedTtlMs = v;
  }
  // 终端类型（TERM 变量）：白名单
  if (raw.termType !== undefined && raw.termType !== null && raw.termType !== '') {
    if (!SESSION_TERM_TYPES.includes(raw.termType)) {
      throw invalid(`session.termType 必须为以下之一：${SESSION_TERM_TYPES.join(' / ')}`);
    }
    out.termType = raw.termType;
  }
  // 断线自动重连：布尔
  if (raw.autoReconnect !== undefined && raw.autoReconnect !== null) {
    if (typeof raw.autoReconnect !== 'boolean') {
      throw invalid('session.autoReconnect 必须为布尔值');
    }
    out.autoReconnect = raw.autoReconnect;
  }
  // 环境变量：KEY=VALUE 每行一条（≤ 20 行，单行 ≤ 200 字符），登录后 export 注入
  if (raw.env !== undefined && raw.env !== null && raw.env !== '') {
    const lines = String(raw.env)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length > 20) {
      throw invalid('session.env 最多 20 行（每行一条 KEY=VALUE）');
    }
    for (const line of lines) {
      if (line.length > 200 || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) {
        throw invalid('session.env 每行必须为 KEY=VALUE（键为字母数字下划线，≤200 字符）');
      }
    }
    if (lines.length) out.env = lines.join('\n');
  }
  // 审计输出摘要：'on'/'off' 覆盖全局，null = 跟随全局
  if (raw.auditOutput !== undefined && raw.auditOutput !== null) {
    if (raw.auditOutput !== 'on' && raw.auditOutput !== 'off') {
      throw invalid("session.auditOutput 必须为 'on' 或 'off'");
    }
    out.auditOutput = raw.auditOutput;
  }
  // 命令黑名单：MCP 与快捷命令执行拒绝匹配的命令（首个命令词匹配，≤ 50 条）
  if (raw.blockedCommands !== undefined && raw.blockedCommands !== null) {
    const list = Array.isArray(raw.blockedCommands)
      ? raw.blockedCommands.map((s) => String(s).trim())
      : String(raw.blockedCommands)
          .split('\n')
          .map((l) => l.trim());
    const cleaned = list.filter(Boolean);
    if (cleaned.length > 50) {
      throw invalid('session.blockedCommands 最多 50 条');
    }
    for (const item of cleaned) {
      if (item.length > 100 || /[\r\n\0]/.test(item) || /\s/.test(item)) {
        throw invalid('session.blockedCommands 每条必须为单个命令词（≤100 字符，不含空格）');
      }
    }
    if (cleaned.length) out.blockedCommands = cleaned;
  }
  const hasAny = Object.values(out).some((v) => v !== null);
  return hasAny ? out : null;
}

/**
 * 校验「优先使用」指向：必须是同一分组内、对 MCP 可见的其他会话连接，且不得形成循环。
 * 顺序语义：被指向的连接排在前面，本连接顺延一位（默认 1 → 指定后为 2；前面已是 2 则为 3）。
 * @param {{preferHostId?: string|null, selfId?: string|null, group?: string|null, hosts: Array<object>}} args
 * @returns {string|null} 合法返回 null；否则返回可直接作为 422 文案的错误说明
 */
export function validateMcpPrefer({ preferHostId, selfId = null, group = null, hosts = [] }) {
  if (!preferHostId) return null;
  if (selfId && preferHostId === selfId) {
    return 'mcpPrompt.preferHostId 不能指向当前会话连接自身';
  }
  const byId = new Map(hosts.map((h) => [h.id, h]));
  const target = byId.get(preferHostId);
  if (!target) {
    return `mcpPrompt.preferHostId 指向的会话连接不存在或无权访问: ${preferHostId}`;
  }
  if (normalizeScope(target.scope) === 'terminal') {
    return `mcpPrompt.preferHostId 指向的会话连接对 MCP 不可见（终端范围）: ${preferHostId}`;
  }
  if (normalizeDefaultGroup(target.group) !== normalizeDefaultGroup(group)) {
    return `mcpPrompt.preferHostId 必须指向同一分组内的会话连接: ${preferHostId}`;
  }
  // 循环依赖会让顺序无限递增：沿链走一遍，回到自身即拒绝
  let cursor = target.mcpPrompt?.preferHostId ?? null;
  for (let hop = 0; cursor && hop <= hosts.length; hop += 1) {
    if (selfId && cursor === selfId) {
      return 'mcpPrompt.preferHostId 形成循环依赖（优先使用链回到了当前会话连接）';
    }
    const next = byId.get(cursor);
    if (!next) break;
    cursor = next.mcpPrompt?.preferHostId ?? null;
  }
  return null;
}

/**
 * 计算各会话连接在 MCP 中的使用顺序：
 * 默认（未指定优先使用）为 1；指定了优先目标则本连接 = 目标顺序 + 1
 * （目标本身已是 2 时，本连接为 3，以此类推）。悬空引用与环按默认 1 截断，保证有界。
 * @param {Array<object>} hosts 同一使用者名下的全部会话连接
 * @returns {Map<string, number>} id → 顺序
 */
export function computeMcpOrders(hosts) {
  const list = Array.isArray(hosts) ? hosts : [];
  const byId = new Map(list.map((h) => [h.id, h]));
  const orders = new Map();
  const onPath = new Set();
  const resolve = (id) => {
    if (orders.has(id)) return orders.get(id);
    if (onPath.has(id)) return MCP_ORDER_BASE; // 环：截断，避免顺序无限递增
    onPath.add(id);
    const h = byId.get(id);
    const pid = h && normalizeScope(h.scope) !== 'terminal' ? h.mcpPrompt?.preferHostId ?? null : null;
    // 目标必须存在且对 MCP 可见（终端范围的连接不在 MCP 视野内，不能排在它后面）
    const target = pid ? byId.get(pid) : null;
    const n = target && pid !== id && normalizeScope(target.scope) !== 'terminal' ? resolve(pid) + 1 : MCP_ORDER_BASE;
    onPath.delete(id);
    orders.set(id, n);
    return n;
  };
  for (const id of byId.keys()) resolve(id);
  return orders;
}

/** 登录后自动执行脚本的取值约束：条数与单条长度都设上限（防滥用与载荷膨胀） */
const SCRIPTS_MAX_COUNT = 20;
const SCRIPT_MAX_LEN = 500;
const SCRIPT_DELAY_MAX_SEC = 60;

/** 校验登录后自动执行脚本：数组（可为空数组 = 清空）。
 *  每条支持两种形态：字符串（无延迟）或 {command, delaySec}（执行本条前等待的秒数，0–60）。
 *  规范化输出统一为 {command, delaySec}。 */
function validateScripts(raw) {
  if (raw === null || raw === undefined) return []; // 不携带 → 空
  if (!Array.isArray(raw)) {
    throw invalid('scripts 必须为数组或 null');
  }
  if (raw.length > SCRIPTS_MAX_COUNT) {
    throw invalid(`scripts 最多 ${SCRIPTS_MAX_COUNT} 条`);
  }
  return raw.map((item) => {
    // 字符串形态（简写）：延迟 0
    if (typeof item === 'string') item = { command: item };
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw invalid('scripts 每条必须为字符串或 {command, delaySec} 对象');
    }
    const cmd = typeof item.command === 'string' ? item.command.trim() : '';
    if (!cmd) {
      throw invalid('scripts 每条必须为非空命令');
    }
    if (cmd.length > SCRIPT_MAX_LEN) {
      throw invalid(`scripts 单条不超过 ${SCRIPT_MAX_LEN} 字符`);
    }
    if (/[\r\n]/.test(cmd)) {
      throw invalid('scripts 单条不得包含换行（一条命令一行）');
    }
    const delaySec = item.delaySec ?? 0;
    if (!Number.isInteger(delaySec) || delaySec < 0 || delaySec > SCRIPT_DELAY_MAX_SEC) {
      throw invalid(`scripts 每条 delaySec 必须为 0–${SCRIPT_DELAY_MAX_SEC} 的整数（秒）`);
    }
    return { command: cmd, delaySec };
  });
}

/**
 * 校验主机创建/更新载荷。
 * @param {object} body 请求体
 * @param {{partial?: boolean, current?: object|null}} [opts]
 *   partial=true 时字段可选（PUT），出现即校验；
 *   current 为待更新的既有记录（PUT 时用于推导未提交的 scope，避免提示词与范围判定脱节）
 * @returns {{value: object}} 规范化后的载荷（仅白名单字段）
 * @throws message 指明非法字段名（供 422 响应与测试断言）
 */
export function validateHostPayload(body, { partial = false, current = null, twofaEnabled = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalid('请求体必须为 JSON 对象');
  }
  const value = {};

  if (body.name !== undefined || !partial) {
    const name = body.name;
    if (typeof name !== 'string' || name.length < 1 || name.length > 64) {
      throw invalid('name 必须为 1–64 字符的字符串');
    }
    value.name = name;
  }
  if (body.host !== undefined || !partial) {
    if (typeof body.host !== 'string' || !HOSTNAME_RE.test(body.host)) {
      throw invalid('host 非法（仅允许域名或 IP 字面量，禁止分隔符与空白）');
    }
    value.host = body.host;
  }
  if (body.port !== undefined) {
    const port = body.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw invalid('port 必须为 1–65535 的整数');
    }
    value.port = port;
  } else if (!partial) {
    value.port = 22;
  }
  if (body.username !== undefined || !partial) {
    if (typeof body.username !== 'string' || body.username === '') {
      throw invalid('username 必须为非空字符串');
    }
    value.username = body.username;
  }
  if (body.authType !== undefined || !partial) {
    if (body.authType !== 'password' && body.authType !== 'privateKey' && body.authType !== 'none') {
      throw invalid('authType 必须为 password、privateKey 或 none');
    }
    value.authType = body.authType;
  }
  // 连接方式：direct（直连，默认）/ jump（跳板机）；隧道与代理为后续能力
  if (body.connectVia !== undefined) {
    if (body.connectVia !== 'direct' && body.connectVia !== 'jump') {
      throw invalid('connectVia 必须为 direct 或 jump');
    }
    value.connectVia = body.connectVia;
    if (body.connectVia === 'jump') {
      if (typeof body.jumpHostId !== 'string' || body.jumpHostId === '') {
        throw invalid('jumpHostId 必须为非空字符串（跳板机主机 ID）');
      }
      value.jumpHostId = body.jumpHostId;
    }
  }
  if (body.group !== undefined) {
    if (body.group !== null && typeof body.group !== 'string') {
      throw invalid('group 必须为字符串或 null');
    }
    if (body.group === '默认' || body.group === 'default') {
      throw invalid('「default/默认」为内置分组 Default 的历史别名，请直接使用 Default');
    }
    // null 与历史别名归一化为内置 Default 分组
    value.group = body.group == null || body.group === '默认' || body.group === 'default' ? 'Default' : body.group;
  }
  // 授权范围：未提交时沿用既有值（PUT），创建时回落 all（全选，默认）
  const effectiveScope =
    body.scope !== undefined && body.scope !== null ? body.scope : normalizeScope(current?.scope);
  if (body.scope !== undefined || !partial) {
    if (!HOST_SCOPES.includes(effectiveScope)) {
      throw invalid('scope 必须为 all（全选）、terminal（终端）或 mcp（MCP）');
    }
    value.scope = effectiveScope;
  }
  // MCP 终端提示词：仅 MCP 可见的连接可携带；切到 terminal 时一并清空
  if (body.mcpPrompt !== undefined) {
    value.mcpPrompt = validateMcpPrompt(body.mcpPrompt, effectiveScope);
  } else if (value.scope === 'terminal') {
    value.mcpPrompt = null;
  }
  // 登录后自动执行脚本：出现即校验并规范化（trim + 去空条目上限）
  if (body.scripts !== undefined) {
    value.scripts = validateScripts(body.scripts);
  }
  // 主机级二次认证开关：布尔值；开启前提是全局 2FA验证 已绑定
  if (body.requireTwofa !== undefined) {
    if (typeof body.requireTwofa !== 'boolean') {
      throw invalid('requireTwofa 必须为布尔值');
    }
    if (body.requireTwofa === true && twofaEnabled !== true) {
      throw invalid('开启连接二次认证前，需先在「设置 → 2FA验证」中完成绑定');
    }
    value.requireTwofa = body.requireTwofa;
  }
  // 连接级会话参数（高级页）：整体替换，null = 清空（全部跟随全局）
  if (body.session !== undefined) {
    value.session = validateSessionConfig(body.session);
  }

  // 凭据：出现即校验形态
  const hasPw = body.password !== undefined && body.password !== null;
  const hasKey = body.privateKey !== undefined && body.privateKey !== null;
  if (hasPw || hasKey) {
    if (hasPw && (typeof body.password !== 'string' || body.password === '')) {
      throw invalid('password 必须为非空字符串');
    }
    if (hasKey && typeof body.privateKey !== 'string') {
      throw invalid('privateKey 必须为字符串（PEM）');
    }
    if (body.passphrase !== undefined && body.passphrase !== null && typeof body.passphrase !== 'string') {
      throw invalid('passphrase 必须为字符串');
    }
    if (value.authType === 'none') {
      throw invalid('authType 为 none（不记录凭据）时不接受 password/privateKey');
    }
    value.secret = hasKey
      ? { privateKey: body.privateKey, passphrase: body.passphrase ?? undefined }
      : { password: body.password };
  }
  // 创建（非 partial）：凭据形态必须与 authType 匹配
  if (!partial) {
    if (value.authType === 'password' && value.secret?.password === undefined) {
      throw invalid('password 认证必须提供 password');
    }
    if (value.authType === 'privateKey' && value.secret?.privateKey === undefined) {
      throw invalid('privateKey 认证必须提供 privateKey');
    }
  }

  return { value };
}

/**
 * 主机条目 → 公开视图（凭据绝不外泄，FR-005）
 * @param {number} [mcpOrder] MCP 使用顺序（由 computeMcpOrders 计算，默认 1）
 */
function publicView(h, mcpOrder = MCP_ORDER_BASE) {
  const scope = normalizeScope(h.scope);
  return {
    id: h.id,
    name: h.name,
    host: h.host,
    port: h.port,
    username: h.username,
    authType: h.authType,
    group: h.group ?? null,
    connectVia: h.connectVia ?? 'direct',
    jumpHostId: h.jumpHostId ?? null,
    fingerprintConfirmed: Boolean(h.fingerprint),
    pendingFingerprint: h.pendingFingerprint ?? null,
    hasSecret: Boolean(h.secret),
    lastUsedAt: h.lastUsedAt ?? null,
    // 授权范围（全选/终端/MCP）+ MCP 终端提示词：终端模式下恒为 null（对 MCP 不可见）
    scope,
    // MCP 使用顺序（默认 1；指定「优先使用」后顺延为被指向连接的顺序 + 1）
    mcpOrder,
    mcpPrompt:
      scope === 'terminal'
        ? null
        : {
            // 优先使用：默认 null；否则为同分组内另一条会话连接的 id
            preferHostId: h.mcpPrompt?.preferHostId ?? null,
            scenario: h.mcpPrompt?.scenario ?? '',
            // 「需经用户同意」默认关闭（仅显式开启即为 true）
            requireConsent: h.mcpPrompt?.requireConsent === true,
          },
    // 最近连接时间（空态「快速连接」按此排序；未连接过为 null）
    lastConnectedAt: h.lastConnectedAt ?? null,
    // 主机级二次认证：开启后终端/MCP 首次使用需 2FA 验证；twofaVerified = 已完成（永久生效）
    requireTwofa: h.requireTwofa === true,
    twofaVerified: h.twofaVerified === true,
    // 连接级会话参数（高级页）：null = 全部跟随全局
    session:
      h.session && typeof h.session === 'object'
        ? {
            idleTimeoutMs: h.session.idleTimeoutMs ?? null,
            connectTimeoutMs: h.session.connectTimeoutMs ?? null,
            startDirectory: h.session.startDirectory ?? null,
            detachedTtlMs: h.session.detachedTtlMs ?? null,
            termType: h.session.termType ?? null,
            autoReconnect: h.session.autoReconnect ?? null,
            env: h.session.env ?? null,
            auditOutput: h.session.auditOutput ?? null,
            blockedCommands: Array.isArray(h.session.blockedCommands) ? h.session.blockedCommands : null,
          }
        : null,
    // 登录后自动执行脚本（历史记录无该字段时为空数组；字符串条目归一为延迟 0 的对象）
    scripts: Array.isArray(h.scripts)
      ? h.scripts.map((s) =>
          typeof s === 'string' ? { command: s, delaySec: 0 } : { command: s.command, delaySec: s.delaySec ?? 0 }
        )
      : [],
  };
}

/** 一批主机 → 公开视图（顺序按整份清单计算，前缀链可能跨条目） */
function publicViews(hosts) {
  const orders = computeMcpOrders(hosts);
  return hosts.map((h) => publicView(h, orders.get(h.id) ?? MCP_ORDER_BASE));
}

/** 单条主机的公开视图（顺序需结合全量清单计算，故重新列出） */
async function viewWithOrder(store, ownerId, host) {
  const orders = computeMcpOrders(await store.listHosts(ownerId));
  return publicView(host, orders.get(host.id) ?? MCP_ORDER_BASE);
}

/**
 * 清理指向某条会话连接的「优先使用」引用：该连接被删除，或被移出分组导致不同组时，
 * 其余连接的 preferHostId 会失效 → 置回默认（顺序回到 1）。
 * @param {object} store
 * @param {string} ownerId
 * @param {string} targetId 被指向的连接
 * @param {{requireSameGroup?: boolean}} [opts] requireSameGroup=true 时仅清理分组已不同的引用
 */
async function repairPreferRefs(store, ownerId, targetId, { requireSameGroup = false } = {}) {
  const hosts = await store.listHosts(ownerId);
  const target = hosts.find((h) => h.id === targetId);
  for (const h of hosts) {
    if (h.mcpPrompt?.preferHostId !== targetId) continue;
    const broken = !target
      ? true
      : requireSameGroup && normalizeDefaultGroup(target.group) !== normalizeDefaultGroup(h.group);
    if (!broken) continue;
    await store.upsertHost({ ...h, mcpPrompt: { ...h.mcpPrompt, preferHostId: null } });
  }
}

/**
 * @param {{runtime: object, store: object, masterKey: Buffer}} deps
 */
export function hostsRoutes(deps) {
  const { runtime, store, masterKey, audit, config } = deps;

  /** 越权返回 403 且不暴露资源存在性；不存在返回 404 */
  async function requireHost(id, ownerId) {
    const host = await store.getHost(id, ownerId);
    if (host) return { host };
    const exists = await store.getHostById(id);
    return { host: null, forbidden: Boolean(exists) };
  }

  /** 跳板机合法性：存在且归属本人、非自引用、非多级跳板、有已存凭据（none 无法自动认证） */
  async function validateJump(value, identity, selfId) {
    if (value.connectVia !== 'jump') return null;
    if (selfId && value.jumpHostId === selfId) return '跳板机不能是主机自身';
    const jump = await store.getHost(value.jumpHostId, identity.id);
    if (!jump) return '跳板机不存在或无权访问';
    if (jump.connectVia === 'jump') return '不支持多级跳板（跳板机本身须为直连）';
    if (!jump.secret) return '跳板机未保存凭据（「无」认证的主机不能作为跳板）';
    return null;
  }

  return [
    {
      method: 'GET',
      path: '/api/hosts',
      handler: async (req, res) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        const hosts = await store.listHosts(identity.id);
        sendJson(res, 200, publicViews(hosts));
      },
    },
    {
      method: 'POST',
      path: '/api/hosts',
      handler: async (req, res) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        let body;
        try {
          body = await readJsonBody(req);
        } catch (e) {
          return sendError(res, 422, 'invalid_json', e.message);
        }
        let value;
        try {
          ({ value } = validateHostPayload(body, { partial: false, twofaEnabled: config?.twofa?.enabled === true }));
        } catch (e) {
          return sendError(res, 422, e.code ?? 'invalid_field', e.message);
        }
        // 「仅 MCP」范围：网页终端入口将关闭，创建这类连接同步纳入 2FA 保护（与编辑一致）
        if (value.scope === 'mcp' && require2fa(deps, req, res, 'hosts')) return;
        // 优先使用：必须指向同分组内、对 MCP 可见的其他连接，且不形成循环
        const preferErr = validateMcpPrefer({
          preferHostId: value.mcpPrompt?.preferHostId ?? null,
          selfId: null,
          group: value.group ?? 'Default',
          hosts: await store.listHosts(identity.id),
        });
        if (preferErr) return sendError(res, 422, 'invalid_field', preferErr);
        const jumpErr = await validateJump(value, identity, null);
        if (jumpErr) return sendError(res, 422, 'invalid_jump', jumpErr);
        const now = new Date().toISOString();
        const entry = {
          id: await nextHostId(store, value.name), // 设备 ID = 会话名称
          name: value.name,
          host: value.host,
          port: value.port,
          username: value.username,
          authType: value.authType,
          connectVia: value.connectVia ?? 'direct',
          jumpHostId: value.connectVia === 'jump' ? value.jumpHostId : null,
          // none（不记录凭据）：不存 secret，连接时手动输入
          secret: value.secret ? encryptSecret(masterKey, value.secret) : null,
          group: value.group ?? 'Default',
          // 授权范围（全选/终端/MCP）+ MCP 终端提示词
          scope: value.scope ?? 'all',
          mcpPrompt: value.mcpPrompt ?? null,
          // 登录后自动执行脚本（不携带 = 空）
          scripts: value.scripts ?? [],
          // 主机级二次认证：开启后终端/MCP 首次使用需 2FA 验证（一次验证永久生效）
          requireTwofa: value.requireTwofa === true,
          twofaVerified: false,
          // 连接级会话参数（高级页：空闲断开/连接超时/启动目录；不携带 = 跟随全局）
          session: value.session ?? null,
          ownerId: identity.id,
          fingerprint: null,
          pendingFingerprint: null,
          fingerprintConfirmedAt: null,
          createdAt: now,
          updatedAt: now,
          lastUsedAt: null,
        };
        await store.upsertHost(entry);
        // 审计留痕：新建会话连接（主机记录）保存（FR-012 操作审计，与分组管理 group_* 同面）
        audit?.log({
          actor: identity.id,
          actorType: 'user',
          hostId: entry.id,
          hostAddress: `${entry.host}:${entry.port}`,
          authType: entry.authType,
          event: 'host_create',
          result: 'success',
        });
        sendJson(res, 201, await viewWithOrder(store, identity.id, entry));
      },
    },
    {
      method: 'GET',
      path: '/api/hosts/{id}',
      handler: async (req, res, ctx) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        const id = ctx.params.id;
        const { host, forbidden } = await requireHost(id, identity.id);
        if (forbidden) return sendError(res, 403, 'forbidden', '无权访问该资源');
        if (!host) return sendError(res, 404, 'not_found', '主机不存在');
        sendJson(res, 200, await viewWithOrder(store, identity.id, host));
      },
    },
    {
      method: 'PUT',
      path: '/api/hosts/{id}',
      handler: async (req, res, ctx) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        const id = ctx.params.id;
        const { host, forbidden } = await requireHost(id, identity.id);
        if (forbidden) return sendError(res, 403, 'forbidden', '无权访问该资源');
        if (!host) return sendError(res, 404, 'not_found', '主机不存在');

        let body;
        try {
          body = await readJsonBody(req);
        } catch (e) {
          return sendError(res, 422, 'invalid_json', e.message);
        }
        let value;
        try {
          ({ value } = validateHostPayload(body, { partial: true, current: host, twofaEnabled: config?.twofa?.enabled === true }));
        } catch (e) {
          return sendError(res, 422, e.code ?? 'invalid_field', e.message);
        }
        // 「仅 MCP」授权范围：网页终端入口已关闭，编辑是唯一入口 → 需 2FA 二次验证。
        // 判定用生效范围（既有值或本次提交值），避免把范围改成 mcp 绕过验证。
        const effectiveScope = value.scope ?? normalizeScope(host.scope);
        if (effectiveScope === 'mcp' && require2fa(deps, req, res, 'hosts')) return;

        // 优先使用：目标须为同分组内、对 MCP 可见的其他连接，且不形成循环
        const effectiveGroup = value.group !== undefined ? value.group : host.group ?? 'Default';
        const preferHostId =
          value.mcpPrompt !== undefined
            ? value.mcpPrompt?.preferHostId ?? null
            : host.mcpPrompt?.preferHostId ?? null;
        const allHosts = await store.listHosts(identity.id);
        const preferErr = validateMcpPrefer({
          preferHostId,
          selfId: id,
          group: effectiveGroup,
          hosts: allHosts,
        });
        if (preferErr) return sendError(res, 422, 'invalid_field', preferErr);

        // 更换认证方式必须同时提供新凭据（切到 none 除外：none 的本意就是清空凭据）
        if (value.authType && value.authType !== host.authType && value.authType !== 'none' && !value.secret) {
          return sendError(res, 422, 'credential_required', '更换认证方式必须同时提供新凭据');
        }
        const jumpErr = await validateJump(value, identity, id);
        if (jumpErr) return sendError(res, 422, 'invalid_jump', jumpErr);

        const addressChanged =
          (value.host !== undefined && value.host !== host.host) ||
          (value.port !== undefined && value.port !== host.port);

        const updated = {
          ...host,
          ...('name' in value && value.name !== undefined ? { name: value.name } : {}),
          ...('host' in value && value.host !== undefined ? { host: value.host } : {}),
          ...('port' in value && value.port !== undefined ? { port: value.port } : {}),
          ...('username' in value && value.username !== undefined ? { username: value.username } : {}),
          ...('authType' in value && value.authType !== undefined ? { authType: value.authType } : {}),
          ...('group' in value ? { group: value.group } : {}),
          // 授权范围与 MCP 终端提示词（切到 terminal 时 validate 已把提示词置空）
          ...(value.scope !== undefined ? { scope: value.scope } : {}),
          ...(value.mcpPrompt !== undefined ? { mcpPrompt: value.mcpPrompt } : {}),
          // 登录后自动执行脚本：提交即整体替换（空数组 = 清空）
          ...(value.scripts !== undefined ? { scripts: value.scripts } : {}),
          // 主机级二次认证：状态翻转（开→关 / 关→开）时重置验证状态；
          // 开着不变（仅编辑其他字段）保持已验证，避免反复弹码
          ...(value.requireTwofa !== undefined
            ? {
                requireTwofa: value.requireTwofa,
                ...(value.requireTwofa !== (host.requireTwofa === true) ? { twofaVerified: false } : {}),
              }
            : {}),
          // 连接级会话参数：整体替换（null = 清空，全部跟随全局）
          ...(value.session !== undefined ? { session: value.session } : {}),
          ...(value.connectVia !== undefined ? { connectVia: value.connectVia } : {}),
          // 直连时清空跳板引用；未提交 connectVia 时保持原值
          ...(value.connectVia === 'jump'
            ? { jumpHostId: value.jumpHostId }
            : value.connectVia === 'direct'
              ? { jumpHostId: null }
              : {}),
          ...(value.secret ? { secret: encryptSecret(masterKey, value.secret) } : {}),
          // 切到 none：清空已保存凭据（不记录密码/密钥）
          ...(value.authType === 'none' ? { secret: null } : {}),
          updatedAt: new Date().toISOString(),
        };
        // 目标地址变化 → 主机身份改变，指纹必须重新确认（防新地址沿用旧指纹）
        if (addressChanged) {
          updated.fingerprint = null;
          updated.pendingFingerprint = null;
          updated.fingerprintConfirmedAt = null;
        }
        await store.upsertHost(updated);
        // 分组变更：其他连接若仍「优先使用」本连接可能已不同组 → 失效引用置回默认
        const groupChanged = value.group !== undefined && normalizeDefaultGroup(value.group) !== normalizeDefaultGroup(host.group);
        if (groupChanged) await repairPreferRefs(store, identity.id, id, { requireSameGroup: true });
        const scopeChanged = value.scope !== undefined && value.scope !== normalizeScope(host.scope);
        audit?.log({
          actor: identity.id,
          actorType: 'user',
          hostId: id,
          hostAddress: `${updated.host}:${updated.port}`,
          authType: updated.authType,
          event: 'host_update',
          result: 'success',
          // 授权范围变更是高权限动作：审计里显式留痕原值与新值
          reason: scopeChanged ? `授权范围 ${normalizeScope(host.scope)} → ${value.scope}` : undefined,
        });
        sendJson(res, 200, await viewWithOrder(store, identity.id, updated));
      },
    },
    {
      method: 'DELETE',
      path: '/api/hosts/{id}',
      handler: async (req, res, ctx) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        const id = ctx.params.id;
        const { host, forbidden } = await requireHost(id, identity.id);
        if (forbidden) return sendError(res, 403, 'forbidden', '无权访问该资源');
        if (!host) return sendError(res, 404, 'not_found', '主机不存在');
        await store.deleteHost(id, identity.id);
        // 删除后指向本连接的「优先使用」全部失效 → 置回默认（顺序回到 1）
        await repairPreferRefs(store, identity.id, id);
        audit?.log({
          actor: identity.id,
          actorType: 'user',
          hostId: id,
          hostAddress: `${host.host}:${host.port}`,
          authType: host.authType,
          event: 'host_delete',
          result: 'success',
        });
        sendJson(res, 200, { ok: true });
      },
    },
    {
      method: 'POST',
      path: '/api/hosts/{id}/duplicate',
      handler: async (req, res, ctx) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        const id = ctx.params.id;
        const { host, forbidden } = await requireHost(id, identity.id);
        if (forbidden) return sendError(res, 403, 'forbidden', '无权访问该资源');
        if (!host) return sendError(res, 404, 'not_found', '主机不存在');

        const now = new Date().toISOString();
        // FR-056：加密凭据密文原样复制（无需解密），副本为完全独立条目
        const copy = {
          ...host,
          id: await nextHostId(store, `${host.name} 副本`),
          name: `${host.name} 副本`,
          createdAt: now,
          updatedAt: now,
          lastUsedAt: null,
        };
        // 副本不继承「优先使用」（否则两条连接互指/重复占用同一顺序位）
        if (copy.mcpPrompt) copy.mcpPrompt = { ...copy.mcpPrompt, preferHostId: null };
        await store.upsertHost(copy);
        // 审计留痕：复制会话（FR-056 duplicate），reason 溯源原主机 ID
        audit?.log({
          actor: identity.id,
          actorType: 'user',
          hostId: copy.id,
          hostAddress: `${copy.host}:${copy.port}`,
          authType: copy.authType,
          event: 'host_duplicate',
          result: 'success',
          reason: `源:${host.id}`,
        });
        sendJson(res, 200, await viewWithOrder(store, identity.id, copy));
      },
    },
    {
      // 连接时临时输入的私钥口令 → 换一次性 WS 票据（口令不经 URL）；
      // remember=true 时把口令并入加密凭据持久保存（AES-256-GCM，与私钥同级保护）
      method: 'POST',
      path: '/api/hosts/{id}/connect-secret',
      handler: async (req, res, ctx) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        const id = ctx.params.id;
        const { host, forbidden } = await requireHost(id, identity.id);
        if (forbidden) return sendError(res, 403, 'forbidden', '无权访问该资源');
        if (!host) return sendError(res, 404, 'not_found', '主机不存在');
        if (host.authType === 'password') {
          return sendError(res, 422, 'not_supported', '该主机已保存密码，无需连接凭据票据');
        }
        let body;
        try {
          body = await readJsonBody(req);
        } catch (e) {
          return sendError(res, 422, 'invalid_json', e.message);
        }
        // privateKey → 私钥口令；none（不记录凭据）→ 本次连接的密码
        const isNone = host.authType === 'none';
        const passphrase = isNone ? undefined : body?.passphrase;
        const password = isNone ? body?.password : undefined;
        if (!isNone && (typeof passphrase !== 'string' || passphrase === '')) {
          return sendError(res, 422, 'invalid_field', 'passphrase 必须为非空字符串');
        }
        if (isNone && (typeof password !== 'string' || password === '')) {
          return sendError(res, 422, 'invalid_field', 'password 必须为非空字符串');
        }
        if (isNone && body?.remember === true) {
          return sendError(res, 422, 'not_supported', '不记录凭据的主机不支持记住密码');
        }
        if (body?.remember === true) {
          const secret = decryptSecret(masterKey, host.secret);
          secret.passphrase = passphrase;
          await store.touchHost(id, {
            secret: encryptSecret(masterKey, secret),
            updatedAt: new Date().toISOString(),
          });
          audit?.log({
            actor: identity.id,
            actorType: 'user',
            hostId: id,
            hostAddress: host.host,
            authType: host.authType,
            event: 'credential-update',
            result: 'success',
            reason: '记住私钥口令',
          });
        }
        const ticket = createPassTicket({ hostId: id, ownerId: identity.id, passphrase, password });
        sendJson(res, 200, { ticket });
      },
    },
    {
      method: 'POST',
      path: '/api/hosts/{id}/verify-hostkey',
      handler: async (req, res, ctx) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        const id = ctx.params.id;
        const { host, forbidden } = await requireHost(id, identity.id);
        if (forbidden) return sendError(res, 403, 'forbidden', '无权访问该资源');
        if (!host) return sendError(res, 404, 'not_found', '主机不存在');

        let body;
        try {
          body = await readJsonBody(req);
        } catch (e) {
          return sendError(res, 422, 'invalid_json', e.message);
        }
        const fingerprint = body?.fingerprint;
        if (typeof fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/=]+$/.test(fingerprint)) {
          return sendError(res, 422, 'invalid_fingerprint', 'fingerprint 必须为 SHA256:xxx 形式');
        }
        await store.touchHost(id, {
          fingerprint,
          fingerprintConfirmedAt: new Date().toISOString(),
          pendingFingerprint: null,
        });
        // 同步写入 known_hosts 供人工核对（R10）
        await appendKnownHost({
          paths: runtime.paths,
          host: host.host,
          port: host.port,
          algorithm: 'ssh-key',
          fingerprint,
        });
        sendJson(res, 200, { ok: true, fingerprint });
      },
    },
  ];
}

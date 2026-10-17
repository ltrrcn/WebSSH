// MCP 端点（FR-022~043 / mcp-tools.md 契约）：挂载在既有 HTTP 服务的 /mcp，不新开端口（宪法 III）
// 说明：按宪法 VI（YAGNI）直接实现 MCP 所需的 JSON-RPC 子集（initialize/tools/list/tools/call），
// 不引入 SDK 的会话传输层——服务端保持无状态，会话 ID 仅按 Streamable HTTP 规范在
// initialize 时生成并经 Mcp-Session-Id 响应头返回，由客户端后续请求回传后透传进审计。
import { randomUUID } from 'node:crypto';
import { checkPathAccess, checkCommand } from '../ssh/policy.js';
import { withSsh, execCommand } from '../ssh/exec.js';
import { redact, truncateDigest } from '../crypto/redact.js';
import { checkRateLimit } from './rate-limit.js';
import { normalizeDefaultGroup } from '../api/groups.js';
import { newMcpSessionId } from './session-registry.js';

const MAX_READ_BYTES = 1024 * 512; // read_file 单次上限 512KB

// 会话 ID 生成统一在 session-registry.js（粘性归组也需生成合成会话 ID）；此处 re-export 保持既有导入路径
export { newMcpSessionId };

/** 客户端回传的会话头格式校验：非法值一律视为无会话（防审计注入垃圾值） */
export function validMcpSessionId(v) {
  return typeof v === 'string' && /^m_[0-9a-f]{12}$/.test(v) ? v : null;
}

/** 工具注册矩阵（第一层判定：能力隔离，FR-031） */
export function toolDefinitions(level) {
  const tools = [
    {
      name: 'list_hosts',
      description: '列出令牌授权范围内的主机',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ];
  if (level === 'readonly' || level === 'writable') {
    tools.push({
      name: 'read_file',
      description: '读取授权主机上矩阵允许路径的文件内容（受目录权限矩阵限制）',
      inputSchema: {
        type: 'object',
        properties: {
          hostId: { type: 'string', description: '目标主机 ID' },
          path: { type: 'string', description: '绝对路径' },
        },
        required: ['hostId', 'path'],
        additionalProperties: false,
      },
    });
  }
  if (level === 'writable') {
    tools.push({
      name: 'run_command',
      description: '在授权主机上执行一条命令（拼接/重定向语法与危险命令将被拒绝）',
      inputSchema: {
        type: 'object',
        properties: {
          hostId: { type: 'string', description: '目标主机 ID' },
          command: { type: 'string', description: '命令原文' },
        },
        required: ['hostId', 'command'],
        additionalProperties: false,
      },
    });
    // write_file（上传/写入远端文件）已按需求禁用：不注册即不可调用（能力隔离，FR-031 同款设计）
  }
  return tools;
}

/**
 * 处理 /mcp 请求（已在路由层完成 Bearer 鉴权与限流预检）。
 * @param {{token: object, runtime: object, config: object, store: object, audit: object, masterKey: Buffer,
 *          clientSessionId?: string|null, onSessionCreated?: (sid: string) => void}} ctx
 *   clientSessionId：请求头 Mcp-Session-Id 中经校验的会话 ID（无/非法 → null）
 *   onSessionCreated：initialize 生成新会话 ID 后回调（调用方用于设置响应头）
 */
export async function handleMcpCall(body, ctx) {
  const { token, config, store, audit, masterKey } = ctx;
  const method = body?.method;

  if (method === 'initialize') {
    // Streamable HTTP 规范：会话 ID 经响应头返回，客户端后续请求自动携带；
    // 服务端不存储会话状态——每次 initialize 即一个新 AI Agent 会话。
    const sessionId = newMcpSessionId();
    ctx.onSessionCreated?.(sessionId);
    // 粘性归组：绑定该令牌的当前会话——客户端不回传会话头时，后续调用也归入此会话
    ctx.mcpSessions?.bind(token.id, sessionId);
    audit.log({
      actor: token.ownerId,
      actorType: 'token',
      tokenId: token.id,
      event: 'mcp-session-start',
      result: 'success',
      sessionId,
    });
    return {
      jsonrpc: '2.0',
      id: body.id ?? null,
      result: {
        protocolVersion: body.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'webssh', version: '0.1.0' },
      },
    };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id: body.id ?? null, result: { tools: toolDefinitions(token.level) } };
  }
  if (method === 'tools/call') {
    const name = body.params?.name;
    const args = body.params?.arguments ?? {};
    const allowed = toolDefinitions(token.level).some((t) => t.name === name);
    if (!allowed) {
      return rpcError(body.id, -32602, `工具不存在或令牌级别（${token.level}）无权调用: ${name}`);
    }
    // 归档会话：客户端回传了有效会话头则尊重；否则归入该令牌的当前活跃会话
    // （粘性归组，见 session-registry.js）——AI 客户端不透传 Mcp-Session-Id 时命令仍按会话归档
    const auditSid = ctx.mcpSessions
      ? ctx.mcpSessions.resolve(token.id, ctx.clientSessionId ?? null)
      : (ctx.clientSessionId ?? null);
    try {
      const result = await dispatchTool(name, args, ctx);
      auditToolCall(audit, token, name, args, result, 'success', null, auditSid);
      return {
        jsonrpc: '2.0',
        id: body.id ?? null,
        result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
      };
    } catch (err) {
      auditToolCall(audit, token, name, args, null, err.code === 'rate_limited' ? 'denied' : 'error', err.code ?? err.message, auditSid);
      return {
        jsonrpc: '2.0',
        id: body.id ?? null,
        result: {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: err.code ?? 'tool_error', message: String(err.message) }) }],
        },
      };
    }
  }
  // 未知方法（notifications 无 id 时上层已直接 202）
  return rpcError(body.id ?? null, -32601, `Method not found: ${method}`);
}

/** DELETE /mcp：客户端主动结束会话（Streamable HTTP 规范）→ 解除粘性并记 mcp-session-end */
export function handleMcpDelete(ctx) {
  const { token, audit } = ctx;
  ctx.mcpSessions?.end(token.id);
  audit.log({
    actor: token.ownerId,
    actorType: 'token',
    tokenId: token.id,
    event: 'mcp-session-end',
    result: 'success',
    sessionId: ctx.clientSessionId ?? null,
  });
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** 审计：每次工具调用一条 AuditEvent（FR-027/041/042）；sessionId 为客户端回传的 MCP 会话 ID */
function auditToolCall(audit, token, name, args, result, resultStatus, reason, sessionId) {
  audit.log({
    actor: token.ownerId,
    actorType: 'token',
    tokenId: token.id,
    hostId: args?.hostId ?? null,
    event: name === 'run_command' ? 'command' : name === 'read_file' ? 'file-read' : 'command',
    result: resultStatus,
    reason,
    sessionId,
    command: name === 'run_command' ? args?.command : undefined,
    outputDigest: result?.stdoutDigest ?? null,
    path: args?.path ?? null,
  });
}
let ctxDigestBytes = 2048;
export function setDigestBytes(n) {
  ctxDigestBytes = n;
}

async function dispatchTool(name, args, ctx) {
  const { token, config, store, masterKey } = ctx;
  setDigestBytes(config.limits.outputDigestBytes ?? 2048);

  // 授权范围判定：allHosts（全部，含后续新增）或固定 hostScope 或按分组（分组下新增主机自动附带权限）
  // 分组匹配用归一化语义：主机的 Default/default/默认/null 与令牌的 Default 视为同一内置分组
  const inScope = (h) =>
    token.allHosts === true ||
    token.hostScope.includes(h.id) ||
    (Array.isArray(token.hostGroups) &&
      token.hostGroups.some((n) => normalizeDefaultGroup(n) === normalizeDefaultGroup(h.group)));

  if (name === 'list_hosts') {
    const hosts = (await store.listHosts(token.ownerId)).filter(inScope);
    return {
      hosts: hosts.map((h) => ({ id: h.id, name: h.name, host: h.host, port: h.port, username: h.username, group: h.group ?? null })),
    };
  }

  // 需要目标主机与 SSH 连接的工具
  const host = (await store.listHosts(token.ownerId)).find(
    (h) => h.id === args.hostId && inScope(h)
  );
  if (!host) {
    throw Object.assign(new Error('目标主机不在令牌授权范围'), { code: 'host_not_allowed' });
  }

  // 连接策略：优先走连接池（同主机复用，空闲断开，见 ssh/pool.js）；未注入时退回一次性连接
  const withConn = (fn) =>
    ctx.sshPool
      ? ctx.sshPool.withPooled(`${token.ownerId}:${host.id}`, { host, masterKey, config }, fn)
      : withSsh({ host, masterKey, config }, fn);

  if (name === 'run_command') {
    const verdict = checkCommand(args.command, config.security, { level: token.level });
    if (!verdict.allowed) {
      throw Object.assign(new Error(`命令被拒绝（${verdict.reason}）`), { code: 'command_denied' });
    }
    const out = await withConn((conn) =>
      execCommand(conn, args.command, config.limits.execTimeoutMs ?? 60000)
    );
    const t = truncateDigest(redact(out.stdout), config.limits.outputDigestBytes ?? 2048);
    return { exitCode: out.exitCode, stdoutDigest: t.content, truncated: t.truncated, timedOut: out.timedOut };
  }

  if (name === 'read_file') {
    const pctx = { sensitivePaths: config.security.sensitivePaths, matrix: token.permissions };
    const verdict = checkPathAccess(args.path, pctx, 'read');
    if (!verdict.allowed) {
      throw Object.assign(new Error(`路径被拒绝（${verdict.reason}）`), { code: 'path_denied' });
    }
    return withConn((conn) => sftpRead(conn, args.path, MAX_READ_BYTES));
  }

  throw Object.assign(new Error(`未知工具: ${name}`), { code: 'tool_error' });
}

/** SFTP 读取（上限截断） */
function sftpRead(conn, path, maxBytes) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const chunks = [];
      let size = 0;
      const rs = sftp.createReadStream(path);
      rs.on('data', (d) => {
        if (size < maxBytes) chunks.push(d);
        size += d.length;
      });
      rs.on('error', (e) => reject(Object.assign(new Error(`读取失败: ${e.message}`), { code: 'path_denied' })));
      rs.on('end', () => {
        sftp.end();
        resolve({ content: Buffer.concat(chunks).toString('utf8'), truncated: size > maxBytes });
      });
    });
  });
}

export { checkRateLimit };

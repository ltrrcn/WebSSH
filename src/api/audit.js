// REST：审计接口（contracts/rest-api.md 审计节 / FR-012）
// GET /api/audit —— 时间顺序分页 + from/to/hostId/result 过滤
// GET /api/audit/export —— 导出可直接阅读的文本文件（脱敏已在写入时完成，导出不再暴露凭据）
// 2FA：审计查看属高危操作，config.twofa 开启且 protectedActions.audit 时需 X-2FA-Ticket
import { sendJson, sendError } from '../net/router.js';
import { resolveIdentity } from '../net/auth.js';
import { require2fa } from './twofa.js';

const EVENT_LABEL = {
  'connect-attempt': '连接尝试',
  'connect-success': '连接成功',
  'connect-failure': '连接失败',
  command: '命令执行',
  'quick-exec': '快捷命令',
  'host_create': '新建会话连接',
  'host_update': '编辑会话连接',
  'host_delete': '删除会话连接',
  'host_duplicate': '复制会话连接',
  'credential-update': '凭据更新',
  'file-read': '文件读取',
  'file-write': '文件写入',
  disconnect: '断开连接',
  detach: '会话挂起',
  resume: '会话恢复',
  'group_create': '分组新建',
  'group_rename': '分组重命名',
  'group_delete': '分组删除',
  twofa_setup: '2FA验证开始绑定',
  twofa_confirm: '2FA验证绑定成功',
  twofa_disable: '2FA验证关闭',
  twofa_verify: '2FA验证通过',
  twofa_verify_failure: '2FA验证失败',
  twofa_locked: '2FA验证锁定',
  twofa_actions_update: '2FA验证保护范围更新',
  twofa_recovery_success: '恢复码恢复成功',
  twofa_recovery_failure: '恢复码恢复失败',
  twofa_recovery_wipe: '恢复失败触发数据清除',
  'mcp-session-start': 'MCP 连接初始化',
  'mcp-session-end': 'MCP 连接结束',
  token_rename: '令牌重命名',
  token_restore: '令牌恢复',
  token_delete: '令牌永久删除',
  'twofa_ticket_ttl_update': '2FA验证票据有效期更新',
  'audit_settings_update': '审计设置更新',
  'mcp_direct_update': 'MCP直连配置更新',
  profile_update: '个人资料更新',
  avatar_upload: '头像上传',
  avatar_delete: '头像删除',
};
const RESULT_LABEL = { success: '成功', denied: '拒绝', error: '失败' };

/** 审计事件 → 可直接阅读的一行文本 */
function toReadableLine(ev) {
  const time = new Date(ev.ts).toLocaleString('zh-CN', { hour12: false });
  const actor = ev.actorType === 'token' ? `令牌:${ev.tokenId ?? ev.actor}` : `用户:${ev.actor}`;
  const parts = [
    `[${time}]`,
    `${EVENT_LABEL[ev.event] ?? ev.event}`,
    `${RESULT_LABEL[ev.result] ?? ev.result}`,
    `${actor}`,
    `主机=${ev.hostId ?? '-'}(${ev.hostAddress ?? '-'})`,
  ];
  if (ev.authType) parts.push(`认证=${ev.authType}`);
  if (ev.durationMs != null) parts.push(`时长=${ev.durationMs}ms`);
  if (ev.reason) parts.push(`原因=${ev.reason}`);
  if (ev.command) parts.push(`命令=${ev.command}`);
  if (ev.outputDigest) parts.push(`输出摘要=${ev.outputDigest}`);
  if (ev.path) parts.push(`路径=${ev.path}`);
  return parts.join(' | ');
}

/**
 * @param {{runtime: object, audit: object, sessionManager: object}} deps
 */
export function auditRoutes(deps) {
  const { runtime, audit, sessionManager } = deps;

  return [
    {
      // 会话聚合视图：命令审计页按会话展开（在线状态与存活会话实时比对）
      method: 'GET',
      path: '/api/audit/sessions',
      handler: async (req, res) => {
        if (require2fa(deps, req, res, 'audit')) return;
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        const q = new URL(req.url, 'http://localhost').searchParams;
        const from = q.get('from') ? Date.parse(q.get('from')) : null;
        const to = q.get('to') ? Date.parse(q.get('to')) : null;
        const hostId = q.get('hostId');

        // 人工审计流按 sessionId 聚合：创建时间取连接尝试时刻，命令数、结束时间一并汇总。
        // MCP 令牌流（AI Agent 会话，sessionId=m_*）同样聚合，标记 source='mcp'；
        // 无 sessionId 的 MCP 调用（旧客户端）跳过——前端归入「MCP 令牌调用（无会话）」组。
        const events = await audit.listAll();
        const bySid = new Map();
        for (const e of events) {
          if (!e.sessionId) continue;
          const isMcp = e.actorType === 'token';
          let s = bySid.get(e.sessionId);
          if (!s) {
            s = {
              sessionId: e.sessionId,
              source: isMcp ? 'mcp' : 'user',
              hostId: null,
              hostAddress: null,
              tokenId: isMcp ? e.tokenId : undefined,
              createdAt: e.ts,
              endedAt: null,
              commandCount: 0,
              failed: false,
              // 会话涉及的全体主机（MCP 会话首条握手事件无 hostId，需跨事件收集）
              hostIds: new Set(),
            };
            bySid.set(e.sessionId, s);
          }
          if (e.hostId) {
            s.hostIds.add(e.hostId);
            if (!s.hostId) {
              s.hostId = e.hostId;
              s.hostAddress = e.hostAddress;
            }
          }
          if (isMcp) {
            // MCP 会话：创建时间取 mcp-session-start（无则最早事件），结束时间取 mcp-session-end
            if (e.event === 'mcp-session-start' && e.ts < s.createdAt) s.createdAt = e.ts;
            if (e.event === 'mcp-session-end') s.endedAt = e.ts;
            // 除握手（start/end）外还有事件（工具调用）才算有活动
            if (e.event !== 'mcp-session-start' && e.event !== 'mcp-session-end') s.hasToolCall = true;
          } else {
            if (e.event === 'connect-attempt' && e.ts < s.createdAt) s.createdAt = e.ts;
            if (e.event === 'disconnect') s.endedAt = e.ts;
            if (e.event === 'connect-failure') s.failed = true;
          }
          if (e.event === 'command' && e.result === 'success') s.commandCount++;
        }
        const onlineIds = new Set(
          (sessionManager?.listSessions(identity.id) ?? []).map((s) => s.id)
        );
        let sessions = [...bySid.values()]
          // 纯握手的 MCP 会话（客户端 initialize 后未调任何工具）不进命令审计列表；审计数据保留
          .filter((s) => !(s.source === 'mcp' && !s.hasToolCall))
          .map(({ hasToolCall, hostIds, ...s }) => ({
            ...s,
            // 会话涉及的主机数与清单（前端：MCP 会话显示「N 台主机」，命令行显示主机名）
            hostCount: hostIds.size,
            hostIds: [...hostIds],
            // MCP 会话服务端无状态，永远不在线（前端以 MCP 标签替代在线状态展示）
            online: s.source === 'mcp' ? false : onlineIds.has(s.sessionId),
          }));
        if (from) sessions = sessions.filter((s) => Date.parse(s.createdAt) >= from);
        if (to) sessions = sessions.filter((s) => Date.parse(s.createdAt) <= to);
        if (hostId) sessions = sessions.filter((s) => s.hostIds.includes(hostId));
        // 创建时间倒序：最新会话在前
        sessions.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        sendJson(res, 200, { sessions });
      },
    },
    {
      method: 'GET',
      path: '/api/audit',
      handler: async (req, res) => {
        if (require2fa(deps, req, res, 'audit')) return;
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        const url = new URL(req.url, 'http://localhost');
        const q = url.searchParams;

        const from = q.get('from') ? Date.parse(q.get('from')) : null;
        const to = q.get('to') ? Date.parse(q.get('to')) : null;
        const hostId = q.get('hostId');
        const result = q.get('result');
        // 命令原文子串过滤（不区分大小写）：只命中带 command 字段的事件
        const command = q.get('command')?.trim().toLowerCase() ?? '';
        // 会话筛选：查看某一会话的全部事件（如该会话执行过的命令）
        const sessionId = q.get('sessionId')?.trim() ?? '';
        // 无会话筛选（noSession=1）：仅 sessionId 为空的事件（命令审计「MCP 令牌调用（无会话）」组专用，
        // 避免已归组的命令重复出现在该组）
        const noSession = q.get('noSession') === '1';
        // 类别筛选：commands=仅命令执行事件（Web 终端 + MCP），
        // operation=登录/连接与操作调用记录（connect-* / disconnect / file-* / group-* 等非命令事件）
        const category = q.get('category');
        // 来源筛选：mcp=仅 MCP 令牌调用（独立审计流），user=仅人工操作，默认全部
        const source = q.get('source');
        const limit = Math.min(Math.max(Number(q.get('limit')) || 50, 1), 500);
        const offset = Math.max(Number(q.get('offset')) || 0, 0);

        const actorType = source === 'mcp' ? 'token' : source === 'user' ? 'user' : undefined;
        // 时间倒序：最新记录排在前面
        let items = (await audit.listAll({ actorType })).sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
        if (from) items = items.filter((e) => Date.parse(e.ts) >= from);
        if (to) items = items.filter((e) => Date.parse(e.ts) <= to);
        if (hostId) items = items.filter((e) => e.hostId === hostId);
        if (result) items = items.filter((e) => e.result === result);
        if (command) items = items.filter((e) => typeof e.command === 'string' && e.command.toLowerCase().includes(command));
        if (sessionId) items = items.filter((e) => e.sessionId === sessionId);
        if (noSession) items = items.filter((e) => !e.sessionId);
        if (category === 'commands') items = items.filter((e) => e.event === 'command');
        else if (category === 'operation') items = items.filter((e) => e.event !== 'command');

        const total = items.length;
        items = items.slice(offset, offset + limit);
        sendJson(res, 200, { items, total, limit, offset });
      },
    },
    {
      method: 'GET',
      path: '/api/audit/export',
      handler: async (req, res) => {
        if (require2fa(deps, req, res, 'audit')) return;
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        const url = new URL(req.url, 'http://localhost');
        const source = url.searchParams.get('source');
        const actorType = source === 'mcp' ? 'token' : source === 'user' ? 'user' : undefined;
        const events = (await audit.listAll({ actorType })).sort((a, b) => (a.ts < b.ts ? -1 : 1));
        const scope = source === 'mcp' ? 'MCP 令牌调用' : source === 'user' ? '人工操作' : '全部';
        const header = `# WebSSH 审计导出（${scope}）\n# 导出时间: ${new Date().toISOString()}\n# 共 ${events.length} 条\n\n`;
        const body = header + events.map(toReadableLine).join('\n') + '\n';
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': `attachment; filename="webssh-audit-${Date.now()}.txt"`,
          'content-length': Buffer.byteLength(body),
        });
        res.end(body);
      },
    },
  ];
}

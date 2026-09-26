// REST：审计接口（contracts/rest-api.md 审计节 / FR-012）
// GET /api/audit —— 时间顺序分页 + from/to/hostId/result 过滤
// GET /api/audit/export —— 导出可直接阅读的文本文件（脱敏已在写入时完成，导出不再暴露凭据）
import { sendJson, sendError } from '../net/router.js';
import { resolveIdentity } from '../net/auth.js';

const EVENT_LABEL = {
  'connect-attempt': '连接尝试',
  'connect-success': '连接成功',
  'connect-failure': '连接失败',
  command: '命令执行',
  'file-read': '文件读取',
  'file-write': '文件写入',
  disconnect: '断开连接',
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
 * @param {{runtime: object, audit: object}} deps
 */
export function auditRoutes(deps) {
  const { runtime, audit } = deps;

  return [
    {
      method: 'GET',
      path: '/api/audit',
      handler: async (req, res) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        const url = new URL(req.url, 'http://localhost');
        const q = url.searchParams;

        const from = q.get('from') ? Date.parse(q.get('from')) : null;
        const to = q.get('to') ? Date.parse(q.get('to')) : null;
        const hostId = q.get('hostId');
        const result = q.get('result');
        const limit = Math.min(Math.max(Number(q.get('limit')) || 50, 1), 500);
        const offset = Math.max(Number(q.get('offset')) || 0, 0);

        let items = (await audit.listAll()).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
        if (from) items = items.filter((e) => Date.parse(e.ts) >= from);
        if (to) items = items.filter((e) => Date.parse(e.ts) <= to);
        if (hostId) items = items.filter((e) => e.hostId === hostId);
        if (result) items = items.filter((e) => e.result === result);

        const total = items.length;
        items = items.slice(offset, offset + limit);
        sendJson(res, 200, { items, total, limit, offset });
      },
    },
    {
      method: 'GET',
      path: '/api/audit/export',
      handler: async (req, res) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        const events = (await audit.listAll()).sort((a, b) => (a.ts < b.ts ? -1 : 1));
        const header = `# WebSSH 审计导出\n# 导出时间: ${new Date().toISOString()}\n# 共 ${events.length} 条\n\n`;
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

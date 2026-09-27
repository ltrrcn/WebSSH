// REST：会话接口（contracts/rest-api.md）
// GET /api/sessions —— 当前用户的活动会话；DELETE /api/sessions/{id} —— 终止并释放
// POST /api/ws-ticket —— 签发一次性 WS 连接票据（网关不向 WS 升级注入 X-Trim-* 的回退）
import { sendJson, sendError } from '../net/router.js';
import { resolveIdentity } from '../net/auth.js';
import { createWsTicket } from '../net/tickets.js';

/**
 * @param {{runtime: object, sessionManager: object}} deps
 */
export function sessionsRoutes(deps) {
  const { runtime, sessionManager } = deps;

  return [
    {
      method: 'POST',
      path: '/api/ws-ticket',
      handler: async (req, res) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        sendJson(res, 200, { ticket: createWsTicket(identity), ttlSeconds: 60 });
      },
    },
    {
      method: 'GET',
      path: '/api/sessions',
      handler: async (req, res) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        sendJson(res, 200, sessionManager.listSessions(identity.id));
      },
    },
    {
      method: 'DELETE',
      path: '/api/sessions/{id}',
      handler: async (req, res, ctx) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        const ok = sessionManager.killSession(ctx.params.id, identity.id);
        if (!ok) return sendError(res, 404, 'not_found', '会话不存在');
        sendJson(res, 200, { ok: true });
      },
    },
  ];
}

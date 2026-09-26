// REST：主机接口（contracts/rest-api.md）
// Phase 3（US1）：只读 GET /api/hosts，供终端页选择主机
// Phase 4（US2）：完整 CRUD 与指纹确认在本文件扩展
import { sendJson, sendError } from '../net/router.js';
import { resolveIdentity } from '../net/auth.js';

/**
 * @param {{runtime: object, store: object}} deps
 */
export function hostsRoutes(deps) {
  const { runtime, store } = deps;

  return [
    {
      method: 'GET',
      path: '/api/hosts',
      handler: async (req, res) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        const hosts = await store.listHosts(identity.id);
        // 契约：凭据字段只返回 hasSecret，绝不返回 secret 结构
        sendJson(
          res,
          200,
          hosts.map((h) => ({
            id: h.id,
            name: h.name,
            host: h.host,
            port: h.port,
            username: h.username,
            authType: h.authType,
            group: h.group,
            fingerprintConfirmed: Boolean(h.fingerprint),
            hasSecret: Boolean(h.secret),
            lastUsedAt: h.lastUsedAt ?? null,
          }))
        );
      },
    },
  ];
}

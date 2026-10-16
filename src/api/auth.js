// REST：当前请求者身份（contracts/rest-api.md → GET /api/auth/me）
// 仅返回网关注入（fnOS）或本地会话（standalone）解析出的身份三元组，不含敏感字段
import { sendJson, sendError } from '../net/router.js';
import { resolveIdentity } from '../net/auth.js';

export function authRoutes(deps) {
  const { runtime } = deps;
  return [
    {
      method: 'GET',
      path: '/api/auth/me',
      handler: async (req, res) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        sendJson(res, 200, {
          id: identity.id,
          username: identity.username,
          isAdmin: identity.isAdmin,
        });
      },
    },
  ];
}

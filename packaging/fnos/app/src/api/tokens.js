// REST：MCP 令牌管理（contracts/rest-api.md 令牌节 / FR-022~026）
// POST 响应一次性返回令牌明文；权限矩阵只能在全局默认内收紧（FR-040）
import { sendJson, sendError, readJsonBody } from '../net/router.js';
import { resolveIdentity } from '../net/auth.js';
import { createTokenRecord, publicTokenView } from '../mcp/tokens.js';
import { assertMatrixTightened } from '../ssh/policy.js';

export function tokensRoutes(deps) {
  const { runtime, store, config, masterKey } = deps;

  return [
    {
      method: 'GET',
      path: '/api/tokens',
      handler: async (req, res) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        const { publicTokenView: view } = await import('../mcp/tokens.js');
        const list = await store.listTokens(identity.id);
        sendJson(res, 200, list.map(view));
      },
    },
    {
      method: 'GET',
      path: '/api/tokens/defaults',
      handler: async (req, res) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        sendJson(res, 200, {
          defaultPermissions: config.defaultPermissions ?? [],
          sensitivePaths: config.security?.sensitivePaths ?? [],
          note: '令牌矩阵以全局默认初始化，只能收紧不得放开；系统敏感路径恒定拒绝且不可配置放行',
        });
      },
    },
    {
      method: 'POST',
      path: '/api/tokens',
      handler: async (req, res) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        let body;
        try {
          body = await readJsonBody(req);
        } catch (e) {
          return sendError(res, 422, 'invalid_json', e.message);
        }
        const name = body?.name;
        const level = body?.level;
        const hostScope = body?.hostScope;
        if (typeof name !== 'string' || !name.trim() || name.length > 64) {
          return sendError(res, 422, 'invalid_field', 'name 必须为 1–64 字符');
        }
        if (level !== 'readonly' && level !== 'writable') {
          return sendError(res, 422, 'invalid_field', 'level 必须为 readonly 或 writable');
        }
        if (!Array.isArray(hostScope) || hostScope.some((h) => typeof h !== 'string')) {
          return sendError(res, 422, 'invalid_field', 'hostScope 必须为主机 ID 数组');
        }
        // 主机范围必须全部归属本人（FR-025）
        const mine = await store.listHosts(identity.id);
        const badHost = hostScope.find((h) => !mine.some((m) => m.id === h));
        if (badHost) {
          return sendError(res, 422, 'invalid_field', `hostScope 含无效或非本人主机: ${badHost}`);
        }
        let expiresAt = null;
        if (body?.expiresAt) {
          expiresAt = new Date(body.expiresAt);
          if (Number.isNaN(expiresAt.getTime())) {
            return sendError(res, 422, 'invalid_field', 'expiresAt 必须为合法时间');
          }
          expiresAt = expiresAt.toISOString();
        }

        // 矩阵：以全局默认初始化，叠加请求的收紧条目（FR-040）
        const defaults = (config.defaultPermissions ?? []).map((d) => ({ ...d, source: 'global-default' }));
        let matrix = defaults;
        if (Array.isArray(body?.permissions)) {
          try {
            const overrides = body.permissions.map((p) => ({ ...p, source: 'token-override' }));
            assertMatrixTightened(overrides, defaults);
            matrix = defaults
              .filter((d) => !overrides.some((o) => o.prefix === d.prefix))
              .concat(overrides);
          } catch (e) {
            return sendError(res, 422, e.code ?? 'permission_out_of_range', e.message);
          }
        }

        const tokens = await store.listTokensAll();
        const { record, plaintext } = await createTokenRecord(store, {
          ownerId: identity.id,
          name: name.trim(),
          level,
          hostScope,
          permissions: matrix,
          expiresAt,
        });
        tokens.push(record);
        await store.saveTokens(tokens);
        // 契约：明文仅此一次返回
        sendJson(res, 201, { ...publicTokenView(record), token: plaintext });
      },
    },
    {
      method: 'DELETE',
      path: '/api/tokens/{id}',
      handler: async (req, res, ctx) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        const token = await store.getTokenById(ctx.params.id);
        if (!token) return sendError(res, 404, 'not_found', '令牌不存在');
        if (token.ownerId !== identity.id) {
          return sendError(res, 403, 'forbidden', '无权访问该资源');
        }
        // 撤销立即生效（FR-026）
        await store.touchToken(token.id, { status: 'revoked' });
        sendJson(res, 200, { ok: true });
      },
    },
  ];
}

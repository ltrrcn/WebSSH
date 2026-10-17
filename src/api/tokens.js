// REST：MCP 令牌管理（contracts/rest-api.md 令牌节 / FR-022~026）
// POST 响应一次性返回令牌明文；权限矩阵只能在全局默认内收紧（FR-040）
// 2FA：创建/撤销/删除属高危操作（protectedActions.tokens）需 X-2FA-Ticket；列表查看不拦截
import { sendJson, sendError, readJsonBody } from '../net/router.js';
import { resolveIdentity } from '../net/auth.js';
import { createTokenRecord, publicTokenView } from '../mcp/tokens.js';
import { assertMatrixTightened } from '../ssh/policy.js';
import { require2fa } from './twofa.js';
import { normalizeDefaultGroup } from './groups.js';

export function tokensRoutes(deps) {
  const { runtime, store, config, masterKey, audit } = deps;

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
          limits: {
            tokenRateLimitPerMinute: config.limits?.tokenRateLimitPerMinute ?? 60,
            execTimeoutMs: config.limits?.execTimeoutMs ?? 60000,
          },
          note: '令牌矩阵以全局默认初始化，只能收紧不得放开；系统敏感路径恒定拒绝且不可配置放行',
        });
      },
    },
    {
      method: 'POST',
      path: '/api/tokens',
      handler: async (req, res) => {
        if (require2fa(deps, req, res, 'tokens')) return;
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
        const hostGroups = body?.hostGroups ?? [];
        if (typeof name !== 'string' || !name.trim() || name.length > 64) {
          return sendError(res, 422, 'invalid_field', 'name 必须为 1–64 字符');
        }
        if (level !== 'readonly' && level !== 'writable') {
          return sendError(res, 422, 'invalid_field', 'level 必须为 readonly 或 writable');
        }
        if (!Array.isArray(hostScope) || hostScope.some((h) => typeof h !== 'string')) {
          return sendError(res, 422, 'invalid_field', 'hostScope 必须为主机 ID 数组');
        }
        // 按分组授权（动态）：分组名数组；与 /api/groups 列表同口径——
        // 允许内置 Default（含 default/默认/null 历史别名）+ 本人实体分组 + 仅被主机引用的历史分组
        if (!Array.isArray(hostGroups) || hostGroups.some((g) => typeof g !== 'string' || !g)) {
          return sendError(res, 422, 'invalid_field', 'hostGroups 必须为分组名数组');
        }
        // 主机列表先行获取：分组校验（历史分组来自主机引用）与 hostScope 归属校验共用
        const mine = await store.listHosts(identity.id);
        if (hostGroups.length) {
          const myGroups = new Set((await store.listGroups(identity.id)).map((g) => g.name));
          for (const h of mine) {
            if (h.group && normalizeDefaultGroup(h.group) !== 'Default') myGroups.add(h.group);
          }
          const badGroup = hostGroups.find((g) => normalizeDefaultGroup(g) !== 'Default' && !myGroups.has(g));
          if (badGroup) {
            return sendError(res, 422, 'invalid_field', `hostGroups 含无效分组: ${badGroup}`);
          }
        }
        // 内置别名统一归一化为 Default 存储，MCP 侧按同语义匹配
        const groupRefs = hostGroups.map((g) => normalizeDefaultGroup(g));
        // 动态授权（FR-025 扩展）：开启后授权本人全部主机（含后续新增），hostScope 清空仅作记录
        const allHosts = body?.allHosts === true;
        // 主机范围必须全部归属本人（FR-025）；空 hostScope 保持既有合法语义（至少一台由前端保证）
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
          hostScope: allHosts ? [] : hostScope,
          hostGroups: groupRefs,
          allHosts,
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
      // 重命名令牌（仅改展示名，不触碰权限矩阵/明文/状态）：2FA 保护与创建/撤销/删除一致
      method: 'PUT',
      path: '/api/tokens/{id}',
      handler: async (req, res, ctx) => {
        if (require2fa(deps, req, res, 'tokens')) return;
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        const token = await store.getTokenById(ctx.params.id);
        if (!token) return sendError(res, 404, 'not_found', '令牌不存在');
        if (token.ownerId !== identity.id) {
          return sendError(res, 403, 'forbidden', '无权访问该资源');
        }
        let body;
        try {
          body = await readJsonBody(req);
        } catch (e) {
          return sendError(res, 422, 'invalid_json', e.message);
        }
        const name = body?.name;
        if (typeof name !== 'string' || !name.trim() || name.length > 64) {
          return sendError(res, 422, 'invalid_field', 'name 必须为 1–64 字符');
        }
        const next = name.trim();
        await store.touchToken(token.id, { name: next });
        audit?.log({
          event: 'token_rename',
          actorType: 'user',
          userId: identity.id,
          tokenId: token.id,
          result: 'success',
        });
        sendJson(res, 200, { ok: true, name: next });
      },
    },
    {
      // 恢复已撤销令牌（撤销的反向操作）：仅 revoked 且未过有效期可恢复；2FA 保护同撤销/删除
      method: 'PUT',
      path: '/api/tokens/{id}/restore',
      handler: async (req, res, ctx) => {
        if (require2fa(deps, req, res, 'tokens')) return;
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        const token = await store.getTokenById(ctx.params.id);
        if (!token) return sendError(res, 404, 'not_found', '令牌不存在');
        if (token.ownerId !== identity.id) {
          return sendError(res, 403, 'forbidden', '无权访问该资源');
        }
        if (token.status !== 'revoked') {
          return sendError(res, 422, 'not_revoked', '仅已撤销的令牌可恢复');
        }
        if (token.expiresAt && Date.now() > Date.parse(token.expiresAt)) {
          return sendError(res, 422, 'token_expired', '令牌有效期已过，无法恢复');
        }
        await store.touchToken(token.id, { status: 'active' });
        audit?.log({
          event: 'token_restore',
          actorType: 'user',
          userId: identity.id,
          tokenId: token.id,
          result: 'success',
        });
        sendJson(res, 200, { ok: true });
      },
    },
    {
      method: 'DELETE',
      path: '/api/tokens/{id}',
      handler: async (req, res, ctx) => {
        if (require2fa(deps, req, res, 'tokens')) return;
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
    {
      // 永久删除（rest-api.md 令牌节）：从存储移除记录，不可恢复；
      // 仅限已撤销/已过期令牌——活跃令牌必须先撤销，防止误删在用凭据
      method: 'DELETE',
      path: '/api/tokens/{id}/purge',
      handler: async (req, res, ctx) => {
        if (require2fa(deps, req, res, 'tokens')) return;
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        const token = await store.getTokenById(ctx.params.id);
        if (!token) return sendError(res, 404, 'not_found', '令牌不存在');
        if (token.ownerId !== identity.id) {
          return sendError(res, 403, 'forbidden', '无权访问该资源');
        }
        if (token.status === 'active') {
          return sendError(res, 422, 'token_active', '活跃令牌不可直接删除，请先撤销');
        }
        await store.deleteToken(token.id);
        audit?.log({
          event: 'token_delete',
          actorType: 'user',
          userId: identity.id,
          tokenId: token.id,
          result: 'success',
          reason: '永久删除，不可恢复',
        });
        sendJson(res, 200, { ok: true });
      },
    },
  ];
}

// REST：分组管理（contracts/rest-api.md 分组节）
// 分组是主机 group 字段的集合视图，本接口做集合批量更新：
// - 重命名：组内主机 group -> newName（目标已存在则合并）
// - 删除：组内主机 group -> null（回「默认」分组），主机与凭据完整保留，绝不连带删除
// 「默认」为 null 分组的前端显示名，作为保留名禁止操作
import { sendJson, sendError, readJsonBody } from '../net/router.js';
import { resolveIdentity } from '../net/auth.js';

const RESERVED_GROUP = '默认';

export function groupsRoutes(deps) {
  const { runtime, store, audit } = deps;

  const invalid = (res, msg) => sendError(res, 422, 'invalid_field', msg);

  return [
    {
      method: 'PUT',
      path: '/api/groups/{name}',
      handler: async (req, res, ctx) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        const name = ctx.params.name;
        if (!name) return invalid(res, '分组名不能为空');
        if (name === RESERVED_GROUP) return invalid(res, `「${RESERVED_GROUP}」为保留分组名（null 分组），不可重命名`);
        let body;
        try {
          body = await readJsonBody(req);
        } catch (e) {
          return sendError(res, 422, 'invalid_json', e.message);
        }
        const newName = body?.newName;
        if (typeof newName !== 'string' || !newName.trim() || newName.length > 64) {
          return invalid(res, 'newName 必须为 1–64 字符的非空字符串');
        }
        if (newName === RESERVED_GROUP) return invalid(res, `「${RESERVED_GROUP}」为保留分组名，不可用作目标分组`);

        const moved = await store.updateHostsGroup(identity.id, name, newName);
        audit.log({
          event: 'group_rename',
          actorType: 'user',
          userId: identity.id,
          result: 'success',
          group: name,
          newGroup: newName,
          moved,
        });
        sendJson(res, 200, { ok: true, moved });
      },
    },
    {
      method: 'DELETE',
      path: '/api/groups/{name}',
      handler: async (req, res, ctx) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        const name = ctx.params.name;
        if (!name) return invalid(res, '分组名不能为空');
        if (name === RESERVED_GROUP) return invalid(res, `「${RESERVED_GROUP}」分组不可删除（主机移入其中即等价于未分组）`);

        // 删除分组 = 解除标签：主机移回默认分组，凭据完整保留
        const moved = await store.updateHostsGroup(identity.id, name, null);
        audit.log({
          event: 'group_delete',
          actorType: 'user',
          userId: identity.id,
          result: 'success',
          group: name,
          moved,
        });
        sendJson(res, 200, { ok: true, moved });
      },
    },
  ];
}

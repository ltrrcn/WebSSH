// REST：分组管理（分组为独立实体 groups.json，支持新建/排序）
// - Default 为内置分组（不落盘、不可重命名/删除），恒为列表第一项
// - 历史值 default / 默认 / null 均归一化为 Default 显示与计数
// - 重命名：实体改名 + 组内主机 group 迁移；目标已存在则合并（删源实体）
// - 删除：删实体 + 组内主机 group -> 'Default'，主机与凭据完整保留，绝不连带删除
import { sendJson, sendError, readJsonBody } from '../net/router.js';
import { resolveIdentity } from '../net/auth.js';

export const DEFAULT_GROUP = 'Default';
// Default 及历史别名：均视为内置分组名，禁止作为自定义分组创建/重命名目标
const DEFAULT_ALIASES = new Set([DEFAULT_GROUP, 'default', '默认']);

/** 内置分组名归一化：Default/default/默认/null → 'Default'；其余原样返回（供令牌等消费方对齐同一语义） */
export function normalizeDefaultGroup(name) {
  return name == null || DEFAULT_ALIASES.has(name) ? DEFAULT_GROUP : name;
}

export function groupsRoutes(deps) {
  const { runtime, store, audit } = deps;

  const invalid = (res, msg) => sendError(res, 422, 'invalid_field', msg);

  const validName = (name) =>
    typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 64;

  return [
    // 排序必须注册在 /api/groups/{name} 之前（静态段优先命中）
    {
      method: 'PUT',
      path: '/api/groups/reorder',
      handler: async (req, res) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        let body;
        try {
          body = await readJsonBody(req);
        } catch (e) {
          return sendError(res, 422, 'invalid_json', e.message);
        }
        const order = body?.order;
        if (!Array.isArray(order) || order.some((n) => typeof n !== 'string')) {
          return invalid(res, 'order 必须为分组名数组');
        }
        if (order.some((n) => DEFAULT_ALIASES.has(n))) {
          return invalid(res, '内置 Default 分组固定为第一位，不参与排序');
        }
        await store.reorderGroups(identity.id, order);
        sendJson(res, 200, { ok: true });
      },
    },
    {
      method: 'GET',
      path: '/api/groups',
      handler: async (req, res) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        const [hosts, entities] = await Promise.all([
          store.listHosts(identity.id),
          store.listGroups(identity.id),
        ]);
        // 主机计数：内置别名（null / default / 默认 / Default）统一计入 Default
        const counts = new Map();
        let defaultCount = 0;
        for (const h of hosts) {
          const g = h.group ?? DEFAULT_GROUP;
          if (DEFAULT_ALIASES.has(g)) defaultCount++;
          else counts.set(g, (counts.get(g) ?? 0) + 1);
        }
        // 实体分组 + 只有主机引用但无实体的历史分组（合并展示，保持可见）
        const known = new Set(entities.map((g) => g.name));
        const groups = [
          { name: DEFAULT_GROUP, count: defaultCount, builtin: true },
          ...entities.map((g) => ({ name: g.name, count: counts.get(g.name) ?? 0, builtin: false })),
        ];
        for (const [name, count] of counts) {
          if (!known.has(name)) groups.push({ name, count, builtin: false });
        }
        sendJson(res, 200, { groups });
      },
    },
    {
      method: 'POST',
      path: '/api/groups',
      handler: async (req, res) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        let body;
        try {
          body = await readJsonBody(req);
        } catch (e) {
          return sendError(res, 422, 'invalid_json', e.message);
        }
        const name = typeof body?.name === 'string' ? body.name.trim() : '';
        if (!validName(name)) return invalid(res, 'name 必须为 1–64 字符的非空字符串');
        if (DEFAULT_ALIASES.has(name)) return invalid(res, `「${DEFAULT_GROUP}」为内置分组，无需创建`);
        const existing = await store.listGroups(identity.id);
        if (existing.some((g) => g.name === name)) return invalid(res, `分组「${name}」已存在`);

        const entry = await store.createGroupEntity(identity.id, name);
        audit.log({
          event: 'group_create',
          actorType: 'user',
          userId: identity.id,
          result: 'success',
          group: name,
        });
        sendJson(res, 201, { ok: true, name: entry.name, order: entry.order });
      },
    },
    {
      method: 'PUT',
      path: '/api/groups/{name}',
      handler: async (req, res, ctx) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        const name = ctx.params.name;
        if (!name) return invalid(res, '分组名不能为空');
        if (DEFAULT_ALIASES.has(name)) return invalid(res, `「${DEFAULT_GROUP}」为内置分组，不可重命名`);
        let body;
        try {
          body = await readJsonBody(req);
        } catch (e) {
          return sendError(res, 422, 'invalid_json', e.message);
        }
        const newName = body?.newName;
        if (!validName(newName)) return invalid(res, 'newName 必须为 1–64 字符的非空字符串');
        const trimmed = newName.trim();
        if (DEFAULT_ALIASES.has(trimmed)) return invalid(res, `「${DEFAULT_GROUP}」为保留分组名，不可用作目标分组`);

        // 实体改名/合并 + 主机 group 迁移
        await store.renameGroupEntity(identity.id, name, trimmed);
        const moved = await store.updateHostsGroup(identity.id, name, trimmed);
        audit.log({
          event: 'group_rename',
          actorType: 'user',
          userId: identity.id,
          result: 'success',
          group: name,
          newGroup: trimmed,
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
        if (DEFAULT_ALIASES.has(name)) return invalid(res, `「${DEFAULT_GROUP}」为内置分组，不可删除`);

        // 删除分组 = 解除标签：删实体，主机移回 Default，凭据完整保留
        await store.removeGroupEntity(identity.id, name);
        const moved = await store.updateHostsGroup(identity.id, name, DEFAULT_GROUP);
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

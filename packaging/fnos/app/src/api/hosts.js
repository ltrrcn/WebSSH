// REST：主机接口（contracts/rest-api.md）
// Phase 3（US1）：GET /api/hosts 只读
// Phase 4（US2）：完整 CRUD + 指纹确认 + 分组维护（T045/T046/T047）
import { randomUUID } from 'node:crypto';
import { sendJson, sendError, readJsonBody } from '../net/router.js';
import { resolveIdentity } from '../net/auth.js';
import { encryptSecret } from '../crypto/secret.js';
import { appendKnownHost } from '../ssh/hostkey.js';

/** host 字段允许的形态：域名或 IP 字面量，禁止分隔符与空白 */
const HOSTNAME_RE = /^[A-Za-z0-9._-]+$/;

function invalid(message) {
  const err = new Error(message);
  err.code = 'invalid_field';
  return err;
}

/**
 * 校验主机创建/更新载荷。
 * @param {object} body 请求体
 * @param {{partial?: boolean}} [opts] partial=true 时字段可选（PUT），出现即校验
 * @returns {{value: object}} 规范化后的载荷（仅白名单字段）
 * @throws message 指明非法字段名（供 422 响应与测试断言）
 */
export function validateHostPayload(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalid('请求体必须为 JSON 对象');
  }
  const value = {};

  if (body.name !== undefined || !partial) {
    const name = body.name;
    if (typeof name !== 'string' || name.length < 1 || name.length > 64) {
      throw invalid('name 必须为 1–64 字符的字符串');
    }
    value.name = name;
  }
  if (body.host !== undefined || !partial) {
    if (typeof body.host !== 'string' || !HOSTNAME_RE.test(body.host)) {
      throw invalid('host 非法（仅允许域名或 IP 字面量，禁止分隔符与空白）');
    }
    value.host = body.host;
  }
  if (body.port !== undefined) {
    const port = body.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw invalid('port 必须为 1–65535 的整数');
    }
    value.port = port;
  } else if (!partial) {
    value.port = 22;
  }
  if (body.username !== undefined || !partial) {
    if (typeof body.username !== 'string' || body.username === '') {
      throw invalid('username 必须为非空字符串');
    }
    value.username = body.username;
  }
  if (body.authType !== undefined || !partial) {
    if (body.authType !== 'password' && body.authType !== 'privateKey') {
      throw invalid('authType 必须为 password 或 privateKey');
    }
    value.authType = body.authType;
  }
  if (body.group !== undefined) {
    if (body.group !== null && typeof body.group !== 'string') {
      throw invalid('group 必须为字符串或 null');
    }
    value.group = body.group;
  }

  // 凭据：出现即校验形态
  const hasPw = body.password !== undefined && body.password !== null;
  const hasKey = body.privateKey !== undefined && body.privateKey !== null;
  if (hasPw || hasKey) {
    if (hasPw && (typeof body.password !== 'string' || body.password === '')) {
      throw invalid('password 必须为非空字符串');
    }
    if (hasKey && typeof body.privateKey !== 'string') {
      throw invalid('privateKey 必须为字符串（PEM）');
    }
    if (body.passphrase !== undefined && body.passphrase !== null && typeof body.passphrase !== 'string') {
      throw invalid('passphrase 必须为字符串');
    }
    value.secret = hasKey
      ? { privateKey: body.privateKey, passphrase: body.passphrase ?? undefined }
      : { password: body.password };
  }
  // 创建（非 partial）：凭据形态必须与 authType 匹配
  if (!partial) {
    if (value.authType === 'password' && value.secret?.password === undefined) {
      throw invalid('password 认证必须提供 password');
    }
    if (value.authType === 'privateKey' && value.secret?.privateKey === undefined) {
      throw invalid('privateKey 认证必须提供 privateKey');
    }
  }

  return { value };
}

/** 主机条目 → 公开视图（凭据绝不外泄，FR-005） */
function publicView(h) {
  return {
    id: h.id,
    name: h.name,
    host: h.host,
    port: h.port,
    username: h.username,
    authType: h.authType,
    group: h.group ?? null,
    fingerprintConfirmed: Boolean(h.fingerprint),
    pendingFingerprint: h.pendingFingerprint ?? null,
    hasSecret: Boolean(h.secret),
    lastUsedAt: h.lastUsedAt ?? null,
  };
}

/**
 * @param {{runtime: object, store: object, masterKey: Buffer}} deps
 */
export function hostsRoutes(deps) {
  const { runtime, store, masterKey } = deps;

  /** 越权返回 403 且不暴露资源存在性；不存在返回 404 */
  async function requireHost(id, ownerId) {
    const host = await store.getHost(id, ownerId);
    if (host) return { host };
    const exists = await store.getHostById(id);
    return { host: null, forbidden: Boolean(exists) };
  }

  return [
    {
      method: 'GET',
      path: '/api/hosts',
      handler: async (req, res) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        const hosts = await store.listHosts(identity.id);
        sendJson(res, 200, hosts.map(publicView));
      },
    },
    {
      method: 'POST',
      path: '/api/hosts',
      handler: async (req, res) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        let body;
        try {
          body = await readJsonBody(req);
        } catch (e) {
          return sendError(res, 422, 'invalid_json', e.message);
        }
        let value;
        try {
          ({ value } = validateHostPayload(body, { partial: false }));
        } catch (e) {
          return sendError(res, 422, e.code ?? 'invalid_field', e.message);
        }
        const now = new Date().toISOString();
        const entry = {
          id: `h_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
          name: value.name,
          host: value.host,
          port: value.port,
          username: value.username,
          authType: value.authType,
          secret: encryptSecret(masterKey, value.secret),
          group: value.group ?? null,
          ownerId: identity.id,
          fingerprint: null,
          pendingFingerprint: null,
          fingerprintConfirmedAt: null,
          createdAt: now,
          updatedAt: now,
          lastUsedAt: null,
        };
        await store.upsertHost(entry);
        sendJson(res, 201, publicView(entry));
      },
    },
    {
      method: 'GET',
      path: '/api/hosts/{id}',
      handler: async (req, res, ctx) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        const id = ctx.params.id;
        const { host, forbidden } = await requireHost(id, identity.id);
        if (forbidden) return sendError(res, 403, 'forbidden', '无权访问该资源');
        if (!host) return sendError(res, 404, 'not_found', '主机不存在');
        sendJson(res, 200, publicView(host));
      },
    },
    {
      method: 'PUT',
      path: '/api/hosts/{id}',
      handler: async (req, res, ctx) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        const id = ctx.params.id;
        const { host, forbidden } = await requireHost(id, identity.id);
        if (forbidden) return sendError(res, 403, 'forbidden', '无权访问该资源');
        if (!host) return sendError(res, 404, 'not_found', '主机不存在');

        let body;
        try {
          body = await readJsonBody(req);
        } catch (e) {
          return sendError(res, 422, 'invalid_json', e.message);
        }
        let value;
        try {
          ({ value } = validateHostPayload(body, { partial: true }));
        } catch (e) {
          return sendError(res, 422, e.code ?? 'invalid_field', e.message);
        }

        // 更换认证方式必须同时提供新凭据
        if (value.authType && value.authType !== host.authType && !value.secret) {
          return sendError(res, 422, 'credential_required', '更换认证方式必须同时提供新凭据');
        }

        const addressChanged =
          (value.host !== undefined && value.host !== host.host) ||
          (value.port !== undefined && value.port !== host.port);

        const updated = {
          ...host,
          ...('name' in value && value.name !== undefined ? { name: value.name } : {}),
          ...('host' in value && value.host !== undefined ? { host: value.host } : {}),
          ...('port' in value && value.port !== undefined ? { port: value.port } : {}),
          ...('username' in value && value.username !== undefined ? { username: value.username } : {}),
          ...('authType' in value && value.authType !== undefined ? { authType: value.authType } : {}),
          ...('group' in value ? { group: value.group } : {}),
          ...(value.secret ? { secret: encryptSecret(masterKey, value.secret) } : {}),
          updatedAt: new Date().toISOString(),
        };
        // 目标地址变化 → 主机身份改变，指纹必须重新确认（防新地址沿用旧指纹）
        if (addressChanged) {
          updated.fingerprint = null;
          updated.pendingFingerprint = null;
          updated.fingerprintConfirmedAt = null;
        }
        await store.upsertHost(updated);
        sendJson(res, 200, publicView(updated));
      },
    },
    {
      method: 'DELETE',
      path: '/api/hosts/{id}',
      handler: async (req, res, ctx) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        const id = ctx.params.id;
        const { host, forbidden } = await requireHost(id, identity.id);
        if (forbidden) return sendError(res, 403, 'forbidden', '无权访问该资源');
        if (!host) return sendError(res, 404, 'not_found', '主机不存在');
        await store.deleteHost(id, identity.id);
        sendJson(res, 200, { ok: true });
      },
    },
    {
      method: 'POST',
      path: '/api/hosts/{id}/duplicate',
      handler: async (req, res, ctx) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        const id = ctx.params.id;
        const { host, forbidden } = await requireHost(id, identity.id);
        if (forbidden) return sendError(res, 403, 'forbidden', '无权访问该资源');
        if (!host) return sendError(res, 404, 'not_found', '主机不存在');

        const now = new Date().toISOString();
        // FR-056：加密凭据密文原样复制（无需解密），副本为完全独立条目
        const copy = {
          ...host,
          id: `h_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
          name: `${host.name} 副本`,
          createdAt: now,
          updatedAt: now,
          lastUsedAt: null,
        };
        await store.upsertHost(copy);
        sendJson(res, 200, publicView(copy));
      },
    },
    {
      method: 'POST',
      path: '/api/hosts/{id}/verify-hostkey',
      handler: async (req, res, ctx) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        const id = ctx.params.id;
        const { host, forbidden } = await requireHost(id, identity.id);
        if (forbidden) return sendError(res, 403, 'forbidden', '无权访问该资源');
        if (!host) return sendError(res, 404, 'not_found', '主机不存在');

        let body;
        try {
          body = await readJsonBody(req);
        } catch (e) {
          return sendError(res, 422, 'invalid_json', e.message);
        }
        const fingerprint = body?.fingerprint;
        if (typeof fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/=]+$/.test(fingerprint)) {
          return sendError(res, 422, 'invalid_fingerprint', 'fingerprint 必须为 SHA256:xxx 形式');
        }
        await store.touchHost(id, {
          fingerprint,
          fingerprintConfirmedAt: new Date().toISOString(),
          pendingFingerprint: null,
        });
        // 同步写入 known_hosts 供人工核对（R10）
        await appendKnownHost({
          paths: runtime.paths,
          host: host.host,
          port: host.port,
          algorithm: 'ssh-key',
          fingerprint,
        });
        sendJson(res, 200, { ok: true, fingerprint });
      },
    },
  ];
}

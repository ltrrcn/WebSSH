// REST：主机接口（contracts/rest-api.md）
// Phase 3（US1）：GET /api/hosts 只读
// Phase 4（US2）：完整 CRUD + 指纹确认 + 分组维护（T045/T046/T047）
import { randomBytes } from 'node:crypto';
import { sendJson, sendError, readJsonBody } from '../net/router.js';
import { resolveIdentity } from '../net/auth.js';
import { encryptSecret, decryptSecret } from '../crypto/secret.js';
import { createPassTicket } from '../net/tickets.js';
import { appendKnownHost } from '../ssh/hostkey.js';

const SHORT_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** 4 位短随机后缀（base36，36^4≈168 万组合）：仅在名称无法用作 ID 时兜底 */
function shortSuffix() {
  return [...randomBytes(4)].map((b) => SHORT_ID_CHARS[b % 36]).join('');
}

/**
 * 设备 ID（主机 ID）：以会话名称（主机名称）为基准。
 * - 空白折叠为 `-`，去掉 URL 路径不安全的字符（/ \ ? # % & : 等），保留中英文、数字、. _ -
 * - 名称净化后为空 → 回退 h_ + 随机后缀
 * - 与既有设备 ID 冲突 → 追加 -2、-3…（ID 一经分配即固定，后续改名不影响）
 * - 唯一性按全量主机判定（不区分归属），确保设备 ID 全局不重复
 */
const ID_UNSAFE_RE = /[/\?#%&:\\\s]+/g;
function slugifyName(name) {
  return String(name ?? '')
    .trim()
    .replace(ID_UNSAFE_RE, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function nextHostId(store, name) {
  const base = slugifyName(name) || `h_${shortSuffix()}`;
  const free = async (id) => !(await store.getHostById(id)); // 全量主机：跨用户也保证不重复
  let id = base;
  for (let i = 2; i <= 999; i++) {
    if (await free(id)) return id;
    id = `${base}-${i}`;
  }
  for (let i = 0; i < 8; i++) {
    // 序号耗尽后回退随机后缀，仍保证唯一
    const rand = `${base}-${shortSuffix()}`;
    if (await free(rand)) return rand;
  }
  throw new Error('主机 ID 生成冲突超限');
}

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
    if (body.authType !== 'password' && body.authType !== 'privateKey' && body.authType !== 'none') {
      throw invalid('authType 必须为 password、privateKey 或 none');
    }
    value.authType = body.authType;
  }
  // 连接方式：direct（直连，默认）/ jump（跳板机）；隧道与代理为后续能力
  if (body.connectVia !== undefined) {
    if (body.connectVia !== 'direct' && body.connectVia !== 'jump') {
      throw invalid('connectVia 必须为 direct 或 jump');
    }
    value.connectVia = body.connectVia;
    if (body.connectVia === 'jump') {
      if (typeof body.jumpHostId !== 'string' || body.jumpHostId === '') {
        throw invalid('jumpHostId 必须为非空字符串（跳板机主机 ID）');
      }
      value.jumpHostId = body.jumpHostId;
    }
  }
  if (body.group !== undefined) {
    if (body.group !== null && typeof body.group !== 'string') {
      throw invalid('group 必须为字符串或 null');
    }
    if (body.group === '默认' || body.group === 'default') {
      throw invalid('「default/默认」为内置分组 Default 的历史别名，请直接使用 Default');
    }
    // null 与历史别名归一化为内置 Default 分组
    value.group = body.group == null || body.group === '默认' || body.group === 'default' ? 'Default' : body.group;
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
    if (value.authType === 'none') {
      throw invalid('authType 为 none（不记录凭据）时不接受 password/privateKey');
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
    connectVia: h.connectVia ?? 'direct',
    jumpHostId: h.jumpHostId ?? null,
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
  const { runtime, store, masterKey, audit } = deps;

  /** 越权返回 403 且不暴露资源存在性；不存在返回 404 */
  async function requireHost(id, ownerId) {
    const host = await store.getHost(id, ownerId);
    if (host) return { host };
    const exists = await store.getHostById(id);
    return { host: null, forbidden: Boolean(exists) };
  }

  /** 跳板机合法性：存在且归属本人、非自引用、非多级跳板、有已存凭据（none 无法自动认证） */
  async function validateJump(value, identity, selfId) {
    if (value.connectVia !== 'jump') return null;
    if (selfId && value.jumpHostId === selfId) return '跳板机不能是主机自身';
    const jump = await store.getHost(value.jumpHostId, identity.id);
    if (!jump) return '跳板机不存在或无权访问';
    if (jump.connectVia === 'jump') return '不支持多级跳板（跳板机本身须为直连）';
    if (!jump.secret) return '跳板机未保存凭据（「无」认证的主机不能作为跳板）';
    return null;
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
        const jumpErr = await validateJump(value, identity, null);
        if (jumpErr) return sendError(res, 422, 'invalid_jump', jumpErr);
        const now = new Date().toISOString();
        const entry = {
          id: await nextHostId(store, value.name), // 设备 ID = 会话名称
          name: value.name,
          host: value.host,
          port: value.port,
          username: value.username,
          authType: value.authType,
          connectVia: value.connectVia ?? 'direct',
          jumpHostId: value.connectVia === 'jump' ? value.jumpHostId : null,
          // none（不记录凭据）：不存 secret，连接时手动输入
          secret: value.secret ? encryptSecret(masterKey, value.secret) : null,
          group: value.group ?? 'Default',
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

        // 更换认证方式必须同时提供新凭据（切到 none 除外：none 的本意就是清空凭据）
        if (value.authType && value.authType !== host.authType && value.authType !== 'none' && !value.secret) {
          return sendError(res, 422, 'credential_required', '更换认证方式必须同时提供新凭据');
        }
        const jumpErr = await validateJump(value, identity, id);
        if (jumpErr) return sendError(res, 422, 'invalid_jump', jumpErr);

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
          ...(value.connectVia !== undefined ? { connectVia: value.connectVia } : {}),
          // 直连时清空跳板引用；未提交 connectVia 时保持原值
          ...(value.connectVia === 'jump'
            ? { jumpHostId: value.jumpHostId }
            : value.connectVia === 'direct'
              ? { jumpHostId: null }
              : {}),
          ...(value.secret ? { secret: encryptSecret(masterKey, value.secret) } : {}),
          // 切到 none：清空已保存凭据（不记录密码/密钥）
          ...(value.authType === 'none' ? { secret: null } : {}),
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
          id: await nextHostId(store, `${host.name} 副本`),
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
      // 连接时临时输入的私钥口令 → 换一次性 WS 票据（口令不经 URL）；
      // remember=true 时把口令并入加密凭据持久保存（AES-256-GCM，与私钥同级保护）
      method: 'POST',
      path: '/api/hosts/{id}/connect-secret',
      handler: async (req, res, ctx) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        const id = ctx.params.id;
        const { host, forbidden } = await requireHost(id, identity.id);
        if (forbidden) return sendError(res, 403, 'forbidden', '无权访问该资源');
        if (!host) return sendError(res, 404, 'not_found', '主机不存在');
        if (host.authType === 'password') {
          return sendError(res, 422, 'not_supported', '该主机已保存密码，无需连接凭据票据');
        }
        let body;
        try {
          body = await readJsonBody(req);
        } catch (e) {
          return sendError(res, 422, 'invalid_json', e.message);
        }
        // privateKey → 私钥口令；none（不记录凭据）→ 本次连接的密码
        const isNone = host.authType === 'none';
        const passphrase = isNone ? undefined : body?.passphrase;
        const password = isNone ? body?.password : undefined;
        if (!isNone && (typeof passphrase !== 'string' || passphrase === '')) {
          return sendError(res, 422, 'invalid_field', 'passphrase 必须为非空字符串');
        }
        if (isNone && (typeof password !== 'string' || password === '')) {
          return sendError(res, 422, 'invalid_field', 'password 必须为非空字符串');
        }
        if (isNone && body?.remember === true) {
          return sendError(res, 422, 'not_supported', '不记录凭据的主机不支持记住密码');
        }
        if (body?.remember === true) {
          const secret = decryptSecret(masterKey, host.secret);
          secret.passphrase = passphrase;
          await store.touchHost(id, {
            secret: encryptSecret(masterKey, secret),
            updatedAt: new Date().toISOString(),
          });
          audit?.log({
            actor: identity.id,
            actorType: 'user',
            hostId: id,
            hostAddress: host.host,
            authType: host.authType,
            event: 'credential-update',
            result: 'success',
            reason: 'remember-passphrase',
          });
        }
        const ticket = createPassTicket({ hostId: id, ownerId: identity.id, passphrase, password });
        sendJson(res, 200, { ticket });
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

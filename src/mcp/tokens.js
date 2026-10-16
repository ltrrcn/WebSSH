// MCP 令牌（FR-022~029）：明文仅创建时展示一次，SHA-256 摘要不可逆保存
import { createHash, randomBytes } from 'node:crypto';
import { randomUUID } from 'node:crypto';

export function generateTokenPlain() {
  return `mcp_${randomBytes(24).toString('hex')}`;
}

export function hashToken(plain) {
  return createHash('sha256').update(String(plain)).digest('hex');
}

/**
 * 创建令牌记录（明文只返回这一次）。
 * @returns {{record: object, plaintext: string}}
 */
export async function createTokenRecord(store, { ownerId, name, level, hostScope, hostGroups, allHosts, permissions, expiresAt }) {
  const plaintext = generateTokenPlain();
  const now = new Date().toISOString();
  const record = {
    id: `t_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    name,
    ownerId,
    tokenHash: hashToken(plaintext),
    // 提示片段：mcp_ 前缀 + 前两位随机 + * + 后四位随机（如 mcp_a1*1234）；随机部分仅暴露 24bit，无暴力面
    tokenHint: `${plaintext.slice(0, 6)}*${plaintext.slice(-4)}`,
    level,
    hostScope,
    // 按分组授权（动态）：分组下新增主机自动附带权限；分组按 name 引用（default 为内置）
    hostGroups: Array.isArray(hostGroups) ? hostGroups : [],
    // 动态授权：开启后授权本人全部主机（含后续新增），hostScope 仅作记录
    allHosts: allHosts === true,
    permissions,
    expiresAt: expiresAt ?? null,
    status: 'active',
    rateLimit: null,
    createdAt: now,
    lastUsedAt: null,
  };
  return { record, plaintext };
}

/**
 * 校验令牌：摘要比对 + 状态 + 有效期；通过即更新 lastUsedAt。
 * @returns {Promise<{ok: true, token: object} | {ok: false, reason: string}>}
 */
export async function authenticateToken(store, plain) {
  if (typeof plain !== 'string' || plain.length === 0 || plain.length > 256) {
    return { ok: false, reason: 'invalid' };
  }
  const tokens = await store.listTokensAll();
  const token = tokens.find((t) => t.tokenHash === hashToken(plain));
  if (!token) return { ok: false, reason: 'invalid' };
  if (token.status === 'revoked') return { ok: false, reason: 'revoked' };
  if (token.expiresAt && Date.now() > Date.parse(token.expiresAt)) {
    await store.touchToken(token.id, { status: 'expired' }).catch(() => {});
    return { ok: false, reason: 'expired' };
  }
  try {
    await store.touchToken(token.id, { lastUsedAt: new Date().toISOString() });
  } catch {
    /* 更新使用时间失败不阻断认证 */
  }
  return { ok: true, token };
}

/** 公开视图（绝不返回 tokenHash） */
export function publicTokenView(t) {
  return {
    id: t.id,
    name: t.name,
    level: t.level,
    hostScope: t.hostScope,
    hostGroups: t.hostGroups ?? [],
    allHosts: t.allHosts === true,
    expiresAt: t.expiresAt,
    status: t.status,
    tokenHint: t.tokenHint,
    createdAt: t.createdAt,
    lastUsedAt: t.lastUsedAt ?? null,
  };
}

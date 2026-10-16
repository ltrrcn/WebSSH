// T033：种子主机脚本——直接写 hosts.json（含加密凭据），使 US1 可独立于 US2 界面验证
import { loadOrCreateMasterKey } from '../../src/crypto/master-key.js';
import { encryptSecret } from '../../src/crypto/secret.js';
import { createFileStore } from '../../src/store/file-store.js';

/**
 * 向指定配置目录写入一台种子主机。
 * @param {{configDir: string, id?: string, host?: string, port?: number, username?: string,
 *   authType?: 'password'|'privateKey', password?: string, privateKey?: string, passphrase?: string,
 *   fingerprint?: string|null, ownerId?: string, group?: string|null, name?: string,
 *   connectVia?: 'direct'|'jump', jumpHostId?: string|null}} opts
 */
export async function seedHost(opts) {
  const {
    configDir,
    id = 'h_seed',
    host = '127.0.0.1',
    port = 22,
    username = 'test',
    authType,
    password,
    privateKey,
    passphrase,
    fingerprint = null,
    ownerId = 'local',
    group = null,
    name,
    connectVia = 'direct',
    jumpHostId = null,
  } = opts;

  // authType 未显式给出时按提供的凭据推断，避免加密出空对象
  const resolvedAuthType = authType ?? (privateKey ? 'privateKey' : 'password');
  if (resolvedAuthType === 'password' && !password) {
    throw new Error('seedHost: password 认证必须提供 password');
  }
  if (resolvedAuthType === 'privateKey' && !privateKey) {
    throw new Error('seedHost: privateKey 认证必须提供 privateKey');
  }

  const key = await loadOrCreateMasterKey(configDir);
  const store = createFileStore({ configDir });
  const now = new Date().toISOString();
  const plain =
    resolvedAuthType === 'password' ? { password } : { privateKey, passphrase };

  const entry = {
    id,
    name: name ?? `seed-${id}`,
    host,
    port,
    username,
    authType: resolvedAuthType,
    connectVia,
    jumpHostId: connectVia === 'jump' ? jumpHostId : null,
    // none（不记录凭据）：不存 secret
    secret: resolvedAuthType === 'none' ? null : encryptSecret(key, plain),
    group,
    ownerId,
    fingerprint,
    fingerprintConfirmedAt: fingerprint ? now : null,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
  };
  await store.upsertHost(entry);
  return entry;
}

// 凭据加解密：AES-256-GCM（research R7 / 宪法 I）
// GCM authTag 提供完整性校验——密文或标签被篡改时解密必须抛错，不得静默返回数据。
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALG = 'aes-256-gcm';

/**
 * 加密凭据对象（{ password } 或 { privateKey, passphrase }）。
 * @param {Buffer} key 32 字节主密钥
 * @param {object} plain 明文凭据对象
 * @returns {{alg:string, iv:string, tag:string, data:string}} 可 JSON 序列化的密文结构
 */
export function encryptSecret(key, plain) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('encryptSecret: 主密钥必须为 32 字节 Buffer');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key, iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(plain), 'utf8'),
    cipher.final(),
  ]);
  return {
    alg: ALG,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

/**
 * 解密凭据。密文被篡改（authTag 校验失败）时抛错——视为配置损坏，绝不回退明文。
 * @param {Buffer} key
 * @param {{alg:string, iv:string, tag:string, data:string}} secret
 * @returns {object} 明文凭据对象
 */
export function decryptSecret(key, secret) {
  if (!secret || secret.alg !== ALG) {
    throw new Error('不支持的凭据加密算法，视为配置损坏');
  }
  const decipher = createDecipheriv(ALG, key, Buffer.from(secret.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(secret.tag, 'base64'));
  const out = Buffer.concat([
    decipher.update(Buffer.from(secret.data, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(out.toString('utf8'));
}

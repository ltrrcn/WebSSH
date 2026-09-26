import { test } from 'node:test';
import assert from 'node:assert';
import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from '../helpers/tmpdir.js';

import { loadOrCreateMasterKey } from '../../src/crypto/master-key.js';
import { encryptSecret, decryptSecret } from '../../src/crypto/secret.js';

test('主密钥：首次生成 32 字节，文件权限 0700', async () => {
  const { dir, cleanup } = await makeTempDir('webssh-key-');
  try {
    const key = await loadOrCreateMasterKey(dir);
    assert.equal(key.length, 32);
    const st = await stat(join(dir, 'master.key'));
    assert.equal(st.mode & 0o777, 0o700, 'master.key 应为 0700');
  } finally {
    await cleanup();
  }
});

test('主密钥：二次加载复用同一密钥（不重新生成）', async () => {
  const { dir, cleanup } = await makeTempDir('webssh-key-');
  try {
    const k1 = await loadOrCreateMasterKey(dir);
    const k2 = await loadOrCreateMasterKey(dir);
    assert.deepEqual(k1, k2);
  } finally {
    await cleanup();
  }
});

test('AES-256-GCM：口令凭据加解密往返，结构含 alg/iv/tag/data', async () => {
  const { dir, cleanup } = await makeTempDir('webssh-key-');
  try {
    const key = await loadOrCreateMasterKey(dir);
    const enc = encryptSecret(key, { password: 'hunter2' });
    assert.equal(enc.alg, 'aes-256-gcm');
    assert.ok(enc.iv && enc.tag && enc.data);
    // 密文中不得出现明文
    const raw = JSON.stringify(enc);
    assert.ok(!raw.includes('hunter2'), '密文结构中不得出现明文口令');
    const dec = decryptSecret(key, enc);
    assert.deepEqual(dec, { password: 'hunter2' });
  } finally {
    await cleanup();
  }
});

test('AES-256-GCM：私钥 + passphrase 加解密往返', async () => {
  const { dir, cleanup } = await makeTempDir('webssh-key-');
  try {
    const key = await loadOrCreateMasterKey(dir);
    const plain = { privateKey: '-----BEGIN PRIVATE KEY-----\nxyz\n-----END PRIVATE KEY-----', passphrase: 'p' };
    const dec = decryptSecret(key, encryptSecret(key, plain));
    assert.deepEqual(dec, plain);
  } finally {
    await cleanup();
  }
});

test('GCM 完整性：密文被篡改时解密必须失败（不得静默返回错误数据）', async () => {
  const { dir, cleanup } = await makeTempDir('webssh-key-');
  try {
    const key = await loadOrCreateMasterKey(dir);
    const enc = encryptSecret(key, { password: 'hunter2' });
    const tampered = JSON.parse(JSON.stringify(enc));
    // 翻转密文最后一个字符
    tampered.data = tampered.data.slice(0, -2) + (tampered.data.endsWith('A') ? 'B' : 'A');
    assert.throws(() => decryptSecret(key, tampered));
  } finally {
    await cleanup();
  }
});

test('GCM 完整性：authTag 被篡改时解密必须失败', async () => {
  const { dir, cleanup } = await makeTempDir('webssh-key-');
  try {
    const key = await loadOrCreateMasterKey(dir);
    const enc = encryptSecret(key, { password: 'hunter2' });
    const tampered = JSON.parse(JSON.stringify(enc));
    tampered.tag = Buffer.from('0'.repeat(24)).toString('base64');
    assert.throws(() => decryptSecret(key, tampered));
  } finally {
    await cleanup();
  }
});

test('主密钥文件内容为原始随机字节（非 base64 等可读编码）', async () => {
  const { dir, cleanup } = await makeTempDir('webssh-key-');
  try {
    const key = await loadOrCreateMasterKey(dir);
    const onDisk = await readFile(join(dir, 'master.key'));
    assert.equal(onDisk.length, 32);
    assert.deepEqual(onDisk, key);
  } finally {
    await cleanup();
  }
});

import { test } from 'node:test';
import assert from 'node:assert';
import { join } from 'node:path';
import { makeTempDir } from '../helpers/tmpdir.js';

// FR-001 / FR-009 / FR-020：主机只能来自授权清单，且只能访问自己名下的条目
import { createFileStore } from '../../src/store/file-store.js';

function hostEntry(id, ownerId, over = {}) {
  return {
    id,
    name: `host-${id}`,
    host: '127.0.0.1',
    port: 22,
    username: 'u',
    authType: 'password',
    secret: { alg: 'aes-256-gcm', iv: 'a', tag: 'b', data: 'c' },
    group: null,
    ownerId,
    fingerprint: null,
    fingerprintConfirmedAt: null,
    createdAt: '2026-09-26T00:00:00.000Z',
    updatedAt: '2026-09-26T00:00:00.000Z',
    lastUsedAt: null,
    ...over,
  };
}

async function seedStore(hosts) {
  const { dir, cleanup } = await makeTempDir('webssh-store-');
  const store = createFileStore({ configDir: dir });
  await store.saveHosts(hosts);
  return { store, cleanup, dir };
}

test('FR-001/FR-020: 主机不在清单 → 查询结果为 undefined（后续连接必被拒）', async () => {
  const { store, cleanup } = await seedStore([hostEntry('h1', '1000')]);
  try {
    assert.equal(await store.getHost('h_nonexistent', '1000'), undefined);
  } finally {
    await cleanup();
  }
});

test('FR-009: 不属当前使用者的主机条目 → 不可见（视同不存在）', async () => {
  const { store, cleanup } = await seedStore([
    hostEntry('h1', '1000'),
    hostEntry('h2', '2000'),
  ]);
  try {
    assert.ok(await store.getHost('h1', '1000'), '本人条目可见');
    assert.equal(await store.getHost('h2', '1000'), undefined, '他人条目不可见');
    assert.equal(await store.getHost('h1', '2000'), undefined, '他人视角下本人条目不可见');
  } finally {
    await cleanup();
  }
});

test('FR-009: listHosts 只返回当前使用者的主机', async () => {
  const { store, cleanup } = await seedStore([
    hostEntry('h1', '1000'),
    hostEntry('h2', '2000'),
    hostEntry('h3', '1000'),
  ]);
  try {
    const mine = await store.listHosts('1000');
    assert.deepEqual(mine.map((h) => h.id).sort(), ['h1', 'h3']);
  } finally {
    await cleanup();
  }
});

test('host 字段校验：host 含分隔符/空白、port 越界、authType 非法 → 拒绝（FR-004）', async () => {
  const { dir, cleanup } = await makeTempDir('webssh-store-');
  try {
    const store = createFileStore({ configDir: dir });
    const base = () => hostEntry('hx', '1000');
    assert.throws(() => store.validateHost({ ...base(), host: 'a b' }), /host/);
    assert.throws(() => store.validateHost({ ...base(), host: 'a;b' }), /host/);
    assert.throws(() => store.validateHost({ ...base(), host: 'a|b' }), /host/);
    assert.throws(() => store.validateHost({ ...base(), port: 0 }), /port/);
    assert.throws(() => store.validateHost({ ...base(), port: 65536 }), /port/);
    assert.throws(() => store.validateHost({ ...base(), authType: 'agent' }), /authType/);
    assert.throws(() => store.validateHost({ ...base(), name: '' }), /name/);
    assert.throws(() => store.validateHost({ ...base(), username: '' }), /username/);
    // 合法条目通过
    assert.ok(store.validateHost(base()));
  } finally {
    await cleanup();
  }
});

test('写操作持久化：保存后重新创建 store 仍可读取（跨进程持久化）', async () => {
  const { dir, cleanup } = await makeTempDir('webssh-store-');
  try {
    const s1 = createFileStore({ configDir: dir });
    await s1.saveHosts([hostEntry('h1', '1000')]);
    const s2 = createFileStore({ configDir: dir });
    const h = await s2.getHost('h1', '1000');
    assert.equal(h.id, 'h1');
    assert.equal(s1.hostsFile, join(dir, 'hosts.json'));
  } finally {
    await cleanup();
  }
});

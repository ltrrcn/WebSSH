// 分组管理契约测试（contracts/rest-api.md 分组节）：
// 分组是主机 group 字段的集合视图；删除分组 = 组内主机 group 置回 null（凭据保留，绝不连带删除）
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from '../../src/net/server.js';
import { seedHost } from '../helpers/seed-host.js';

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'webssh-groups-'));
  const app = await startApp({
    env: { WEBSSH_HOME: dir },
    config: { standalone: { bind: '127.0.0.1', port: 0 }, security: { allowedOrigins: [] } },
  });
  const base = `http://127.0.0.1:${app.port}`;
  const cleanup = async () => app.close();
  return { app, base, cleanup, dir };
}

async function seedGroup(dir, name, ids) {
  for (const id of ids) {
    await seedHost({ configDir: join(dir, 'etc'), id, name: `n-${id}`, password: `pw-${id}`, group: name });
  }
}

test('PUT /api/groups/{name} 重命名：组内主机 group 全部更新', async () => {
  const { app, base, cleanup, dir } = await setup();
  try {
    await seedGroup(dir, '生产', ['a1', 'a2']);
    await seedGroup(dir, '测试', ['b1']);
    const res = await fetch(`${base}/api/groups/${encodeURIComponent('生产')}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newName: '生产环境' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, moved: 2 });
    const hosts = await (await fetch(`${base}/api/hosts`)).json();
    const a1 = hosts.find((h) => h.id === 'a1');
    assert.equal(a1.group, '生产环境');
    assert.equal(hosts.find((h) => h.id === 'b1').group, '测试');
  } finally {
    await cleanup();
  }
});

test('PUT 重命名到已存在分组名 → 两组合并', async () => {
  const { base, cleanup, dir } = await setup();
  try {
    await seedGroup(dir, 'g1', ['x1']);
    await seedGroup(dir, 'g2', ['x2']);
    const res = await fetch(`${base}/api/groups/${encodeURIComponent('g1')}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newName: 'g2' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).moved, 1);
    const hosts = await (await fetch(`${base}/api/hosts`)).json();
    assert.ok(hosts.every((h) => h.group === 'g2'));
  } finally {
    await cleanup();
  }
});

test('PUT 缺少 newName / newName 非法 → 422', async () => {
  const { base, cleanup } = await setup();
  try {
    const r1 = await fetch(`${base}/api/groups/${encodeURIComponent('g')}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(r1.status, 422);
    const r2 = await fetch(`${base}/api/groups/${encodeURIComponent('g')}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newName: '' }),
    });
    assert.equal(r2.status, 422);
    const r3 = await fetch(`${base}/api/groups/${encodeURIComponent('g')}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newName: 42 }),
    });
    assert.equal(r3.status, 422);
  } finally {
    await cleanup();
  }
});

test('DELETE /api/groups/{name}：组内主机移回默认分组，凭据保留', async () => {
  const { app, base, cleanup, dir } = await setup();
  try {
    await seedGroup(dir, '临时', ['c1', 'c2']);
    const before = await app.deps.store.getHost('c1', 'local');
    const res = await fetch(`${base}/api/groups/${encodeURIComponent('临时')}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, moved: 2 });
    // 主机仍存在、group 归 null、凭据原样
    const after = await app.deps.store.getHost('c1', 'local');
    assert.ok(after, '主机未被删除');
    assert.equal(after.group, null);
    assert.deepEqual(after.secret, before.secret);
  } finally {
    await cleanup();
  }
});

test('DELETE 空分组 / 不存在的分组 → 幂等成功 moved 0', async () => {
  const { base, cleanup } = await setup();
  try {
    const res = await fetch(`${base}/api/groups/${encodeURIComponent('不存在')}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, moved: 0 });
  } finally {
    await cleanup();
  }
});

test('「默认」分组（null）不可重命名或删除 → 422', async () => {
  const { base, cleanup } = await setup();
  try {
    const r = await fetch(`${base}/api/groups/${encodeURIComponent('默认')}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newName: 'x' }),
    });
    assert.equal(r.status, 422);
    const d = await fetch(`${base}/api/groups/${encodeURIComponent('默认')}`, { method: 'DELETE' });
    assert.equal(d.status, 422);
  } finally {
    await cleanup();
  }
});

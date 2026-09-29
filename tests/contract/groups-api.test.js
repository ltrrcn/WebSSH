// 分组管理契约测试：分组为独立实体（groups.json），内置 Default 分组恒为第一项；
// 删除分组 = 删实体 + 组内主机 group 归 'Default'（凭据保留，绝不连带删除）
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

const post = (base, path, body) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const put = (base, path, body) =>
  fetch(`${base}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('GET /api/groups：内置 default 恒为第一项，含主机计数', async () => {
  const { base, cleanup, dir } = await setup();
  try {
    await seedGroup(dir, '生产', ['a1', 'a2']);
    await post(base, '/api/groups', { name: '生产' }); // 实体化
    const { groups } = await (await fetch(`${base}/api/groups`)).json();
    assert.equal(groups[0].name, 'Default');
    assert.equal(groups[0].builtin, true);
    const prod = groups.find((g) => g.name === '生产');
    assert.equal(prod.count, 2);
  } finally {
    await cleanup();
  }
});

test('POST /api/groups：新建分组成功；重名/保留名/空名 → 422', async () => {
  const { base, cleanup } = await setup();
  try {
    const r = await post(base, '/api/groups', { name: '测试环境' });
    assert.equal(r.status, 201);
    assert.equal((await r.json()).name, '测试环境');
    assert.equal((await post(base, '/api/groups', { name: '测试环境' })).status, 422, '重名拒绝');
    assert.equal((await post(base, '/api/groups', { name: 'Default' })).status, 422, '内置名拒绝');
    assert.equal((await post(base, '/api/groups', { name: '默认' })).status, 422, '历史保留名拒绝');
    assert.equal((await post(base, '/api/groups', { name: '  ' })).status, 422, '空白名拒绝');
  } finally {
    await cleanup();
  }
});

test('PUT /api/groups/reorder：排序持久化，列表按顺序返回', async () => {
  const { base, cleanup } = await setup();
  try {
    await post(base, '/api/groups', { name: 'g-a' });
    await post(base, '/api/groups', { name: 'g-b' });
    await post(base, '/api/groups', { name: 'g-c' });
    let { groups } = await (await fetch(`${base}/api/groups`)).json();
    assert.deepEqual(groups.map((g) => g.name), ['Default', 'g-a', 'g-b', 'g-c']);

    const r = await put(base, '/api/groups/reorder', { order: ['g-c', 'g-a', 'g-b'] });
    assert.equal(r.status, 200);
    ({ groups } = await (await fetch(`${base}/api/groups`)).json());
    assert.deepEqual(groups.map((g) => g.name), ['Default', 'g-c', 'g-a', 'g-b'], 'Default 恒定第一');

    // default 不允许参与排序
    assert.equal((await put(base, '/api/groups/reorder', { order: ['Default', 'g-a'] })).status, 422);
  } finally {
    await cleanup();
  }
});

test('PUT /api/groups/{name} 重命名：实体改名 + 组内主机迁移', async () => {
  const { base, cleanup, dir } = await setup();
  try {
    await seedGroup(dir, '生产', ['a1', 'a2']);
    await seedGroup(dir, '测试', ['b1']);
    await post(base, '/api/groups', { name: '生产' });
    const res = await put(base, `/api/groups/${encodeURIComponent('生产')}`, { newName: '生产环境' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, moved: 2 });
    const hosts = await (await fetch(`${base}/api/hosts`)).json();
    assert.equal(hosts.find((h) => h.id === 'a1').group, '生产环境');
    assert.equal(hosts.find((h) => h.id === 'b1').group, '测试');
    const { groups } = await (await fetch(`${base}/api/groups`)).json();
    assert.ok(groups.some((g) => g.name === '生产环境'));
    assert.ok(!groups.some((g) => g.name === '生产'), '旧名实体已改名');
  } finally {
    await cleanup();
  }
});

test('PUT 重命名到已存在分组名 → 两组合并（源实体删除，主机并入）', async () => {
  const { base, cleanup, dir } = await setup();
  try {
    await seedGroup(dir, 'g1', ['x1']);
    await seedGroup(dir, 'g2', ['x2']);
    await post(base, '/api/groups', { name: 'g1' });
    await post(base, '/api/groups', { name: 'g2' });
    const res = await put(base, '/api/groups/g1', { newName: 'g2' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).moved, 1);
    const hosts = await (await fetch(`${base}/api/hosts`)).json();
    assert.ok(hosts.every((h) => h.group === 'g2'));
    const { groups } = await (await fetch(`${base}/api/groups`)).json();
    assert.equal(groups.filter((g) => g.name === 'g2').length, 1, '合并后只剩一个实体');
  } finally {
    await cleanup();
  }
});

test('PUT 缺少 newName / newName 非法 → 422', async () => {
  const { base, cleanup } = await setup();
  try {
    for (const body of ['{}', '{"newName":""}', '{"newName":42}']) {
      const r = await fetch(`${base}/api/groups/g`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body,
      });
      assert.equal(r.status, 422, body);
    }
  } finally {
    await cleanup();
  }
});

test('DELETE /api/groups/{name}：删实体，组内主机移回 default，凭据保留', async () => {
  const { app, base, cleanup, dir } = await setup();
  try {
    await seedGroup(dir, '临时', ['c1', 'c2']);
    await post(base, '/api/groups', { name: '临时' });
    const before = await app.deps.store.getHost('c1', 'local');
    const res = await fetch(`${base}/api/groups/${encodeURIComponent('临时')}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, moved: 2 });
    // 主机仍存在、group 归 default、凭据原样
    const after = await app.deps.store.getHost('c1', 'local');
    assert.ok(after, '主机未被删除');
    assert.equal(after.group, 'Default');
    assert.deepEqual(after.secret, before.secret);
    // 实体已删除
    const { groups } = await (await fetch(`${base}/api/groups`)).json();
    assert.ok(!groups.some((g) => g.name === '临时'));
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

test('内置 default 与历史「默认」保留名不可重命名或删除 → 422', async () => {
  const { base, cleanup } = await setup();
  try {
    for (const name of ['Default', '默认']) {
      const r = await put(base, `/api/groups/${encodeURIComponent(name)}`, { newName: 'x' });
      assert.equal(r.status, 422, `${name} 不可重命名`);
      const d = await fetch(`${base}/api/groups/${encodeURIComponent(name)}`, { method: 'DELETE' });
      assert.equal(d.status, 422, `${name} 不可删除`);
    }
  } finally {
    await cleanup();
  }
});

test('新建主机默认归入 Default 分组', async () => {
  const { base, cleanup } = await setup();
  try {
    const res = await post(base, '/api/hosts', {
      name: '默认组主机', host: '127.0.0.1', port: 22, username: 'root',
      authType: 'password', password: 'pw-x',
    });
    assert.equal(res.status, 201);
    const host = await res.json();
    assert.equal(host.group, 'Default', '未传分组时应归入 Default');
  } finally {
    await cleanup();
  }
});

// T042：主机 CRUD 契约（contracts/rest-api.md）
// 越权 403 且不暴露资源存在性；任何响应不得含明文凭据或 secret 结构
import { test } from 'node:test';
import assert from 'node:assert';
import { makeTempDir } from '../helpers/tmpdir.js';
import { seedHost } from '../helpers/seed-host.js';
import { startApp } from '../../src/net/server.js';

async function setup() {
  const { dir, cleanup } = await makeTempDir('webssh-hosts-');
  const app = await startApp({
    env: { WEBSSH_HOME: dir },
    config: {
      standalone: { bind: '127.0.0.1', port: 0 },
      limits: { sessionsPerUser: 10 },
    },
  });
  return { app, cleanup, base: `http://127.0.0.1:${app.port}` };
}

const SECRET_PW = 'super-secret-pw-123';

function createBody(over = {}) {
  return {
    name: '测试主机',
    host: '127.0.0.1',
    port: 22,
    username: 'root',
    authType: 'password',
    password: SECRET_PW,
    group: '测试组',
    ...over,
  };
}

test('POST /api/hosts 创建主机 → 201，响应不含 secret 与明文凭据', async () => {
  const { app, cleanup, base } = await setup();
  try {
    const res = await fetch(`${base}/api/hosts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody()),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.id, '应返回生成的 id');
    const text = JSON.stringify(body);
    assert.ok(!('secret' in body), '响应不得包含 secret 结构');
    assert.ok(!text.includes(SECRET_PW), '响应不得包含明文口令');
    assert.equal(body.hasSecret, true);
    // 落盘内容必须是密文结构
    const host = await app.deps.store.getHost(body.id, 'local');
    assert.equal(host.secret.alg, 'aes-256-gcm');
    assert.ok(!JSON.stringify(host.secret).includes(SECRET_PW));
  } finally {
    await app.close();
    await cleanup();
  }
});

test('GET /api/hosts 与 /api/hosts/{id} 返回条目（无凭据）', async () => {
  const { app, cleanup, base } = await setup();
  try {
    const created = await (await fetch(`${base}/api/hosts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody()),
    })).json();

    const list = await (await fetch(`${base}/api/hosts`)).json();
    assert.ok(list.some((h) => h.id === created.id));

    const one = await (await fetch(`${base}/api/hosts/${created.id}`)).json();
    assert.equal(one.id, created.id);
    assert.equal(one.name, '测试主机');
    assert.ok(!('secret' in one));
    assert.ok(!JSON.stringify(one).includes(SECRET_PW));
  } finally {
    await app.close();
    await cleanup();
  }
});

test('PUT /api/hosts/{id}：改名生效；不传凭据保持不变', async () => {
  const { app, cleanup, base } = await setup();
  try {
    const created = await (await fetch(`${base}/api/hosts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody()),
    })).json();
    const before = await app.deps.store.getHost(created.id, 'local');

    const res = await fetch(`${base}/api/hosts/${created.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '新名字' }),
    });
    assert.equal(res.status, 200);
    const after = await app.deps.store.getHost(created.id, 'local');
    assert.equal(after.name, '新名字');
    assert.deepEqual(after.secret, before.secret, '不传凭据 → secret 保持不变');
  } finally {
    await app.close();
    await cleanup();
  }
});

test('PUT 修改目标地址 → 指纹重置为未确认（防新地址沿用旧指纹）', async () => {
  const { app, cleanup, base } = await setup();
  try {
    const created = await (await fetch(`${base}/api/hosts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody()),
    })).json();
    // 人为写入已确认指纹
    await app.deps.store.touchHost(created.id, { fingerprint: 'SHA256:old' });

    await fetch(`${base}/api/hosts/${created.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: '192.168.50.20' }),
    });
    const after = await app.deps.store.getHost(created.id, 'local');
    assert.equal(after.fingerprint, null, '地址变化后指纹必须重置');
    assert.equal(after.host, '192.168.50.20');
  } finally {
    await app.close();
    await cleanup();
  }
});

test('PUT 更换凭据 → secret 被替换', async () => {
  const { app, cleanup, base } = await setup();
  try {
    const created = await (await fetch(`${base}/api/hosts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody()),
    })).json();
    const before = (await app.deps.store.getHost(created.id, 'local')).secret;
    await fetch(`${base}/api/hosts/${created.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'brand-new-pw' }),
    });
    const after = (await app.deps.store.getHost(created.id, 'local')).secret;
    assert.notEqual(after.data, before.data, '凭据应被替换');
    assert.notEqual(after.iv, before.iv);
    assert.ok(!JSON.stringify(after).includes('brand-new-pw'));
  } finally {
    await app.close();
    await cleanup();
  }
});

test('DELETE /api/hosts/{id}：删除后不可见、不可连', async () => {
  const { app, cleanup, base } = await setup();
  try {
    const created = await (await fetch(`${base}/api/hosts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody()),
    })).json();
    const res = await fetch(`${base}/api/hosts/${created.id}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal((await fetch(`${base}/api/hosts/${created.id}`)).status, 404);
    const gone = await app.deps.store.getHost(created.id, 'local');
    assert.equal(gone, undefined, '凭据随主机一并删除');
  } finally {
    await app.close();
    await cleanup();
  }
});

test('非法字段 → 422，错误信息不含凭据', async () => {
  const { app, cleanup, base } = await setup();
  try {
    for (const bad of [
      { host: 'a b' }, { port: 0 }, { port: 70000 }, { authType: 'agent' },
      { username: '' }, { name: '' },
    ]) {
      const res = await fetch(`${base}/api/hosts`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createBody(bad)),
      });
      assert.equal(res.status, 422, `应 422: ${JSON.stringify(bad)}`);
      const err = await res.json();
      assert.ok(err.error?.code, '应返回结构化错误');
    }
  } finally {
    await app.close();
    await cleanup();
  }
});

test('越权访问他人主机 → 403，不暴露存在性与凭据（FR-009）', async () => {
  const { app, cleanup, base } = await setup();
  try {
    // 归属 other 用户的主机
    const dir = app.runtime.paths.config;
    const other = await seedHost({ configDir: dir, id: 'h_other', ownerId: 'someone-else', password: 'their-pw' });

    for (const [method, path] of [
      ['GET', `/api/hosts/${other.id}`],
      ['PUT', `/api/hosts/${other.id}`],
      ['DELETE', `/api/hosts/${other.id}`],
    ]) {
      const res = await fetch(`${base}${path}`, { method });
      assert.equal(res.status, 403, `${method} 他人主机应 403`);
      const text = await res.text();
      assert.ok(!text.includes('their-pw'), '不得泄露凭据');
    }
    // 列表中也看不到
    const list = await (await fetch(`${base}/api/hosts`)).json();
    assert.ok(!list.some((h) => h.id === other.id), '他人主机不可见');
  } finally {
    await app.close();
    await cleanup();
  }
});

test('POST /api/hosts/{id}/duplicate：复制连接（含凭据密文），生成独立「副本」（FR-056）', async () => {
  const { app, cleanup, base } = await setup();
  try {
    const created = await (await fetch(`${base}/api/hosts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody()),
    })).json();

    const res = await fetch(`${base}/api/hosts/${created.id}/duplicate`, { method: 'POST' });
    assert.equal(res.status, 200);
    const copy = await res.json();
    assert.notEqual(copy.id, created.id, '副本必须是独立条目');
    assert.equal(copy.name, '测试主机 副本');
    assert.equal(copy.hasSecret, true);
    assert.ok(!JSON.stringify(copy).includes(SECRET_PW), '副本响应不含明文');

    // 凭据密文原样复制，解密可用
    const src = await app.deps.store.getHost(created.id, 'local');
    const dup = await app.deps.store.getHost(copy.id, 'local');
    assert.deepEqual(dup.secret, src.secret);
    // 删除原条目不影响副本（独立性）
    await fetch(`${base}/api/hosts/${created.id}`, { method: 'DELETE' });
    const stillThere = await app.deps.store.getHost(copy.id, 'local');
    assert.ok(stillThere, '副本独立于原条目存在');
  } finally {
    await app.close();
    await cleanup();
  }
});

test('duplicate 越权/不存在：他人条目 403，不存在 404（FR-056）', async () => {
  const { app, cleanup, base } = await setup();
  try {
    const dir = app.runtime.paths.config;
    const other = await seedHost({ configDir: dir, id: 'h_other2', ownerId: 'someone-else', password: 'x' });
    const r1 = await fetch(`${base}/api/hosts/${other.id}/duplicate`, { method: 'POST' });
    assert.equal(r1.status, 403);
    const r2 = await fetch(`${base}/api/hosts/h_nonexistent/duplicate`, { method: 'POST' });
    assert.equal(r2.status, 404);
  } finally {
    await app.close();
    await cleanup();
  }
});

test('verify-hostkey：确认指纹后可连接前的状态翻转（FR-007）', async () => {
  const { app, cleanup, base } = await setup();
  try {
    const created = await (await fetch(`${base}/api/hosts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody()),
    })).json();

    // 未确认前
    let one = await (await fetch(`${base}/api/hosts/${created.id}`)).json();
    assert.equal(one.fingerprintConfirmed, false);

    // 确认指纹
    const res = await fetch(`${base}/api/hosts/${created.id}/verify-hostkey`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fingerprint: 'SHA256:testconfirmedfp0123456789' }),
    });
    assert.equal(res.status, 200);
    const host = await app.deps.store.getHost(created.id, 'local');
    assert.equal(host.fingerprint, 'SHA256:testconfirmedfp0123456789');
    assert.ok(host.fingerprintConfirmedAt);

    one = await (await fetch(`${base}/api/hosts/${created.id}`)).json();
    assert.equal(one.fingerprintConfirmed, true);
  } finally {
    await app.close();
    await cleanup();
  }
});

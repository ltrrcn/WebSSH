// 令牌重命名契约测试（R003 追加）：PUT /api/tokens/{id} —— 改名成功/非法值/404/权限隔离
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { makeTempDir } from '../helpers/tmpdir.js';
import { startApp } from '../../src/net/server.js';

async function makeApp() {
  const { dir, cleanup } = await makeTempDir('webssh-token-rename-');
  const app = await startApp({
    env: { WEBSSH_HOME: dir },
    config: { standalone: { bind: '127.0.0.1', port: 0 } },
  });
  return {
    base: `http://127.0.0.1:${app.port}`,
    cleanup: async () => {
      await app.close();
      await cleanup();
    },
  };
}

const json = (r) => r.json().catch(() => null);

describe('PUT /api/tokens/{id} 重命名', () => {
  let ctx;
  let tokenId;
  beforeEach(async () => {
    ctx = await makeApp();
    // 建一台主机 + 一个令牌（重命名的测试前置）
    const { base } = ctx;
    const hostRes = await fetch(`${base}/api/hosts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '测试机', host: '127.0.0.1', username: 'u', authType: 'none' }),
    });
    assert.equal(hostRes.status, 201);
    const host = await hostRes.json();
    const tokenRes = await fetch(`${base}/api/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '原名', level: 'readonly', hostScope: [host.id] }),
    });
    assert.equal(tokenRes.status, 201);
    tokenId = (await tokenRes.json()).id;
  });

  test('改名成功并 trim；空名/超长 422；不存在 404', async () => {
    const { base, cleanup } = ctx;
    try {
      const ok = await fetch(`${base}/api/tokens/${tokenId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '  新名字  ' }),
      });
      assert.equal(ok.status, 200);
      assert.equal((await ok.json()).name, '新名字');
      const list = await json(await fetch(`${base}/api/tokens`));
      assert.equal(list.find((t) => t.id === tokenId).name, '新名字');

      const blank = await fetch(`${base}/api/tokens/${tokenId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '' }),
      });
      assert.equal(blank.status, 422);
      const tooLong = await fetch(`${base}/api/tokens/${tokenId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'a'.repeat(65) }),
      });
      assert.equal(tooLong.status, 422);
      const missing = await fetch(`${base}/api/tokens/tk_nonexistent`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'x' }),
      });
      assert.equal(missing.status, 404);
    } finally {
      await cleanup();
    }
  });

  test('动态授权 allHosts：空 hostScope + allHosts 可创建并回读', async () => {
    const { base, cleanup } = ctx;
    try {
      const ok = await fetch(`${base}/api/tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '动态授权', level: 'readonly', hostScope: [], allHosts: true }),
      });
      assert.equal(ok.status, 201);
      const created = await ok.json();
      assert.equal(created.allHosts, true);
      const list = await json(await fetch(`${base}/api/tokens`));
      const rec = list.find((t) => t.id === created.id);
      assert.equal(rec.allHosts, true);
      assert.deepEqual(rec.hostScope, []);
    } finally {
      await cleanup();
    }
  });

  test('按分组授权：hostGroups 创建/回读；非法分组 422', async () => {
    const { base, cleanup } = ctx;
    try {
      const ok = await fetch(`${base}/api/tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '分组授权', level: 'readonly', hostScope: [], hostGroups: ['default'] }),
      });
      assert.equal(ok.status, 201);
      const created = await ok.json();
      assert.deepEqual(created.hostGroups, ['default']);
      const list = await json(await fetch(`${base}/api/tokens`));
      assert.deepEqual(list.find((t) => t.id === created.id).hostGroups, ['default']);

      const bad = await fetch(`${base}/api/tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '非法分组', level: 'readonly', hostScope: [], hostGroups: ['不存在'] }),
      });
      assert.equal(bad.status, 422);
    } finally {
      await cleanup();
    }
  });

  test('恢复撤销令牌：revoked → restore → active；active 恢复 422', async () => {
    const { base, cleanup } = ctx;
    try {
      const revoke = await fetch(`${base}/api/tokens/${tokenId}`, { method: 'DELETE' });
      assert.equal(revoke.status, 200);
      let list = await json(await fetch(`${base}/api/tokens`));
      assert.equal(list.find((t) => t.id === tokenId).status, 'revoked');

      const restore = await fetch(`${base}/api/tokens/${tokenId}/restore`, { method: 'PUT' });
      assert.equal(restore.status, 200);
      list = await json(await fetch(`${base}/api/tokens`));
      assert.equal(list.find((t) => t.id === tokenId).status, 'active');

      const dupRestore = await fetch(`${base}/api/tokens/${tokenId}/restore`, { method: 'PUT' });
      assert.equal(dupRestore.status, 422);
      assert.equal((await dupRestore.json()).error.code, 'not_revoked');
    } finally {
      await cleanup();
    }
  });
});

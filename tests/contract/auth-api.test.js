import { test } from 'node:test';
import assert from 'node:assert';
import { makeTempDir } from '../helpers/tmpdir.js';

// contracts/rest-api.md：GET /api/auth/me —— 返回当前请求者身份，未认证 401
import { startApp } from '../../src/net/server.js';

test('GET /api/auth/me（standalone）恒返回本地单用户 local', async () => {
  const { dir, cleanup } = await makeTempDir('webssh-auth-api-');
  let app;
  try {
    app = await startApp({ env: { WEBSSH_HOME: dir }, config: { standalone: { bind: '127.0.0.1', port: 0 } } });
    const res = await fetch(`http://127.0.0.1:${app.port}/api/auth/me`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    const body = await res.json();
    assert.equal(body.id, 'local');
    assert.equal(body.username, 'local');
    assert.equal(body.isAdmin, true);
  } finally {
    if (app) await app.close();
    await cleanup();
  }
});

test('GET /api/auth/me 响应不含敏感字段（密钥/凭据/绝对路径）', async () => {
  const { dir, cleanup } = await makeTempDir('webssh-auth-api-');
  let app;
  try {
    app = await startApp({ env: { WEBSSH_HOME: dir }, config: { standalone: { bind: '127.0.0.1', port: 0 } } });
    const res = await fetch(`http://127.0.0.1:${app.port}/api/auth/me`);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['id', 'isAdmin', 'username']);
    const text = JSON.stringify(body);
    assert.ok(!text.includes(dir), '不得包含数据目录路径');
  } finally {
    if (app) await app.close();
    await cleanup();
  }
});

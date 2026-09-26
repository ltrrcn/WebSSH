import { test } from 'node:test';
import assert from 'node:assert';
import { makeTempDir } from '../helpers/tmpdir.js';

// contracts/rest-api.md：GET /api/runtime —— 返回运行模式与监听形态，不含具体路径
import { startApp } from '../../src/net/server.js';

test('GET /api/runtime 返回 mode 与监听形态（standalone/tcp）', async () => {
  const { dir, cleanup } = await makeTempDir('webssh-runtime-api-');
  let app;
  try {
    app = await startApp({ env: { WEBSSH_HOME: dir }, config: { standalone: { bind: '127.0.0.1', port: 0 } } });
    const res = await fetch(`http://127.0.0.1:${app.port}/api/runtime`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    const body = await res.json();
    assert.equal(body.mode, 'standalone');
    assert.equal(body.listen, 'tcp');
  } finally {
    if (app) await app.close();
    await cleanup();
  }
});

test('GET /api/runtime 响应不含任何具体文件系统路径', async () => {
  const { dir, cleanup } = await makeTempDir('webssh-runtime-api-');
  let app;
  try {
    app = await startApp({ env: { WEBSSH_HOME: dir }, config: { standalone: { bind: '127.0.0.1', port: 0 } } });
    const res = await fetch(`http://127.0.0.1:${app.port}/api/runtime`);
    const text = await res.text();
    assert.ok(!text.includes(dir), '不得包含数据目录路径');
    assert.ok(!/\/|\\\\/.test(text), '不得包含路径分隔符（仅枚举值）');
  } finally {
    if (app) await app.close();
    await cleanup();
  }
});

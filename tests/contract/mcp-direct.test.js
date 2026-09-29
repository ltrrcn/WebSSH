// MCP 机器直连端口（双模式通用）：standalone 下热启停与 /mcp 独立端口可达性
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from '../../src/net/server.js';

async function setup(config) {
  const dir = await mkdtemp(join(tmpdir(), 'webssh-mcpd-'));
  const app = await startApp({
    env: { WEBSSH_HOME: dir },
    config: {
      standalone: { bind: '127.0.0.1', port: 0 },
      security: { allowedOrigins: [] },
      ...config,
    },
  });
  return { app, base: `http://127.0.0.1:${app.port}`, cleanup: async () => app.close() };
}

test('standalone：默认无直连端口；PUT 开启后热监听，仅 /mcp 可达', async (t) => {
  const { app, base, cleanup } = await setup();
  t.after(cleanup);
  try {
    // 默认关闭
    const before = await (await fetch(`${base}/api/mcp-direct`)).json();
    assert.equal(before.mode, 'standalone');
    assert.equal(before.enabled, false);
    assert.equal(before.running, false);

    // 开启（默认 0.0.0.0，测试用回环避免防火墙弹窗）
    const put = await fetch(`${base}/api/mcp-direct`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, bind: '127.0.0.1', port: 18422 }),
    });
    assert.equal(put.status, 200);
    const state = await put.json();
    assert.equal(state.enabled, true);
    assert.equal(state.running, true);

    // 独立端口仅提供 /mcp：其他路径 404
    const r1 = await fetch('http://127.0.0.1:18422/mcp', { method: 'POST' });
    assert.equal(r1.status, 401, '/mcp 无令牌应 401（鉴权层拦截）');
    const r2 = await fetch('http://127.0.0.1:18422/api/hosts');
    assert.equal(r2.status, 404, 'REST 不暴露');

    // 关闭后端口不可达
    const off = await fetch(`${base}/api/mcp-direct`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false, bind: '127.0.0.1', port: 18422 }),
    });
    assert.equal(off.status, 200);
    assert.equal((await off.json()).running, false);
    await new Promise((r) => setTimeout(r, 200));
    await assert.rejects(() => fetch('http://127.0.0.1:18422/mcp'), '关闭后应不可达');
  } finally {
    await cleanup();
  }
});

test('standalone：config.mcpDirect.enabled=true 启动即监听（顶层键）', async (t) => {
  const { app, base, cleanup } = await setup({
    mcpDirect: { enabled: true, bind: '127.0.0.1', port: 18423 },
  });
  t.after(cleanup);
  try {
    const state = await (await fetch(`${base}/api/mcp-direct`)).json();
    assert.equal(state.enabled, true);
    assert.equal(state.running, true, '启动即监听');
    const r = await fetch('http://127.0.0.1:18423/mcp', { method: 'POST' });
    assert.equal(r.status, 401);
  } finally {
    await cleanup();
  }
});

test('standalone：旧版 fnos.mcpDirect 配置仍兼容读取', async (t) => {
  const { app, base, cleanup } = await setup({
    fnos: { mcpDirect: { enabled: true, bind: '127.0.0.1', port: 18424 } },
  });
  t.after(cleanup);
  try {
    const state = await (await fetch(`${base}/api/mcp-direct`)).json();
    assert.equal(state.enabled, true);
    assert.equal(state.running, true);
  } finally {
    await cleanup();
  }
});

test('自定义 MCP 地址：保存/清空/非法值校验（反代场景端点）', async (t) => {
  const { app, base, cleanup } = await setup();
  t.after(cleanup);
  try {
    // 保存合法地址
    const put = await fetch(`${base}/api/mcp-direct`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false, customEndpoint: 'https://proxy.example.com/mcp' }),
    });
    assert.equal(put.status, 200);
    const state = await put.json();
    assert.equal(state.customEndpoint, 'https://proxy.example.com/mcp');

    // 回读一致
    const get = await (await fetch(`${base}/api/mcp-direct`)).json();
    assert.equal(get.customEndpoint, 'https://proxy.example.com/mcp');

    // 清空恢复默认
    const clear = await fetch(`${base}/api/mcp-direct`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false, customEndpoint: '' }),
    });
    assert.equal((await clear.json()).customEndpoint, '');

    // 非法值拒绝：非 URL / 非 http(s) / 含凭据
    for (const bad of ['not-a-url', 'ftp://x.com/mcp', 'https://user:pw@example.com/mcp']) {
      const r = await fetch(`${base}/api/mcp-direct`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false, customEndpoint: bad }),
      });
      assert.equal(r.status, 422, `应拒绝: ${bad}`);
    }
  } finally {
    await cleanup();
  }
});;

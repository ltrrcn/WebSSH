// T030：/ws/terminal 握手与关闭码契约（contracts/ws-terminal.md）
import { test } from 'node:test';
import assert from 'node:assert';
import { makeTempDir } from '../helpers/tmpdir.js';
import { seedHost } from '../helpers/seed-host.js';
import { startApp } from '../../src/net/server.js';
import WebSocket from 'ws';

/**
 * 连接 WS 并等待终态：close(code) 或 unexpected-response(status)。
 * 注意：4004/4006 等关闭码发生在升级成功（open）之后，因此不提前 resolve。
 */
function connectWs(url, origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { origin });
    ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode }));
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    ws.on('error', (err) => resolve({ code: undefined, error: String(err.message) }));
  });
}

async function setup(extraConfig = {}, hosts = []) {
  const { dir, cleanup } = await makeTempDir('webssh-ws-');
  const env = { WEBSSH_HOME: dir };
  const config = {
    standalone: { bind: '127.0.0.1', port: 0 },
    limits: { sessionsPerUser: 10, connectTimeoutMs: 1500, idleTimeoutMs: 60000 },
    security: { allowedOrigins: [] },
    ...extraConfig,
  };
  for (const h of hosts) await seedHost({ configDir: `${dir}/etc`, ...h });
  const app = await startApp({ env, config });
  return { app, cleanup, base: `http://127.0.0.1:${app.port}`, wsBase: `ws://127.0.0.1:${app.port}` };
}

const GOOD_ORIGIN_SUFFIX = 'origin-ok';

test('握手：未授权 Origin → HTTP 403', async () => {
  const { app, cleanup, wsBase } = await setup();
  try {
    const r = await connectWs(`${wsBase}/ws/terminal?hostId=h1&version=1`, 'http://evil.example');
    assert.equal(r.status, 403);
  } finally {
    await app.close();
    await cleanup();
  }
});

test('握手：缺失 version 参数 → HTTP 400（宪法 VIII）', async () => {
  const { app, cleanup, wsBase } = await setup();
  try {
    const origin = `http://127.0.0.1:${app.port}`;
    const r = await connectWs(`${wsBase}/ws/terminal?hostId=h1`, origin);
    assert.equal(r.status, 400);
  } finally {
    await app.close();
    await cleanup();
  }
});

test('握手：不支持的 version → HTTP 400', async () => {
  const { app, cleanup, wsBase } = await setup();
  try {
    const origin = `http://127.0.0.1:${app.port}`;
    const r = await connectWs(`${wsBase}/ws/terminal?hostId=h1&version=2`, origin);
    assert.equal(r.status, 400);
  } finally {
    await app.close();
    await cleanup();
  }
});

test('握手：不允许的查询参数（host）→ HTTP 400，禁止客户端指定目标', async () => {
  const { app, cleanup, wsBase } = await setup();
  try {
    const origin = `http://127.0.0.1:${app.port}`;
    const r = await connectWs(`${wsBase}/ws/terminal?hostId=h1&version=1&host=1.2.3.4`, origin);
    assert.equal(r.status, 400);
  } finally {
    await app.close();
    await cleanup();
  }
});

test('关闭码 4003：主机不在授权清单（FR-020）', async () => {
  const { app, cleanup, wsBase } = await setup();
  try {
    const origin = `http://127.0.0.1:${app.port}`;
    const r = await connectWs(`${wsBase}/ws/terminal?hostId=h_unknown&version=1`, origin);
    assert.equal(r.code, 4003);
  } finally {
    await app.close();
    await cleanup();
  }
});

test('关闭码 4005：主机指纹未确认（FR-007，禁止静默接受）', async () => {
  const { app, cleanup, wsBase } = await setup({}, [
    { id: 'h_unconf', host: '127.0.0.1', port: 1, password: 'unused', fingerprint: null },
  ]);
  try {
    const origin = `http://127.0.0.1:${app.port}`;
    const r = await connectWs(`${wsBase}/ws/terminal?hostId=h_unconf&version=1`, origin);
    assert.equal(r.code, 4005);
    assert.ok(r.reason.includes('fingerprint'), `reason 应说明指纹问题，实际: ${r.reason}`);
  } finally {
    await app.close();
    await cleanup();
  }
});

test('关闭码 4004：超出并发会话上限（FR-019）', async () => {
  const { app, cleanup, wsBase } = await setup({ limits: { sessionsPerUser: 0 } }, [
    { id: 'h_conf', host: '127.0.0.1', port: 1, password: 'unused', fingerprint: 'SHA256:fake' },
  ]);
  try {
    const origin = `http://127.0.0.1:${app.port}`;
    const r = await connectWs(`${wsBase}/ws/terminal?hostId=h_conf&version=1`, origin);
    assert.equal(r.code, 4004);
  } finally {
    await app.close();
    await cleanup();
  }
});

test('关闭码 4006：连接失败（目标不可达）且错误信息不含凭据', async () => {
  const { app, cleanup, wsBase } = await setup({}, [
    { id: 'h_dead', host: '127.0.0.1', port: 1, password: 'secret-value-xyz', fingerprint: 'SHA256:fake' },
  ]);
  try {
    const origin = `http://127.0.0.1:${app.port}`;
    const r = await connectWs(`${wsBase}/ws/terminal?hostId=h_dead&version=1`, origin);
    assert.equal(r.code, 4006);
    assert.ok(!r.reason.includes('secret-value-xyz'), '错误信息不得包含明文凭据');
  } finally {
    await app.close();
    await cleanup();
  }
});

test('审计：连接尝试与失败均产生记录（FR-010）', async () => {
  const { app, cleanup, wsBase, base } = await setup({}, [
    { id: 'h_dead', host: '127.0.0.1', port: 1, password: 'pw', fingerprint: 'SHA256:fake' },
  ]);
  try {
    const origin = `http://127.0.0.1:${app.port}`;
    await connectWs(`${wsBase}/ws/terminal?hostId=h_dead&version=1`, origin);
    // 审计异步写入，等待落盘
    await new Promise((r) => setTimeout(r, 300));
    const events = await app.deps.audit.listAll();
    const attempt = events.find((e) => e.event === 'connect-attempt');
    const failure = events.find((e) => e.event === 'connect-failure');
    assert.ok(attempt, '应有 connect-attempt 记录');
    assert.ok(failure, '应有 connect-failure 记录');
    assert.equal(failure.result, 'error');
  } finally {
    await app.close();
    await cleanup();
  }
});

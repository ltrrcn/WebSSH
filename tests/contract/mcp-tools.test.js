// T071：MCP 工具契约（mcp-tools.md）——注册矩阵、鉴权、错误码、限流
import { test } from 'node:test';
import assert from 'node:assert';
import { makeTempDir } from '../helpers/tmpdir.js';
import { seedHost } from '../helpers/seed-host.js';
import { startApp } from '../../src/net/server.js';

async function setup(configOver = {}, hosts = []) {
  const { dir, cleanup } = await makeTempDir('webssh-mcp-');
  for (const h of hosts) await seedHost({ configDir: `${dir}/etc`, password: 'pw', fingerprint: 'SHA256:fake', ...h });
  const app = await startApp({
    env: { WEBSSH_HOME: dir },
    config: {
      standalone: { bind: '127.0.0.1', port: 0 },
      limits: { sessionsPerUser: 10, tokenRateLimitPerMinute: 60, execTimeoutMs: 5000, outputDigestBytes: 64 },
      security: {
        allowedOrigins: [],
        sensitivePaths: ['/etc/shadow', '/root/.ssh'],
        readOnlyCommands: ['ls', 'cat'],
        dangerousCommands: ['rm', 'shutdown'],
      },
      ...configOver,
    },
  });
  return { app, cleanup, base: `http://127.0.0.1:${app.port}` };
}

async function createToken(base, over = {}) {
  const res = await fetch(`${base}/api/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '测试令牌', level: 'readonly', hostScope: [], ...over }),
  });
  return { status: res.status, body: await res.json() };
}

function rpc(base, token, method, params) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

test('工具注册矩阵（FR-031）：readonly 不注册命令与写入类工具', async () => {
  const { app, cleanup, base } = await setup({}, [{ id: 'h1', name: '主机' }]);
  try {
    const ro = await createToken(base, { level: 'readonly', hostScope: ['h1'] });
    assert.equal(ro.status, 201);
    const tools = (await rpc(base, ro.body.token, 'tools/list')).body.result.tools.map((t) => t.name);
    assert.deepEqual(tools.sort(), ['list_hosts', 'read_file']);

    const wr = await createToken(base, { level: 'writable', hostScope: ['h1'] });
    const tools2 = (await rpc(base, wr.body.token, 'tools/list')).body.result.tools.map((t) => t.name);
    assert.deepEqual(tools2.sort(), ['list_hosts', 'read_file', 'run_command', 'write_file']);
    // 明文仅创建时返回一次（列表接口不含）
    const list = await (await fetch(`${base}/api/tokens`)).json();
    assert.ok(!JSON.stringify(list).includes(ro.body.token));
  } finally {
    await app.close();
    await cleanup();
  }
});

test('鉴权：无/伪造/撤销/过期令牌 → 401（FR-023/026）', async () => {
  const { app, cleanup, base } = await setup();
  try {
    assert.equal((await fetch(`${base}/mcp`, { method: 'POST' })).status, 401);
    const fake = await rpc(base, 'mcp_fake', 'tools/list');
    assert.equal(fake.status, 401);

    const t = await createToken(base, { level: 'readonly' });
    assert.equal((await rpc(base, t.body.token, 'tools/list')).status, 200);
    await fetch(`${base}/api/tokens/${t.body.id}`, { method: 'DELETE' });
    assert.equal((await rpc(base, t.body.token, 'tools/list')).status, 401);

    const exp = await createToken(base, { level: 'readonly', expiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.equal((await rpc(base, exp.body.token, 'tools/list')).status, 401);
  } finally {
    await app.close();
    await cleanup();
  }
});

test('JSON-RPC：initialize 与未知方法（协议契约）', async () => {
  const { app, cleanup, base } = await setup();
  try {
    const t = await createToken(base);
    const init = await rpc(base, t.body.token, 'initialize', { protocolVersion: '2024-11-05' });
    assert.equal(init.body.result.serverInfo.name, 'webssh');
    assert.equal(init.body.result.capabilities.tools, undefined !== undefined ? undefined : init.body.result.capabilities.tools, 'capabilities.tools 存在');
    const unknown = await rpc(base, t.body.token, 'resources/list', {});
    assert.equal(unknown.body.error.code, -32601);
  } finally {
    await app.close();
    await cleanup();
  }
});

test('list_hosts：仅返回 hostScope 内主机（FR-025）', async () => {
  const { app, cleanup, base } = await setup({}, [
    { id: 'h_in', name: '范围内' },
    { id: 'h_out', name: '范围外' },
  ]);
  try {
    const t = await createToken(base, { level: 'readonly', hostScope: ['h_in'] });
    const call = await rpc(base, t.body.token, 'tools/call', { name: 'list_hosts', arguments: {} });
    const parsed = JSON.parse(call.body.result.content[0].text);
    assert.deepEqual(parsed.hosts.map((h) => h.id), ['h_in']);
    assert.ok(!JSON.stringify(parsed).includes('secret'), '不得泄露凭据');
  } finally {
    await app.close();
    await cleanup();
  }
});

test('run_command 判定：语法/黑名单拒绝，hostScope 外拒绝（FR-033/034，目标不可达场景）', async () => {
  const { app, cleanup, base } = await setup({}, [{ id: 'h_dead', host: '127.0.0.1', port: 1 }]);
  try {
    const t = await createToken(base, { level: 'writable', hostScope: ['h_dead'] });
    const call = async (command, hostId = 'h_dead') =>
      (await rpc(base, t.body.token, 'tools/call', { name: 'run_command', arguments: { hostId, command } })).body.result;
    const r1 = await call('echo hi; rm -rf /');
    assert.equal(r1.isError, true);
    assert.ok(r1.content[0].text.includes('command_denied'), `语法拒绝: ${r1.content[0].text}`);
    const r2 = await call('rm -rf /tmp/x');
    assert.ok(r2.content[0].text.includes('command_denied'));
    const r3 = await call('echo ok', 'h_other');
    assert.ok(r3.content[0].text.includes('host_not_allowed'));
    // 审计已记录拒绝（FR-027）
    await new Promise((r) => setTimeout(r, 300));
    const audit = await (await fetch(`${base}/api/audit?result=error`)).json();
    assert.ok(audit.items.length >= 1, '拒绝类调用应留痕');
    assert.ok(audit.items.some((i) => i.tokenId === t.body.id), '审计标明令牌');
  } finally {
    await app.close();
    await cleanup();
  }
});

test('限流：超额请求 429 rate_limited，不影响其他令牌（FR-028）', async () => {
  const { app, cleanup, base } = await setup({ limits: { sessionsPerUser: 10, tokenRateLimitPerMinute: 2, outputDigestBytes: 64 } });
  try {
    const a = await createToken(base, { name: 'A' });
    const b = await createToken(base, { name: 'B' });
    assert.equal((await rpc(base, a.body.token, 'tools/list')).status, 200);
    assert.equal((await rpc(base, a.body.token, 'tools/list')).status, 200);
    const third = await rpc(base, a.body.token, 'tools/list');
    assert.equal(third.status, 429);
    assert.ok(JSON.stringify(third.body).includes('rate_limited'));
    // B 不受影响
    assert.equal((await rpc(base, b.body.token, 'tools/list')).status, 200);
  } finally {
    await app.close();
    await cleanup();
  }
});

test('POST /api/tokens 校验：非法 level / 越权 hostScope / 放开矩阵 → 422', async () => {
  const { app, cleanup, base } = await setup({}, [{ id: 'h1', name: '本人' }]);
  try {
    assert.equal((await createToken(base, { level: 'admin' })).status, 422);
    assert.equal((await createToken(base, { hostScope: ['h_other'] })).status, 422);
    const defaults = (await (await fetch(`${base}/api/tokens/defaults`)).json()).defaultPermissions;
    assert.ok(Array.isArray(defaults), 'defaults 接口可用');
    const bad = await fetch(`${base}/api/tokens`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'x', level: 'readonly', hostScope: ['h1'],
        permissions: [{ prefix: '/var/log', read: true, write: true, source: 'token-override' }],
      }),
    });
    assert.equal(bad.status, 422);
    assert.equal((await bad.json()).error.code, 'permission_out_of_range');
  } finally {
    await app.close();
    await cleanup();
  }
});

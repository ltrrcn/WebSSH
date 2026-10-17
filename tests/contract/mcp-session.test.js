// MCP 会话 ID（Streamable HTTP Mcp-Session-Id）：initialize 生成 → 回传贯穿审计 → sessions 聚合归组
import { test } from 'node:test';
import assert from 'node:assert';
import { makeTempDir } from '../helpers/tmpdir.js';
import { startApp } from '../../src/net/server.js';

async function setup() {
  const { dir, cleanup } = await makeTempDir('webssh-mcpsess-');
  const app = await startApp({
    env: { WEBSSH_HOME: dir },
    config: {
      standalone: { bind: '127.0.0.1', port: 0 },
      limits: { sessionsPerUser: 10, tokenRateLimitPerMinute: 120, execTimeoutMs: 5000, outputDigestBytes: 64 },
      security: { allowedOrigins: [], sensitivePaths: [], readOnlyCommands: ['ls'], dangerousCommands: ['rm'] },
    },
  });
  const base = `http://127.0.0.1:${app.port}`;
  const res = await fetch(`${base}/api/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '测试令牌', level: 'writable', hostScope: [] }),
  });
  const { token } = await res.json();
  return { app, cleanup, base, token };
}

function rpc(base, token, method, params, headers = {}) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.json() }));
}

test('initialize：返回 Mcp-Session-Id 响应头并记录 mcp-session-start', async () => {
  const { app, cleanup, base, token } = await setup();
  try {
    const init = await rpc(base, token, 'initialize', { protocolVersion: '2024-11-05' });
    const sid = init.headers.get('mcp-session-id');
    assert.match(sid, /^m_[0-9a-f]{12}$/, '会话 ID 格式 m_<12hex>');
    // JSON-RPC 响应体不含会话信息（仅经响应头传递）
    assert.equal(JSON.stringify(init.body).includes(sid), false);

    await new Promise((r) => setTimeout(r, 200));
    const audit = await (await fetch(`${base}/api/audit?source=mcp`)).json();
    const start = audit.items.find((e) => e.event === 'mcp-session-start');
    assert.ok(start, 'mcp-session-start 事件已落盘');
    assert.equal(start.sessionId, sid);
    assert.ok(start.tokenId, '事件标明令牌');
  } finally {
    await app.close();
    await cleanup();
  }
});

test('tools/call 携带会话头：审计事件 sessionId 与会话一致', async () => {
  const { app, cleanup, base, token } = await setup();
  try {
    const sid = (await rpc(base, token, 'initialize', {})).headers.get('mcp-session-id');
    await rpc(base, token, 'tools/call', { name: 'list_hosts', arguments: {} }, { 'mcp-session-id': sid });
    await new Promise((r) => setTimeout(r, 200));
    const audit = await (await fetch(`${base}/api/audit?source=mcp`)).json();
    const cmd = audit.items.find((e) => e.event === 'command');
    assert.ok(cmd, '命令事件已落盘');
    assert.equal(cmd.sessionId, sid, '命令事件归属该 MCP 会话');
  } finally {
    await app.close();
    await cleanup();
  }
});

test('无会话头/非法会话头：sessionId 为 null（向后兼容）', async () => {
  const { app, cleanup, base, token } = await setup();
  try {
    await rpc(base, token, 'tools/call', { name: 'list_hosts', arguments: {} });
    await rpc(base, token, 'tools/call', { name: 'list_hosts', arguments: {} }, { 'mcp-session-id': 'm_ZZZZZZZZZZZZ' });
    await rpc(base, token, 'tools/call', { name: 'list_hosts', arguments: {} }, { 'mcp-session-id': 'garbage<script>' });
    await new Promise((r) => setTimeout(r, 200));
    const audit = await (await fetch(`${base}/api/audit?source=mcp&category=commands`)).json();
    assert.equal(audit.items.length, 3);
    assert.ok(audit.items.every((e) => e.sessionId === null), '非法/缺失会话头一律视为无会话');
  } finally {
    await app.close();
    await cleanup();
  }
});

test('DELETE /mcp：204 并记录 mcp-session-end', async () => {
  const { app, cleanup, base, token } = await setup();
  try {
    const sid = (await rpc(base, token, 'initialize', {})).headers.get('mcp-session-id');
    const del = await fetch(`${base}/mcp`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}`, 'mcp-session-id': sid },
    });
    assert.equal(del.status, 204);
    // 无鉴权的 DELETE → 401
    const anon = await fetch(`${base}/mcp`, { method: 'DELETE' });
    assert.equal(anon.status, 401);
    await new Promise((r) => setTimeout(r, 200));
    const audit = await (await fetch(`${base}/api/audit?source=mcp`)).json();
    const end = audit.items.find((e) => e.event === 'mcp-session-end');
    assert.ok(end, 'mcp-session-end 事件已落盘');
    assert.equal(end.sessionId, sid);
  } finally {
    await app.close();
    await cleanup();
  }
});

test('/api/audit/sessions：MCP 会话归组（source=mcp、命令数、endedAt），null 不成组', async () => {
  const { app, cleanup, base, token } = await setup();
  try {
    const sid = (await rpc(base, token, 'initialize', {})).headers.get('mcp-session-id');
    await rpc(base, token, 'tools/call', { name: 'list_hosts', arguments: {} }, { 'mcp-session-id': sid });
    await rpc(base, token, 'tools/call', { name: 'list_hosts', arguments: {} }); // 无会话头（旧客户端）
    await fetch(`${base}/mcp`, { method: 'DELETE', headers: { authorization: `Bearer ${token}`, 'mcp-session-id': sid } });
    await new Promise((r) => setTimeout(r, 300));

    const { sessions } = await (await fetch(`${base}/api/audit/sessions`)).json();
    const mcp = sessions.find((s) => s.sessionId === sid);
    assert.ok(mcp, 'MCP 会话出现在会话聚合视图');
    assert.equal(mcp.source, 'mcp');
    assert.equal(mcp.commandCount, 1, '仅统计成功命令');
    assert.ok(mcp.endedAt, 'DELETE 结束时间已记录');
    assert.equal(mcp.online, false, 'MCP 会话无在线态');
    assert.ok(mcp.tokenId, 'MCP 会话标明令牌');
    // 会话视图按创建时间倒序混排（MCP 与用户会话同列）
    const ts = sessions.map((x) => x.createdAt);
    assert.deepEqual(ts, [...ts].sort().reverse());
  } finally {
    await app.close();
    await cleanup();
  }
});

test('多次 initialize：各自成组，纯握手会话不进会话列表但审计保留', async () => {
  const { app, cleanup, base, token } = await setup();
  try {
    const s1 = (await rpc(base, token, 'initialize', {})).headers.get('mcp-session-id');
    const s2 = (await rpc(base, token, 'initialize', {})).headers.get('mcp-session-id');
    assert.notEqual(s1, s2);
    await rpc(base, token, 'tools/call', { name: 'list_hosts', arguments: {} }, { 'mcp-session-id': s2 });
    await new Promise((r) => setTimeout(r, 200));
    const { sessions } = await (await fetch(`${base}/api/audit/sessions`)).json();
    assert.ok(!sessions.some((s) => s.sessionId === s1), '纯握手（无工具调用）的 MCP 会话不出现在会话列表');
    assert.ok(sessions.some((s) => s.sessionId === s2 && s.commandCount === 1), '会话 2 独立归组');
    // 审计数据保留：握手事件仍在事件流中（操作审计可见）
    const audit = await (await fetch(`${base}/api/audit?source=mcp`)).json();
    assert.ok(audit.items.some((e) => e.event === 'mcp-session-start' && e.sessionId === s1), '握手事件仍保留在审计流');
  } finally {
    await app.close();
    await cleanup();
  }
});

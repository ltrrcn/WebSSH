// FR-059：断线保活（detached）与重新接管（attach）
// 异常断线（刷新/关窗口/网络闪断）不再立即释放 SSH：会话挂起等待同一用户接管；
// 客户端主动关闭（1000）仍立即释放，接管不存在/已释放的会话返回 4007。
import { test } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';
import { makeTempDir } from '../helpers/tmpdir.js';
import { startSshd } from '../helpers/sshd.js';
import { startApp } from '../../src/net/server.js';
import { seedHost } from '../helpers/seed-host.js';
import { encodeDataFrame } from '../../web/src/protocol/frames.js';
import WebSocket from 'ws';

const execFileAsync = promisify(execFile);

function connectWs(url, origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { origin });
    // 建连即收集：服务端在 open 后立刻下发会话元信息帧，晚于此刻注册的监听会漏掉
    const early = [];
    ws.on('message', (data) => early.push(Buffer.from(data)));
    ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode }));
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    ws.on('error', (err) => resolve({ code: undefined, error: String(err.message) }));
    ws.on('open', () => resolve({ open: true, ws, early }));
  });
}

/** 从已收到的帧里找会话元信息帧（0x03） */
function findMeta(bufs) {
  for (const b of bufs) {
    if (b[0] === 0x03) return JSON.parse(b.subarray(1).toString('utf8'));
  }
  return null;
}

const awaitClose = (r) =>
  r.code !== undefined || r.status !== undefined
    ? Promise.resolve(r)
    : new Promise((resolve) => r.ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));

async function setup(limits) {
  const sshd = await startSshd();
  const { dir, cleanup } = await makeTempDir('webssh-detach-');
  const app = await startApp({
    env: { WEBSSH_HOME: dir },
    config: {
      standalone: { bind: '127.0.0.1', port: 0 },
      limits: { sessionsPerUser: 10, connectTimeoutMs: 8000, ...limits },
      security: { allowedOrigins: [] },
    },
  });
  const { stdout } = await execFileAsync('ssh-keygen', ['-lf', `${sshd.hostKey}.pub`]);
  const fp = stdout.match(/(SHA256:[^\s]+)/)[1];
  await seedHost({
    configDir: `${dir}/etc`,
    id: 'h_ssh',
    host: '127.0.0.1',
    port: sshd.port,
    username: userInfo().username,
    privateKey: await readFile(sshd.clientKey, 'utf8'),
    fingerprint: fp,
  });
  return { app, cleanup, sshd, wsBase: `ws://127.0.0.1:${app.port}` };
}

const sessionsUrl = (app) => `http://127.0.0.1:${app.port}/api/sessions`;

async function waitSessions(app, n, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const list = await (await fetch(sessionsUrl(app))).json();
    if (Array.isArray(list) && list.length === n && list.every((s) => s.state === 'ready')) return list;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`等待 ${n} 个 ready 会话超时`);
}

async function waitSessionState(app, state, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const list = await (await fetch(sessionsUrl(app))).json();
    const hit = list.find((s) => s.state === state);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

async function waitSessionsEmpty(app, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const list = await (await fetch(sessionsUrl(app))).json();
    if (Array.isArray(list) && list.length === 0) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/** 累积下行数据帧文本（0x00），用于断言接管后仍能收到远端输出 */
function collectData(ws) {
  const acc = { text: '' };
  ws.on('message', (data) => {
    const buf = Buffer.from(data);
    if (buf[0] === 0x00) acc.text += buf.subarray(1).toString('utf8');
  });
  return acc;
}

test('异常断线 → 会话挂起保活，可用 sessionId 重新接管', async (t) => {
  const { app, cleanup, sshd, wsBase } = await setup();
  const origin = `http://127.0.0.1:${app.port}`;
  t.after(async () => {
    await app.close();
    await cleanup();
    await sshd.stop();
  });

  const r = await connectWs(`${wsBase}/ws/terminal?hostId=h_ssh&version=1`, origin);
  assert.ok(r.open, `应能连接: ${JSON.stringify({ code: r.code, reason: r.reason })}`);
  const [s0] = await waitSessions(app, 1);
  await new Promise((x) => setTimeout(x, 300));
  r.ws.terminate(); // 模拟刷新/关窗口/网络闪断

  const held = await waitSessionState(app, 'detached');
  assert.ok(held, '异常断线后会话应挂起为 detached');
  assert.equal(held.id, s0.id, '挂起的仍是原会话');

  // 重新接管：握手携带 sessionId
  const r2 = await connectWs(
    `${wsBase}/ws/terminal?hostId=h_ssh&version=1&sessionId=${encodeURIComponent(s0.id)}`,
    origin
  );
  assert.ok(r2.open, `接管应成功: ${JSON.stringify({ code: r2.code, reason: r2.reason })}`);
  await new Promise((x) => setTimeout(x, 500)); // 等待服务端下发的元信息帧
  const meta = findMeta(r2.early);
  assert.equal(meta?.sessionId, s0.id, '接管的会话 ID 不变');
  const after = await waitSessions(app, 1);
  assert.equal(after[0].state, 'ready', '接管后会话回到 ready');

  const acc = collectData(r2.ws);
  r2.ws.send(encodeDataFrame('echo resume-ok\r'), { binary: true });
  await new Promise((x) => setTimeout(x, 1500));
  assert.match(acc.text, /resume-ok/, '接管后的会话应能继续执行命令');
});

test('主动关闭（1000）不保活：立即释放，再接管返回 4007', async (t) => {
  const { app, cleanup, sshd, wsBase } = await setup();
  const origin = `http://127.0.0.1:${app.port}`;
  t.after(async () => {
    await app.close();
    await cleanup();
    await sshd.stop();
  });

  const r = await connectWs(`${wsBase}/ws/terminal?hostId=h_ssh&version=1`, origin);
  assert.ok(r.open);
  const [s0] = await waitSessions(app, 1);
  r.ws.close(1000);
  assert.ok(await waitSessionsEmpty(app), '主动关闭应立即释放会话');

  const r2 = await connectWs(
    `${wsBase}/ws/terminal?hostId=h_ssh&version=1&sessionId=${encodeURIComponent(s0.id)}`,
    origin
  );
  const closed = await awaitClose(r2);
  assert.equal(closed.code, 4007, '已释放的会话不可接管');
});

test('接管不存在的会话 → 关闭码 4007', async (t) => {
  const { app, cleanup, sshd, wsBase } = await setup();
  const origin = `http://127.0.0.1:${app.port}`;
  t.after(async () => {
    await app.close();
    await cleanup();
    await sshd.stop();
  });

  const r = await connectWs(
    `${wsBase}/ws/terminal?hostId=h_ssh&version=1&sessionId=S00000000000000`,
    origin
  );
  const closed = await awaitClose(r);
  assert.equal(closed.code, 4007);
});

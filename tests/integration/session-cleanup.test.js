// T050：会话清理——关闭 WS / 网络断开 / 空闲超时后零残留（SC-005 / FR-013）
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
import WebSocket from 'ws';

const execFileAsync = promisify(execFile);

/** sshd 每个连接 fork 一个子进程；会话结束后子进程数应归零 */
async function sshdChildren(pid) {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-P', String(pid)]);
    return stdout.trim() ? stdout.trim().split('\n').length : 0;
  } catch {
    return 0; // pgrep 无匹配时退出码非 0
  }
}

function connectWs(url, origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { origin });
    ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode }));
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    ws.on('error', (err) => resolve({ code: undefined, error: String(err.message) }));
    ws.on('open', () => resolve({ open: true, ws }));
  });
}

const awaitClose = (r) =>
  r.code !== undefined || r.status !== undefined
    ? Promise.resolve(r)
    : new Promise((resolve) => r.ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));

async function setup(limits) {
  const sshd = await startSshd();
  const { dir, cleanup } = await makeTempDir('webssh-clean-');
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

async function waitSessionsEmpty(app, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const list = await (await fetch(`http://127.0.0.1:${app.port}/api/sessions`)).json();
    if (Array.isArray(list) && list.length === 0) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/** 等待活动会话数达到 n（会话注册与 SSH 建连是异步的） */
async function waitSessions(app, n, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const list = await (await fetch(`http://127.0.0.1:${app.port}/api/sessions`)).json();
    if (Array.isArray(list) && list.length === n) return list;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`等待会话数 ${n} 超时`);
}

/** 轮询等待 sshd 子进程归零 */
async function waitChildrenZero(pid, timeout = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if ((await sshdChildren(pid)) === 0) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

test('主动关闭标签页 → 服务端会话清空、sshd 子进程归零（SC-005）', async (t) => {
  const { app, cleanup, sshd, wsBase } = await setup();
  const origin = `http://127.0.0.1:${app.port}`;
  t.after(async () => {
    await app.close();
    await cleanup();
    await sshd.stop();
  });

  const r = await connectWs(`${wsBase}/ws/terminal?hostId=h_ssh&version=1`, origin);
  assert.ok(r.open, `应能连接: ${JSON.stringify({ code: r.code, reason: r.reason })}`);

  const sessions = await waitSessions(app, 1);
  assert.equal(sessions[0].state, 'ready');
  assert.equal(sessions[0].hostId, 'h_ssh');

  r.ws.close(1000);
  assert.ok(await waitSessionsEmpty(app), '会话应在数秒内清空');
  assert.ok(await waitChildrenZero(sshd.proc.pid), 'sshd 侧不应残留子进程');
});

test('网络断开（terminate）→ 同样零残留（FR-013）', async (t) => {
  const { app, cleanup, sshd, wsBase } = await setup();
  const origin = `http://127.0.0.1:${app.port}`;
  t.after(async () => {
    await app.close();
    await cleanup();
    await sshd.stop();
  });

  const r = await connectWs(`${wsBase}/ws/terminal?hostId=h_ssh&version=1`, origin);
  assert.ok(r.open);
  // 等会话真正建立（open ≠ ready），再模拟网络闪断
  await waitSessions(app, 1);
  await new Promise((r2) => setTimeout(r2, 500));
  r.ws.terminate(); // 模拟网络闪断（不发送关闭帧）
  assert.ok(await waitSessionsEmpty(app), '网络断开后会话应被清理');
  assert.ok(await waitChildrenZero(sshd.proc.pid), 'sshd 侧不应残留子进程');
});

test('空闲超时 → 关闭码 4010 + 原因 idle-timeout（FR-014）', async (t) => {
  const { app, cleanup, sshd, wsBase } = await setup({ idleTimeoutMs: 700 });
  const origin = `http://127.0.0.1:${app.port}`;
  t.after(async () => {
    await app.close();
    await cleanup();
    await sshd.stop();
  });

  const r = await connectWs(`${wsBase}/ws/terminal?hostId=h_ssh&version=1`, origin);
  assert.ok(r.open, `应能连接: ${JSON.stringify({ code: r.code, reason: r.reason })}`);
  const closed = await new Promise((resolve) =>
    r.ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
  );
  assert.equal(closed.code, 4010, '应收到空闲超时关闭码');
  assert.equal(closed.reason, 'idle-timeout');
  assert.ok(await waitSessionsEmpty(app));
  assert.ok(await waitChildrenZero(sshd.proc.pid));
});

test('DELETE /api/sessions/{id}：主动终止会话（T055）', async (t) => {
  const { app, cleanup, sshd, wsBase } = await setup();
  const origin = `http://127.0.0.1:${app.port}`;
  t.after(async () => {
    await app.close();
    await cleanup();
    await sshd.stop();
  });

  const r = await connectWs(`${wsBase}/ws/terminal?hostId=h_ssh&version=1`, origin);
  assert.ok(r.open);
  const closed = new Promise((resolve) =>
    r.ws.on('close', (code) => resolve(code))
  );

  const sessions = await waitSessions(app, 1);
  const del = await fetch(`http://127.0.0.1:${app.port}/api/sessions/${sessions[0].id}`, {
    method: 'DELETE',
  });
  assert.equal(del.status, 200);

  assert.equal(await closed, 1000, '客户端应收到正常关闭');
  assert.ok(await waitSessionsEmpty(app));
});

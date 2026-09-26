// T051：并发上限与多会话隔离（FR-019 / US3 场景 3）
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

function collector(ws) {
  let buf = '';
  ws.on('message', (d, isBin) => {
    if (isBin) {
      const b = Buffer.from(d);
      if (b[0] === 0) buf += b.subarray(1).toString();
    }
  });
  return {
    text: () => buf,
    has: (needle) => buf.includes(needle),
    wait: (needle, timeout = 8000) =>
      new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
          if (buf.includes(needle)) return resolve(true);
          if (Date.now() - start > timeout) {
            return reject(new Error(`等待 "${needle}" 超时`));
          }
          setTimeout(tick, 100);
        };
        tick();
      }),
  };
}

async function setup(limits) {
  const sshd = await startSshd();
  const { dir, cleanup } = await makeTempDir('webssh-limit-');
  const app = await startApp({
    env: { WEBSSH_HOME: dir },
    config: {
      standalone: { bind: '127.0.0.1', port: 0 },
      limits: { sessionsPerUser: 2, connectTimeoutMs: 8000, ...limits },
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

const openSession = (wsBase, origin) =>
  connectWs(`${wsBase}/ws/terminal?hostId=h_ssh&version=1`, origin);

test('并发上限：第 3 个会话被拒 4004，释放一个后可再开（FR-019）', async (t) => {
  const { app, cleanup, sshd, wsBase } = await setup();
  const origin = `http://127.0.0.1:${app.port}`;
  t.after(async () => {
    await app.close();
    await cleanup();
    await sshd.stop();
  });

  const a = await openSession(wsBase, origin);
  const b = await openSession(wsBase, origin);
  assert.ok(a.open && b.open, '前两个会话应可打开');

  const c = await openSession(wsBase, origin);
  const cc = await awaitClose(c);
  assert.equal(cc.code, 4004, '第三个会话应被拒绝');
  assert.equal(cc.reason, 'session_limit');

  // 关闭 A 后可再开
  a.ws.close(1000);
  await new Promise((r) => setTimeout(r, 1500));
  const d = await openSession(wsBase, origin);
  assert.ok(d.open, '释放后应可再次打开');
  b.ws.close(1000);
  d.ws.close(1000);
});

test('多会话互不影响：A 的命令输出不出现在 B（US3 场景 3）', async (t) => {
  const { app, cleanup, sshd, wsBase } = await setup();
  const origin = `http://127.0.0.1:${app.port}`;
  t.after(async () => {
    await app.close();
    await cleanup();
    await sshd.stop();
  });

  const a = await openSession(wsBase, origin);
  const b = await openSession(wsBase, origin);
  assert.ok(a.open && b.open);
  const outA = collector(a.ws);
  const outB = collector(b.ws);

  // 等两个 shell 都就绪（收到任意输出）再执行命令
  const waitReady = (c) =>
    new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (c.text().length > 0 || Date.now() - start > 5000) return resolve();
        setTimeout(tick, 100);
      };
      tick();
    });
  await waitReady(outA);
  await waitReady(outB);

  // A 执行标记命令，B 不应看到
  a.ws.send(encodeDataFrame(Buffer.from('echo marker-only-in-A\n', 'utf8')));
  await outA.wait('marker-only-in-A');
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(!outB.has('marker-only-in-A'), 'B 不应收到 A 的输出');

  // B 自己的命令正常
  b.ws.send(encodeDataFrame(Buffer.from('echo b-works\n', 'utf8')));
  await outB.wait('b-works');

  // 关闭 A 不影响 B
  a.ws.close(1000);
  await new Promise((r) => setTimeout(r, 800));
  b.ws.send(encodeDataFrame(Buffer.from('echo still-alive\n', 'utf8')));
  await outB.wait('still-alive');

  b.ws.close(1000);
});

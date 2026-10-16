// 跳板机（ProxyJump）集成测试：真实双 sshd——目标经跳板 forwardOut 到达（禁止 mock，宪法第 V 条）
import { test } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';
import { makeTempDir } from '../helpers/tmpdir.js';
import { startSshd } from '../helpers/sshd.js';
import { seedHost } from '../helpers/seed-host.js';
import { startApp } from '../../src/net/server.js';
import { FrameType, encodeDataFrame } from '../../web/src/protocol/frames.js';
import WebSocket from 'ws';

const execFileAsync = promisify(execFile);

async function hostFingerprint(hostKeyPath) {
  const { stdout } = await execFileAsync('ssh-keygen', ['-lf', hostKeyPath]);
  const m = stdout.match(/(SHA256:[^\s]+)/);
  return m ? m[1] : null;
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

function awaitClose(r) {
  if (r.code !== undefined || r.status !== undefined) return Promise.resolve(r);
  return new Promise((resolve) =>
    r.ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
  );
}

function collect(ws) {
  let buf = '';
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const b = Buffer.from(data);
    if (b[0] === FrameType.DATA) buf += b.subarray(1).toString('utf8');
  });
  return {
    wait: (needle, timeout = 8000) =>
      new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
          if (buf.includes(needle)) return resolve(true);
          if (Date.now() - start > timeout) return reject(new Error(`等待 "${needle}" 超时: ${buf}`));
          setTimeout(tick, 100);
        };
        tick();
      }),
  };
}

test('跳板机：目标经跳板 ProxyJump 直连成功；异常场景错误码正确', async (t) => {
  const jumpSshd = await startSshd();
  const targetSshd = await startSshd();
  const { dir, cleanup } = await makeTempDir('webssh-jump-');
  let app;
  t.after(async () => {
    await app?.close();
    await jumpSshd.stop();
    await targetSshd.stop();
    await cleanup();
  });

  const configDir = `${dir}/etc`;
  const username = userInfo().username;
  const jumpFp = await hostFingerprint(`${jumpSshd.hostKey}.pub`);
  const targetFp = await hostFingerprint(`${targetSshd.hostKey}.pub`);

  // 跳板机：直连、已存凭据、指纹已确认
  await seedHost({
    configDir,
    id: 'h_jump',
    host: '127.0.0.1',
    port: jumpSshd.port,
    username,
    privateKey: await readFile(jumpSshd.clientKey, 'utf8'),
    fingerprint: jumpFp,
  });
  // 目标：经跳板连接（密钥为目标 sshd 的客户端密钥）
  await seedHost({
    configDir,
    id: 'h_target',
    host: '127.0.0.1',
    port: targetSshd.port,
    username,
    privateKey: await readFile(targetSshd.clientKey, 'utf8'),
    fingerprint: targetFp,
    connectVia: 'jump',
    jumpHostId: 'h_jump',
  });
  // 异常场景种子：跳板不存在 / 跳板无凭据 / 跳板指纹未确认
  await seedHost({
    configDir, id: 'h_badjump', host: '127.0.0.1', port: targetSshd.port, username,
    privateKey: await readFile(targetSshd.clientKey, 'utf8'), fingerprint: targetFp,
    connectVia: 'jump', jumpHostId: 'h_missing',
  });
  await seedHost({
    configDir, id: 'h_nonejump', host: '127.0.0.1', port: jumpSshd.port, username, authType: 'none', fingerprint: jumpFp,
  });
  await seedHost({
    configDir, id: 'h_vianone', host: '127.0.0.1', port: targetSshd.port, username,
    privateKey: await readFile(targetSshd.clientKey, 'utf8'), fingerprint: targetFp,
    connectVia: 'jump', jumpHostId: 'h_nonejump',
  });

  const config = {
    standalone: { bind: '127.0.0.1', port: 0 },
    limits: { sessionsPerUser: 10, connectTimeoutMs: 8000, idleTimeoutMs: 60000 },
    security: { allowedOrigins: [] },
  };
  app = await startApp({ env: { WEBSSH_HOME: dir }, config });
  const origin = `http://127.0.0.1:${app.port}`;
  const wsBase = `ws://127.0.0.1:${app.port}`;

  // 1. 经跳板连接目标：open + 命令往返
  let r = await connectWs(`${wsBase}/ws/terminal?hostId=h_target&version=1`, origin);
  assert.ok(r.open, `跳板连接应成功: ${JSON.stringify({ code: r.code, reason: r.reason })}`);
  const out = collect(r.ws);
  await out.wait('Last login').catch(() => {});
  r.ws.send(encodeDataFrame(Buffer.from('echo jump-ok\n', 'utf8')));
  await out.wait('jump-ok');
  r.ws.close(1000);

  // 2. 跳板不存在 → 4006 jump_not_found
  r = await awaitClose(await connectWs(`${wsBase}/ws/terminal?hostId=h_badjump&version=1`, origin));
  assert.equal(r.code, 4006);
  assert.equal(r.reason, 'jump_not_found');

  // 3. 跳板为 none（无凭据）→ 4006 jump_no_secret
  r = await awaitClose(await connectWs(`${wsBase}/ws/terminal?hostId=h_vianone&version=1`, origin));
  assert.equal(r.code, 4006);
  assert.equal(r.reason, 'jump_no_secret');

  // 4. REST 层校验：多级跳板 / 自引用 / 不存在 → 422 invalid_jump
  const api = `http://127.0.0.1:${app.port}/api`;
  const mk = (body) =>
    fetch(`${api}/hosts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const keyPem = await readFile(targetSshd.clientKey, 'utf8');
  const base = { host: '127.0.0.1', port: targetSshd.port, username, authType: 'privateKey', privateKey: keyPem };
  let res = await mk({ ...base, name: '多级跳板', connectVia: 'jump', jumpHostId: 'h_target' });
  assert.equal(res.status, 422); // h_target 本身是跳板模式
  res = await mk({ ...base, name: '跳板不存在', connectVia: 'jump', jumpHostId: 'h_ghost' });
  assert.equal(res.status, 422);
  res = await mk({ ...base, name: '跳板无凭据', connectVia: 'jump', jumpHostId: 'h_nonejump' });
  assert.equal(res.status, 422);
  // 自引用（PUT 自身）
  res = await fetch(`${api}/hosts/h_target`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ connectVia: 'jump', jumpHostId: 'h_target' }),
  });
  assert.equal(res.status, 422);
});

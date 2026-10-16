// 加密私钥口令流程集成测试（真实 sshd，禁止 mock SSH 协议——宪法第 V 条）：
// 4006 passphrase_required → REST 换一次性口令票据 → pt 重连成功 →
// 票据一次性（4009）→ 错误口令（passphrase_invalid）→ 记住口令后免票据直连
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

test('加密私钥：口令提示 → 一次性票据连接 → 记住口令', async (t) => {
  const sshd = await startSshd();
  const { dir, cleanup } = await makeTempDir('webssh-pass-');
  let app;
  t.after(async () => {
    await app?.close();
    await sshd.stop();
    await cleanup();
  });

  // 把 sshd 脚手架的客户端密钥就地加密（公钥不变，authorized_keys 仍有效）
  await execFileAsync('ssh-keygen', ['-p', '-P', '', '-N', 'test123', '-q', '-f', sshd.clientKey]);
  const fp = await hostFingerprint(`${sshd.hostKey}.pub`);

  const configDir = `${dir}/etc`;
  const username = userInfo().username;
  // 加密私钥但不存口令（模拟用户上传了加密私钥、从未输入过口令）
  await seedHost({
    configDir,
    id: 'h_enc',
    host: '127.0.0.1',
    port: sshd.port,
    username,
    privateKey: await readFile(sshd.clientKey, 'utf8'),
    fingerprint: fp,
  });
  // 密码认证主机：connect-secret 应拒绝（422）
  await seedHost({ configDir, id: 'h_pw', password: 'x', fingerprint: fp });

  const config = {
    standalone: { bind: '127.0.0.1', port: 0 },
    limits: { sessionsPerUser: 10, connectTimeoutMs: 8000, idleTimeoutMs: 60000 },
    security: { allowedOrigins: [] },
  };
  app = await startApp({ env: { WEBSSH_HOME: dir }, config });
  const origin = `http://127.0.0.1:${app.port}`;
  const api = `http://127.0.0.1:${app.port}/api`;
  const wsBase = `ws://127.0.0.1:${app.port}`;

  // 1. 无口令直连 → 4006 passphrase_required
  let r = await awaitClose(await connectWs(`${wsBase}/ws/terminal?hostId=h_enc&version=1`, origin));
  assert.equal(r.code, 4006);
  assert.equal(r.reason, 'passphrase_required');

  // 2. connect-secret 换票据（不记住）→ pt 连接成功且可执行命令
  const tr = await fetch(`${api}/hosts/h_enc/connect-secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase: 'test123' }),
  });
  assert.ok(tr.ok, `换票据应成功: ${tr.status}`);
  const { ticket } = await tr.json();
  assert.ok(ticket);
  r = await connectWs(`${wsBase}/ws/terminal?hostId=h_enc&version=1&pt=${ticket}`, origin);
  assert.ok(r.open, `票据连接应成功: ${JSON.stringify({ code: r.code, reason: r.reason })}`);
  const out = collect(r.ws);
  await out.wait('Last login').catch(() => {});
  r.ws.send(encodeDataFrame(Buffer.from('echo pass-ok\n', 'utf8')));
  await out.wait('pass-ok');
  r.ws.close(1000);

  // 3. 票据一次性：重用 → 4009
  r = await awaitClose(await connectWs(`${wsBase}/ws/terminal?hostId=h_enc&version=1&pt=${ticket}`, origin));
  assert.equal(r.code, 4009);
  assert.equal(r.reason, 'invalid_pass_ticket');

  // 4. 错误口令 → 4006 passphrase_invalid
  const badRes = await fetch(`${api}/hosts/h_enc/connect-secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase: 'wrong' }),
  });
  const bad = await badRes.json();
  r = await awaitClose(
    await connectWs(`${wsBase}/ws/terminal?hostId=h_enc&version=1&pt=${bad.ticket}`, origin)
  );
  assert.equal(r.code, 4006);
  assert.equal(r.reason, 'passphrase_invalid');

  // 5. 记住口令：remember=true 持久化后，无 pt 直连成功
  const remRes = await fetch(`${api}/hosts/h_enc/connect-secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase: 'test123', remember: true }),
  });
  assert.ok(remRes.ok);
  r = await connectWs(`${wsBase}/ws/terminal?hostId=h_enc&version=1`, origin);
  assert.ok(r.open, `记住口令后直连应成功: ${JSON.stringify({ code: r.code, reason: r.reason })}`);
  r.ws.close(1000);

  // 6. 非密钥认证主机调用 connect-secret → 422
  const notKey = await fetch(`${api}/hosts/h_pw/connect-secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase: 'x' }),
  });
  assert.equal(notKey.status, 422);

  // 7. 口令不落日志：关闭原因与审计不得包含口令明文（SC-010）
  const audit = await (await fetch(`${api}/audit`)).json();
  assert.ok(!JSON.stringify(audit).includes('test123'), '审计记录不得包含口令明文');
});

test('none 认证（不记录密码）：password_required → 密码票据到达认证层', async (t) => {
  // 测试 sshd 关闭密码认证（PasswordAuthentication no），密码必然 auth_failed——
  // 恰好据此验证链路完整性：无票据 → password_required；有票据 → 进入真实认证（auth_failed）
  const sshd = await startSshd();
  const { dir, cleanup } = await makeTempDir('webssh-none-');
  let app;
  t.after(async () => {
    await app?.close();
    await sshd.stop();
    await cleanup();
  });
  const fp = await hostFingerprint(`${sshd.hostKey}.pub`);
  await seedHost({
    configDir: `${dir}/etc`,
    id: 'h_none',
    host: '127.0.0.1',
    port: sshd.port,
    username: userInfo().username,
    authType: 'none',
    fingerprint: fp,
  });
  const config = {
    standalone: { bind: '127.0.0.1', port: 0 },
    limits: { sessionsPerUser: 10, connectTimeoutMs: 8000, idleTimeoutMs: 60000 },
    security: { allowedOrigins: [] },
  };
  app = await startApp({ env: { WEBSSH_HOME: dir }, config });
  const origin = `http://127.0.0.1:${app.port}`;
  const api = `http://127.0.0.1:${app.port}/api`;
  const wsBase = `ws://127.0.0.1:${app.port}`;

  // 1. 无密码票据直连 → 4006 password_required（未发起 SSH 认证）
  let r = await awaitClose(await connectWs(`${wsBase}/ws/terminal?hostId=h_none&version=1`, origin));
  assert.equal(r.code, 4006);
  assert.equal(r.reason, 'password_required');

  // 2. connect-secret 换密码票据 → 连接进入真实认证层（sshd 拒绝密码 → auth_failed）
  const tr = await fetch(`${api}/hosts/h_none/connect-secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'any' }),
  });
  assert.ok(tr.ok, `none 主机换票据应成功: ${tr.status}`);
  const { ticket } = await tr.json();
  r = await awaitClose(
    await connectWs(`${wsBase}/ws/terminal?hostId=h_none&version=1&pt=${ticket}`, origin)
  );
  assert.equal(r.code, 4006);
  assert.equal(r.reason, 'auth_failed', '密码应到达 SSH 认证层（而非 password_required）');

  // 3. none 主机不支持记住密码 → 422
  const rem = await fetch(`${api}/hosts/h_none/connect-secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'any', remember: true }),
  });
  assert.equal(rem.status, 422);

  // 4. none 主机不存凭据：publicView hasSecret 为 false
  const hosts = await (await fetch(`${api}/hosts`)).json();
  const noneHost = hosts.find((h) => h.id === 'h_none');
  assert.equal(noneHost.hasSecret, false);
});

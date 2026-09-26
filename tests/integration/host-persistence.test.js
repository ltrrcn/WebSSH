// T044：主机与凭据持久化 + 指纹确认全流程（真实 sshd）
// 保存凭据 → 重启服务 → 仍可连接；指纹确认前拒绝、确认后可连；删除后不可连
import { test } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { makeTempDir } from '../helpers/tmpdir.js';
import { startSshd } from '../helpers/sshd.js';
import { startApp } from '../../src/net/server.js';
import WebSocket from 'ws';

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

const CONFIG = (port) => ({
  standalone: { bind: '127.0.0.1', port: 0 },
  limits: { sessionsPerUser: 10, connectTimeoutMs: 8000, idleTimeoutMs: 60000 },
  security: { allowedOrigins: [] },
});

test('凭据加密持久化：重启服务后主机与指纹仍在且可直连', async (t) => {
  const sshd = await startSshd();
  const { dir, cleanup } = await makeTempDir('webssh-persist-');
  t.after(async () => {
    await app.close();
    await cleanup();
    await sshd.stop();
  });

  // 第一次启动：通过 API 创建主机（私钥认证）
  let app = await startApp({ env: { WEBSSH_HOME: dir }, config: CONFIG() });
  const username = userInfo().username;
  const privateKey = await readFile(sshd.clientKey, 'utf8');
  const created = await (
    await fetch(`http://127.0.0.1:${app.port}/api/hosts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '持久化主机', host: '127.0.0.1', port: sshd.port, username,
        authType: 'privateKey', privateKey,
      }),
    })
  ).json();
  assert.ok(created.id);

  // 首连：指纹未确认 → 4005，且关闭原因携带服务端捕获的指纹
  let r = await connectWs(`ws://127.0.0.1:${app.port}/ws/terminal?hostId=${created.id}&version=1`, `http://127.0.0.1:${app.port}`);
  r = await awaitClose(r);
  assert.equal(r.code, 4005);
  const m = r.reason.match(/(SHA256:[A-Za-z0-9+/=]+)/);
  assert.ok(m, `关闭原因应携带捕获的指纹: ${r.reason}`);
  const fingerprint = m[1];

  // 确认指纹
  const vres = await fetch(`http://127.0.0.1:${app.port}/api/hosts/${created.id}/verify-hostkey`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fingerprint }),
  });
  assert.equal(vres.status, 200);

  // 确认后可连
  r = await connectWs(`ws://127.0.0.1:${app.port}/ws/terminal?hostId=${created.id}&version=1`, `http://127.0.0.1:${app.port}`);
  assert.ok(r.open, `确认后应可连接: ${JSON.stringify({ code: r.code, reason: r.reason })}`);
  const ws = r.ws;
  let out = '';
  ws.on('message', (d, isBin) => { if (isBin) { const b = Buffer.from(d); if (b[0] === 0) out += b.subarray(1).toString(); } });
  await new Promise((r2) => setTimeout(r2, 800));
  ws.send(Buffer.concat([Buffer.from([0]), Buffer.from('echo persist-ok\n')]));
  await new Promise((r2) => setTimeout(r2, 1500));
  assert.ok(out.includes('persist-ok'), '重启前应可执行命令');
  ws.close(1000);

  // —— 重启服务（模拟进程重启）——
  await app.close();
  app = await startApp({ env: { WEBSSH_HOME: dir }, config: CONFIG() });

  // 主机、凭据、指纹全部保留，且无需重新输入凭据即可直连（SC-003）
  const list = await (await fetch(`http://127.0.0.1:${app.port}/api/hosts`)).json();
  assert.ok(list.some((h) => h.id === created.id && h.fingerprintConfirmed));
  r = await connectWs(`ws://127.0.0.1:${app.port}/ws/terminal?hostId=${created.id}&version=1`, `http://127.0.0.1:${app.port}`);
  assert.ok(r.open, '重启后凭据与指纹保留，应直接可连');
  r.ws.close(1000);

  // —— 删除后不可再连 ——
  const dres = await fetch(`http://127.0.0.1:${app.port}/api/hosts/${created.id}`, { method: 'DELETE' });
  assert.equal(dres.status, 200);
  r = await connectWs(`ws://127.0.0.1:${app.port}/ws/terminal?hostId=${created.id}&version=1`, `http://127.0.0.1:${app.port}`);
  r = await awaitClose(r);
  assert.equal(r.code, 4003, '删除后连接应被拒绝');
});

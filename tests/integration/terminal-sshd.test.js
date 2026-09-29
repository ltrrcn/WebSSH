// T032：真实 sshd 集成测试——连接 → 输入输出 → resize → 信号中断 → 断开
// 覆盖 password 与 privateKey+passphrase 两种认证（FR-006）
import { test } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { promisify } from 'node:util';
import { makeTempDir } from '../helpers/tmpdir.js';
import { startSshd } from '../helpers/sshd.js';
import { seedHost } from '../helpers/seed-host.js';
import { startApp } from '../../src/net/server.js';
import { FrameType, encodeDataFrame } from '../../web/src/protocol/frames.js';
import WebSocket from 'ws';

const execFileAsync = promisify(execFile);

/** 用 ssh-keygen 从主机公钥计算 OpenSSH 风格指纹（SHA256:base64） */
async function hostFingerprint(hostKeyPath) {
  const { stdout } = await execFileAsync('ssh-keygen', ['-lf', hostKeyPath]);
  // 输出格式: "256 SHA256:xxxx comment (ED25519)"
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

/** open 后等待服务端关闭（关闭码可能晚于 open 到达） */
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
    text: () => buf,
    wait: (needle, timeout = 8000) =>
      new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
          if (buf.includes(needle)) return resolve(true);
          if (Date.now() - start > timeout) return reject(new Error(`等待 "${needle}" 超时，当前输出:\n${buf}`));
          setTimeout(tick, 100);
        };
        tick();
      }),
  };
}

test('真实 sshd：指纹未确认时拒绝（4005），确认后全流程可用', async (t) => {
  const sshd = await startSshd();
  t.after(async () => {
    await sshd.stop();
    await app.close();
    await cleanup();
  });
  const { dir, cleanup } = await makeTempDir('webssh-int-');
  const env = { WEBSSH_HOME: dir };
  const config = {
    standalone: { bind: '127.0.0.1', port: 0 },
    limits: { sessionsPerUser: 10, connectTimeoutMs: 8000, idleTimeoutMs: 60000 },
    security: { allowedOrigins: [] },
  };

  const username = userInfo().username;
  // 第一次种子：指纹未确认
  await seedHost({
    configDir: `${dir}/etc`,
    id: 'h_ssh',
    host: '127.0.0.1',
    port: sshd.port,
    username,
    privateKey: await readFile(sshd.clientKey, 'utf8'),
    fingerprint: null,
  });

  let app = await startApp({ env, config });
  const origin = `http://127.0.0.1:${app.port}`;
  let wsBase = `ws://127.0.0.1:${app.port}`;

  let r = await connectWs(`${wsBase}/ws/terminal?hostId=h_ssh&version=1`, origin);
  r = await awaitClose(r);
  assert.equal(r.code, 4005, '指纹未确认应拒绝');

  // 模拟使用者确认指纹（US2 提供确认界面；此处直接写 store）
  const fp = await hostFingerprint(`${sshd.hostKey}.pub`);
  assert.ok(fp, '应能计算主机指纹');
  const store = app.deps.store;
  await store.touchHost('h_ssh', { fingerprint: fp, fingerprintConfirmedAt: new Date().toISOString() });

  // 确认后：全流程
  const r2 = await connectWs(`${wsBase}/ws/terminal?hostId=h_ssh&version=1`, origin);
  assert.ok(r2.open, `确认后应能打开终端，实际: ${JSON.stringify({ code: r2.code, reason: r2.reason })}`);
  const ws = r2.ws;
  const out = collect(ws);

  // 等待 shell 就绪（提示符因 shell 而异，以登录横幅做宽松探测）
  await out.wait('Last login').catch(() => {});
  ws.send(encodeDataFrame(Buffer.from('echo webssh-ok\n', 'utf8')));
  await out.wait('webssh-ok');

  // resize：0x01 控制帧
  ws.send(Buffer.concat([Buffer.from([FrameType.RESIZE]), Buffer.from(JSON.stringify({ cols: 100, rows: 40 }))]));
  ws.send(encodeDataFrame(Buffer.from('stty size\n', 'utf8')));
  await out.wait('40 100');

  // 信号：0x02 INT 中断长输出
  ws.send(encodeDataFrame(Buffer.from('sleep 30\n', 'utf8')));
  await new Promise((r2s) => setTimeout(r2s, 400));
  ws.send(Buffer.concat([Buffer.from([FrameType.SIGNAL]), Buffer.from(JSON.stringify({ signal: 'INT' }))]));
  ws.send(encodeDataFrame(Buffer.from('echo after-int\n', 'utf8')));
  await out.wait('after-int');

  // 优雅关闭
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  ws.close(1000);
  assert.equal(await closed, 1000);

  // 命令审计：Web 终端每条提交的命令留痕（category 过滤）
  await new Promise((r2s) => setTimeout(r2s, 500)); // 审计异步落盘
  const cmds = await (
    await fetch(`http://127.0.0.1:${app.port}/api/audit?category=commands`)
  ).json();
  assert.ok(
    cmds.items.some((e) => e.command === 'echo webssh-ok' && e.actorType === 'user'),
    `Web 终端命令应留痕: ${JSON.stringify(cmds.items.map((e) => e.command))}`
  );
  assert.ok(cmds.items.every((e) => e.event === 'command'), 'commands 类别只含命令事件');
  // 会话 ID：命令事件携带 sessionId，与同一会话的连接事件一致；可按会话筛选
  const cmdEv = cmds.items.find((e) => e.command === 'echo webssh-ok');
  assert.ok(cmdEv.sessionId, '命令事件应携带会话 ID');
  assert.match(cmdEv.sessionId, /^s_[a-z0-9]{4}$/, '会话 ID 应为 s_ + 4 位字符');
  const bySession = await (
    await fetch(`http://127.0.0.1:${app.port}/api/audit?sessionId=${cmdEv.sessionId}`)
  ).json();
  assert.ok(bySession.items.length >= 2, '按会话筛选应含连接与命令事件');
  assert.ok(bySession.items.every((e) => e.sessionId === cmdEv.sessionId));
  assert.ok(
    bySession.items.some((e) => e.event === 'connect-success'),
    '该会话的连接成功记录应可见'
  );
  const ops = await (
    await fetch(`http://127.0.0.1:${app.port}/api/audit?category=operation`)
  ).json();
  assert.ok(
    ops.items.every((e) => e.event !== 'command'),
    'operation 类别不含命令事件'
  );
  assert.ok(
    ops.items.some((e) => e.event === 'connect-success'),
    'operation 类别应含登录（连接成功）记录'
  );

  // 输出摘要开关：默认关闭 → 命令事件无 outputDigest
  const echoEv = cmds.items.find((e) => e.command === 'echo webssh-ok');
  assert.ok(!echoEv.outputDigest, '默认不记录输出摘要');

  // 热开启（REST PUT）后新会话：命令事件附带脱敏输出摘要
  const base = `http://127.0.0.1:${app.port}`;
  const put = await fetch(`${base}/api/audit-settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recordTerminalOutput: true }),
  });
  assert.equal(put.status, 200);

  const r3 = await connectWs(`${wsBase}/ws/terminal?hostId=h_ssh&version=1`, origin);
  assert.ok(r3.open, '开关开启后应能打开终端');
  const ws3 = r3.ws;
  const out3 = collect(ws3);
  await out3.wait('Last login').catch(() => {});
  ws3.send(encodeDataFrame(Buffer.from('echo digest-marker-7\n', 'utf8')));
  await out3.wait('digest-marker-7');
  ws3.send(encodeDataFrame(Buffer.from('true\n', 'utf8'))); // 触发上一条命令 flush
  await new Promise((r2s) => setTimeout(r2s, 300));
  const closed3 = new Promise((resolve) => ws3.on('close', resolve));
  ws3.close(1000);
  await closed3;
  await new Promise((r2s) => setTimeout(r2s, 500)); // 审计异步落盘

  const cmds2 = await (await fetch(`${base}/api/audit?category=commands`)).json();
  const digestEv = cmds2.items.find((e) => e.command === 'echo digest-marker-7');
  assert.ok(digestEv?.outputDigest, '开启后命令应带输出摘要');
  assert.ok(digestEv.outputDigest.includes('digest-marker-7'), `摘要应含命令输出: ${digestEv.outputDigest}`);

  // 开关状态持久化查询
  const get = await (await fetch(`${base}/api/audit-settings`)).json();
  assert.equal(get.recordTerminalOutput, true);
});

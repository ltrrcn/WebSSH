// 性能实测（SC-001/SC-002）+ 大输出可响应性（FR-021）—— 对真实 sshd
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';
import { startSshd } from '../tests/helpers/sshd.js';
import { seedHost } from '../tests/helpers/seed-host.js';
import { startApp } from '../src/net/server.js';
import { encodeDataFrame } from '../web/src/protocol/frames.js';
import WebSocket from 'ws';

const execFileAsync = promisify(execFile);
const results = {};

const sshd = await startSshd();
const dir = `/tmp/webssh-perf-${Date.now()}`;
const { mkdir } = await import('node:fs/promises');
await mkdir(dir, { recursive: true });
const { stdout } = await execFileAsync('ssh-keygen', ['-lf', `${sshd.hostKey}.pub`]);
await seedHost({
  configDir: `${dir}/etc`,
  id: 'h_perf',
  host: '127.0.0.1',
  port: sshd.port,
  username: userInfo().username,
  privateKey: await readFile(sshd.clientKey, 'utf8'),
  fingerprint: stdout.match(/(SHA256:[^\s]+)/)[1],
});
const app = await startApp({
  env: { WEBSSH_HOME: dir },
  config: { standalone: { bind: '127.0.0.1', port: 0 }, limits: { sessionsPerUser: 5, connectTimeoutMs: 8000 } },
});
const origin = `http://127.0.0.1:${app.port}`;

function connect() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws/terminal?hostId=h_perf&version=1`, { origin });
    ws.binaryType = 'arraybuffer';
    let buf = '';
    ws.on('message', (d, isBin) => {
      if (isBin) { const b = Buffer.from(d); if (b[0] === 0) buf += b.subarray(1).toString(); }
    });
    ws.on('open', () => resolve({ ws, buf: () => buf }));
  });
}

// —— SC-001：点击主机 → 出现可输入提示符（以收到首个 shell 输出为准）——
{
  const t0 = Date.now();
  const { ws, buf } = await connect();
  await new Promise((resolve) => {
    const tick = () => (buf().length > 0 ? resolve() : setTimeout(tick, 10));
    tick();
  });
  results['SC-001 首字节延迟(ms)'] = Date.now() - t0;
  results['SC-001 达标(≤5000)'] = Date.now() - t0 <= 5000;

  // —— SC-002：输入 → 回显（局域网目标）——
  await new Promise((r) => setTimeout(r, 600)); // 等 shell 就绪
  const lat = [];
  for (let i = 0; i < 5; i++) {
    const marker = `perf-echo-${i}`;
    const before = buf().length;
    const t1 = Date.now();
    ws.send(encodeDataFrame(Buffer.from(`echo ${marker}\n`)));
    await new Promise((resolve) => {
      const tick = () => (buf().includes(marker) ? resolve() : setTimeout(tick, 5));
      tick();
    });
    lat.push(Date.now() - t1);
    await new Promise((r) => setTimeout(r, 150));
  }
  const p50 = [...lat].sort((a, b) => a - b)[2];
  results['SC-002 回显延迟采样(ms)'] = lat;
  results['SC-002 p50(ms)'] = p50;
  results['SC-002 达标(≤200)'] = p50 <= 200;

  // —— FR-021：大输出（~2MB）下的接收完整性与中断 ——
  await new Promise((r) => setTimeout(r, 300));
  const outBefore = buf().length;
  ws.send(encodeDataFrame(Buffer.from('yes webssh-large-output | head -c 2000000\n')));
  const t2 = Date.now();
  let received = 0;
  await new Promise((resolve) => {
    const tick = () => {
      received = buf().length - outBefore;
      if (received >= 1900000 || Date.now() - t2 > 15000) resolve();
      else setTimeout(tick, 100);
    };
    tick();
  });
  results['FR-021 大输出接收(bytes)'] = received;
  // 中断：信号帧
  ws.send(Buffer.concat([Buffer.from([2]), Buffer.from(JSON.stringify({ signal: 'INT' }))]));
  await new Promise((r) => setTimeout(r, 500));
  const t3 = Date.now();
  ws.send(encodeDataFrame(Buffer.from('echo after-interrupt-ok\n')));
  await new Promise((resolve) => {
    const tick = () => (buf().includes('after-interrupt-ok') ? resolve() : setTimeout(tick, 10));
    tick();
  });
  results['FR-021 中断后恢复(ms)'] = Date.now() - t3;
  results['FR-021 中断有效'] = results['FR-021 中断后恢复(ms)'] < 3000;
  ws.close(1000);
}

console.log(JSON.stringify(results, null, 2));
await app.close();
await sshd.stop();
process.exit(0);

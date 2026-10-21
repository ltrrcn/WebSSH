// 初始窗口尺寸同步回归测试：
// 客户端在 WS 握手完成后立即上报 RESIZE（浏览器 onopen 后 ~30ms 的真实时序），
// 而服务端要等 SSH shell 就绪（bridgeSession 绑定消息监听）才能处理。
// 曾经的缺陷：这段窗口内到达的 RESIZE 被静默丢弃，远端 pty 停留在默认 80×24，
// 本地终端更宽 → zsh zle 按 80 列计算行数 → 长命令/快速输入时重绘错位、内容重叠到上一行。
// 修复：upgrade 层在任何 await 之前暂存 RESIZE，shell 就绪后补投给 pty。
import { test } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { userInfo, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { startSshd } from '../helpers/sshd.js';
import { seedHost } from '../helpers/seed-host.js';
import { startApp } from '../../src/net/server.js';
import { FrameType, encodeDataFrame } from '../../web/src/protocol/frames.js';
import WebSocket from 'ws';

const execFileAsync = promisify(execFile);

test('建连期间到达的初始 RESIZE 不丢弃：远端 pty 尺寸与终端一致', async (t) => {
  const sshd = await startSshd();
  const dir = await mkdtemp(join(tmpdir(), 'webssh-resize-'));
  const app = await (async () => {
    const { stdout } = await execFileAsync('ssh-keygen', ['-lf', `${sshd.hostKey}.pub`]);
    const fp = stdout.match(/(SHA256:[^\s]+)/)[1];
    await seedHost({
      configDir: `${dir}/etc`,
      id: 'h_resize',
      host: '127.0.0.1',
      port: sshd.port,
      username: userInfo().username,
      privateKey: await readFile(sshd.clientKey, 'utf8'),
      fingerprint: fp,
    });
    return startApp({
      env: { WEBSSH_HOME: dir },
      config: {
        standalone: { bind: '127.0.0.1', port: 0 },
        limits: { sessionsPerUser: 10, connectTimeoutMs: 8000, idleTimeoutMs: 60000 },
        security: { allowedOrigins: [] },
      },
    });
  })();

  t.after(async () => {
    await app.close();
    await sshd.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const origin = `http://127.0.0.1:${app.port}`;
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws/terminal?hostId=h_resize&version=1`, {
    origin,
  });

  let buf = '';
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const b = Buffer.from(data);
    if (b[0] === FrameType.DATA) buf += b.subarray(1).toString('utf8');
  });

  // ★ 模拟浏览器时序：open 后立即发送首个 RESIZE（先于服务端 SSH shell 就绪），
  //   此后不再补发（窗口不变时浏览器不会再发）
  await new Promise((resolve, reject) => {
    ws.once('open', () => {
      ws.send(
        Buffer.concat([
          Buffer.from([FrameType.RESIZE]),
          Buffer.from(JSON.stringify({ cols: 137, rows: 41 })),
        ])
      );
      resolve();
    });
    ws.once('error', reject);
  });

  const wait = (needle, timeout = 10000) =>
    new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        if (buf.includes(needle)) return resolve(true);
        if (Date.now() - start > timeout)
          return reject(new Error(`等待 "${needle}" 超时，当前输出:\n${buf}`));
        setTimeout(tick, 50);
      };
      tick();
    });

  await wait('Last login').catch(() => {}); // shell 就绪（宽松探测，banner 因系统而异）
  ws.send(encodeDataFrame('stty size\n'));
  await wait('41 137');

  // 命中 "41 137" 即证明初始 RESIZE 在 shell 就绪后被补投；
  // 退化时 stty 输出 "24 80"，上面的 wait 会超时报错并带出实际输出
  assert.ok(buf.includes('41 137'), '远端 pty 应为 41x137 而非默认 80x24');

  ws.close(1000);
});

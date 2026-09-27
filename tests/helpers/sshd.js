import { execFile, spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * 集成测试用真实 OpenSSH sshd 脚手架（research R14）。
 *
 * 在临时目录中生成一次性主机密钥与客户端密钥，以专用端口启动 sshd，
 * 测试结束后可完全销毁。禁止 mock SSH 协议（宪法第 V 条）。
 */

async function findSshdPath() {
  try {
    const { stdout } = await execFileAsync('/bin/sh', ['-c', 'command -v sshd']);
    const p = stdout.trim();
    if (p) return p;
  } catch {
    /* fallthrough */
  }
  const candidates = [
    '/usr/sbin/sshd',
    '/usr/local/sbin/sshd',
    '/opt/homebrew/sbin/sshd',
    '/opt/homebrew/usr/sbin/sshd',
  ];
  for (const c of candidates) {
    try {
      await execFileAsync('/bin/sh', ['-c', `[ -x ${c} ]`]);
      return c;
    } catch {
      /* next */
    }
  }
  throw new Error(
    '未找到 sshd：集成测试需要本机 OpenSSH（macOS 自带；Linux 安装 openssh-server；或使用容器）'
  );
}

/** 预留一个临时空闲端口（bind 0 后立即释放，存在极小竞争窗口，测试场景可接受） */
async function reservePort() {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForPort(port, host, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const ok = await new Promise((resolve) => {
      const sock = createConnection({ port, host }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.once('error', () => resolve(false));
      sock.setTimeout(1000, () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (ok) return;
  }
  throw new Error(`sshd 未在 ${timeoutMs}ms 内就绪 (127.0.0.1:${port})`);
}

/**
 * 启动隔离 sshd 实例。
 * @returns {{port:number, host:string, clientKey:string, hostKey:string, stop:()=>Promise<void>}}
 */
export async function startSshd() {
  const dir = await (await import('node:fs/promises')).mkdtemp(join(tmpdir(), 'webssh-sshd-'));
  const hostKey = join(dir, 'host_ed25519');
  const clientKey = join(dir, 'client_ed25519');

  // 生成一次性密钥对（主机密钥 + 客户端密钥）
  await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', hostKey]);
  await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', clientKey]);
  const pub = await readFile(`${clientKey}.pub`, 'utf8');

  const akDir = join(dir, 'authorized');
  await mkdir(akDir);
  await writeFile(join(akDir, 'authorized_keys'), pub);

  const port = await reservePort();
  const config = [
    `Port ${port}`,
    'ListenAddress 127.0.0.1',
    `HostKey ${hostKey}`,
    `AuthorizedKeysFile ${join(akDir, 'authorized_keys')}`,
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'PubkeyAuthentication yes',
    'PermitRootLogin prohibit-password',
    `PidFile ${join(dir, 'sshd.pid')}`,
    'LogLevel INFO',
    // SFTP 子系统（MCP 文件类工具需要）
    'Subsystem sftp internal-sftp',
    // 临时目录属主可能与 sshd 预期不同，关闭严格模式（仅测试用）
    'StrictModes no',
  ].join('\n');
  const confPath = join(dir, 'sshd_config');
  await writeFile(confPath, `${config}\n`);

  const sshdPath = await findSshdPath();
  // sshd 要求以绝对路径执行；-D 前台运行便于随测试进程销毁
  const proc = spawn(sshdPath, ['-D', '-e', '-f', confPath], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr += d;
  });

  try {
    await waitForPort(port, '127.0.0.1');
  } catch (err) {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
    throw new Error(`sshd 启动失败: ${err.message}\nsshd stderr:\n${stderr}`);
  }

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    proc.kill('SIGTERM');
    await new Promise((resolve) => {
      proc.once('exit', resolve);
      setTimeout(resolve, 2000);
    });
    await rm(dir, { recursive: true, force: true });
  };
  // 测试进程退出时兜底清理
  process.once('exit', stop);

  return { port, host: '127.0.0.1', clientKey, hostKey, proc, stop };
}

// T075：MCP 端到端——真实 sshd + 真实令牌调用（run_command / read_file；write_file 已禁用）
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

const execFileAsync = promisify(execFile);

function rpc(base, token, method, params) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

async function callTool(base, token, name, args) {
  const r = await rpc(base, token, 'tools/call', { name, arguments: args });
  if (r.status !== 200) return { httpError: r.status, body: r.body };
  if (r.body.error) return { rpcError: r.body.error };
  const parsed = JSON.parse(r.body.result.content[0].text);
  return r.body.result.isError ? { toolError: parsed } : parsed;
}

test('MCP 全链路：令牌 → 工具调用 → 真实 sshd 执行/读写（FR-022~043）', async (t) => {
  const sshd = await startSshd();
  const { dir, cleanup } = await makeTempDir('webssh-mcp-e2e-');
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
  const app = await startApp({
    env: { WEBSSH_HOME: dir },
    config: {
      standalone: { bind: '127.0.0.1', port: 0 },
      limits: { sessionsPerUser: 10, tokenRateLimitPerMinute: 100, execTimeoutMs: 8000, outputDigestBytes: 1024 },
      security: {
        allowedOrigins: [],
        sensitivePaths: ['/etc/shadow', '/root/.ssh'],
        readOnlyCommands: ['ls', 'cat'],
        dangerousCommands: ['rm', 'shutdown'],
      },
      defaultPermissions: [
        { prefix: '/var/log', read: true, write: false, download: false, modify: false, source: 'global-default' },
        { prefix: '/tmp', read: true, write: true, download: false, modify: true, source: 'global-default' },
      ],
    },
  });
  const base = `http://127.0.0.1:${app.port}`;
  t.after(async () => {
    await app.close();
    await cleanup();
    await sshd.stop();
  });

  // 1) 创建 writable 令牌
  const created = await (
    await fetch(`${base}/api/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'e2e', level: 'writable', hostScope: ['h_ssh'] }),
    })
  ).json();
  assert.ok(created.token, '明文一次性返回');
  const token = created.token;

  // 2) run_command：真实执行
  const marker = `mcp-e2e-${Date.now()}`;
  const run = await callTool(base, token, 'run_command', { hostId: 'h_ssh', command: `echo ${marker}` });
  assert.equal(run.exitCode, 0);
  assert.ok(run.stdoutDigest.includes(marker), `输出应含 marker: ${JSON.stringify(run)}`);

  // 3) write_file 已禁用（不允许上传文件）：工具不注册，调用被拒绝
  const toolsW = (await rpc(base, token, 'tools/list')).body.result.tools.map((x) => x.name);
  assert.ok(!toolsW.includes('write_file'), 'write_file 不注册');
  const w = await callTool(base, token, 'write_file', { hostId: 'h_ssh', path: '/tmp/x', content: 'x' });
  assert.ok(w.rpcError || w.toolError, 'write_file 调用应被拒绝');

  // 4) 敏感路径拒绝（FR-036）
  const denied = await callTool(base, token, 'read_file', { hostId: 'h_ssh', path: '/etc/shadow' });
  assert.equal(denied.toolError.error, 'path_denied');

  // 5) readonly 令牌：run_command 工具不存在（FR-031）
  const ro = await (
    await fetch(`${base}/api/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ro', level: 'readonly', hostScope: ['h_ssh'] }),
    })
  ).json();
  const tools = (await rpc(base, ro.token, 'tools/list')).body.result.tools.map((x) => x.name);
  assert.ok(!tools.includes('run_command'), 'readonly 不注册命令工具');
  const roCall = await callTool(base, ro.token, 'run_command', { hostId: 'h_ssh', command: 'ls' });
  assert.ok(roCall.rpcError || roCall.toolError, 'readonly 调用命令类工具应失败');

  // 6) 撤销立即失效（FR-026）
  await fetch(`${base}/api/tokens/${created.id}`, { method: 'DELETE' });
  assert.equal((await rpc(base, token, 'tools/list')).status, 401);

  // 7) 审计留痕（FR-027/041/042）
  await new Promise((r) => setTimeout(r, 300));
  const events = await (await fetch(`${base}/api/audit`)).json();
  assert.ok(events.items.some((e) => e.tokenId === created.id && e.event === 'command' && e.command?.includes(marker)), '命令留痕');
  assert.ok(!events.items.some((e) => e.event === 'file-write' && e.path === '/tmp/x'), '写入不留痕（write_file 已禁用）');
  // 8) 命令原文子串过滤（审计页「按命令查询」后端）
  const byCmd = await (await fetch(`${base}/api/audit?command=${encodeURIComponent(marker)}`)).json();
  assert.ok(byCmd.items.length >= 1, '命令过滤应命中');
  assert.ok(byCmd.items.every((e) => typeof e.command === 'string' && e.command.toLowerCase().includes(marker.toLowerCase())), '命中记录必须含命令原文');
  const byCmdNone = await (await fetch(`${base}/api/audit?command=no-such-command-xyz`)).json();
  assert.equal(byCmdNone.items.length, 0, '无命中时应为空');
  assert.ok(events.items.every((e) => !JSON.stringify(e).includes(created.token)), '审计不含令牌明文');
});

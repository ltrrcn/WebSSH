// T057/T061：审计字段完备性与脱敏（FR-010/011/041/042、SC-004/010/021）
import { test } from 'node:test';
import assert from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from '../helpers/tmpdir.js';
import { createAuditLogger } from '../../src/audit/logger.js';

const CONFIG = { audit: { retentionDays: 30, maxFileBytes: 1024 }, limits: { outputDigestBytes: 64 } };

async function mk() {
  const { dir, cleanup } = await makeTempDir('webssh-auditlog-');
  const audit = createAuditLogger({ logDir: dir, config: CONFIG });
  return { audit, cleanup, dir };
}

test('连接生命周期三类事件字段完备（FR-010/011，SC-004）', async () => {
  const { audit, cleanup } = await mk();
  try {
    await audit.log({ actor: 'local', hostId: 'h1', hostAddress: '127.0.0.1', authType: 'password', event: 'connect-attempt', result: 'success' });
    await audit.log({ actor: 'local', hostId: 'h1', hostAddress: '127.0.0.1', authType: 'password', event: 'connect-success', result: 'success' });
    await audit.log({ actor: 'local', hostId: 'h1', hostAddress: '127.0.0.1', authType: 'password', event: 'disconnect', result: 'success', reason: 'user', durationMs: 1234 });

    const events = await audit.listAll();
    assert.equal(events.length, 3, '三类事件不得遗漏');
    for (const ev of events) {
      for (const f of ['version', 'id', 'ts', 'actor', 'actorType', 'hostId', 'hostAddress', 'authType', 'event', 'result']) {
        assert.ok(f in ev, `缺失字段 ${f}`);
      }
      assert.equal(ev.version, 1);
    }
    const disc = events.find((e) => e.event === 'disconnect');
    assert.equal(disc.durationMs, 1234);
    assert.equal(disc.reason, 'user');
  } finally {
    await cleanup();
  }
});

test('命令原文与输出摘要写入前必须脱敏（FR-041/042）', async () => {
  const { audit, cleanup } = await mk();
  try {
    await audit.log({
      actor: 'local', actorType: 'token', tokenId: 't_x', hostId: 'h1',
      event: 'command', result: 'success',
      command: 'mysql -p password=hunter2 --execute "SELECT 1"',
      outputDigest: 'a'.repeat(200), // 超出 outputDigestBytes=64
    });
    const [ev] = await audit.listAll();
    assert.ok(!ev.command.includes('hunter2'), '命令中的口令必须被占位符替换');
    assert.ok(ev.command.includes('[REDACTED'));
    assert.equal(ev.outputDigest.length, 64, '输出摘要截断到上限');
    assert.equal(ev.redacted, true, '脱敏标记应置位');
  } finally {
    await cleanup();
  }
});

test('按大小滚动：超限切换到同日新文件（FR-017 之外的审计可靠性）', async () => {
  const { audit, cleanup, dir } = await mk();
  try {
    const big = 'x'.repeat(400);
    for (let i = 0; i < 6; i++) {
      await audit.log({ actor: 'local', hostId: 'h1', event: 'connect-attempt', result: 'success', reason: big });
    }
    const files = (await readdir(dir)).filter((f) => f.startsWith('audit-'));
    assert.ok(files.length >= 2, `应滚动出多个文件，实际: ${files}`);
    // 两份文件合计 6 条
    let count = 0;
    for (const f of files) {
      const text = await readFile(join(dir, f), 'utf8');
      count += text.trim().split('\n').filter(Boolean).length;
    }
    assert.equal(count, 6, '滚动不丢记录');
  } finally {
    await cleanup();
  }
});

test('审计文件与导出内容不含明文凭据与私钥（SC-010/021）', async () => {
  const { audit, cleanup } = await mk();
  try {
    await audit.log({
      actor: 'local', hostId: 'h1', event: 'connect-failure', result: 'error', reason: 'auth_failed',
      command: 'connect with -----BEGIN OPENSSH PRIVATE KEY-----\nabc123\n-----END OPENSSH PRIVATE KEY----- done',
      outputDigest: 'pw: hunter3',
    });
    const events = await audit.listAll();
    assert.ok(!events[0].command.includes('abc123'));
    assert.ok(events[0].command.includes('[REDACTED'));
    assert.ok(!events[0].outputDigest.includes('hunter3'));
  } finally {
    await cleanup();
  }
});

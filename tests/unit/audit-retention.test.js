// T089：审计保留策略（retentionDays 清理过期文件）
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdir, readdir, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from '../helpers/tmpdir.js';
import { createAuditLogger } from '../../src/audit/logger.js';

test('retentionDays：过期审计文件被清理，保留窗口内文件（FR-017 之外的审计可靠性）', async () => {
  const { dir, cleanup } = await makeTempDir('webssh-retention-');
  try {
    const old = 'audit-2020-01-01.jsonl';
    const recent = 'audit-2099-01-01.jsonl';
    const staleRolled = 'audit-2020-01-01.2.jsonl';
    await writeFile(join(dir, old), '{}\n');
    await writeFile(join(dir, recent), '{}\n');
    await writeFile(join(dir, staleRolled), '{}\n');
    // 修 mtime 到很久以前（保留判定按文件名日期，mtime 兜底）
    const past = new Date('2020-01-02');
    await utimes(join(dir, old), past, past);
    await utimes(join(dir, staleRolled), past, past);

    const audit = createAuditLogger({ logDir: dir, config: { audit: { retentionDays: 30, maxFileBytes: 10485760 } } });
    const removed = await audit.enforceRetention();
    const files = (await readdir(dir)).sort();
    assert.equal(removed, 2, '应清理两个过期文件');
    assert.deepEqual(files, [recent], '仅保留窗口内文件');
  } finally {
    await cleanup();
  }
});

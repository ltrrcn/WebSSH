import { test } from 'node:test';
import assert from 'node:assert';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from '../helpers/tmpdir.js';

import { atomicWriteFile, readJsonWithFallback } from '../../src/store/atomic.js';

test('原子写：产生最终文件，内容完整', async () => {
  const { dir, cleanup } = await makeTempDir('webssh-atomic-');
  try {
    const file = join(dir, 'hosts.json');
    await atomicWriteFile(file, JSON.stringify({ version: 1, hosts: [] }));
    const data = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(data.version, 1);
  } finally {
    await cleanup();
  }
});

test('原子写：第二次覆盖前保留一代 .bak', async () => {
  const { dir, cleanup } = await makeTempDir('webssh-atomic-');
  try {
    const file = join(dir, 'hosts.json');
    await atomicWriteFile(file, JSON.stringify({ version: 1, n: 'first' }));
    await atomicWriteFile(file, JSON.stringify({ version: 1, n: 'second' }));
    const bak = JSON.parse(await readFile(`${file}.bak`, 'utf8'));
    assert.equal(bak.n, 'first', '.bak 应保留上一次内容');
    const cur = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(cur.n, 'second');
  } finally {
    await cleanup();
  }
});

test('原子写：并发写串行化，最终内容为最后一次（无互相覆盖/撕裂）', async () => {
  const { dir, cleanup } = await makeTempDir('webssh-atomic-');
  try {
    const file = join(dir, 'hosts.json');
    const N = 50;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        atomicWriteFile(file, JSON.stringify({ version: 1, n: i, pad: 'x'.repeat(1024) }))
      )
    );
    const cur = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(cur.n, N - 1, '最后一次写入应胜出');
  } finally {
    await cleanup();
  }
});

test('损坏回退：主文件损坏时 readJsonWithFallback 回退 .bak 并能读取', async () => {
  const { dir, cleanup } = await makeTempDir('webssh-atomic-');
  try {
    const file = join(dir, 'hosts.json');
    await atomicWriteFile(file, JSON.stringify({ version: 1, n: 'good' }));
    await atomicWriteFile(file, JSON.stringify({ version: 1, n: 'good2' }));
    // 模拟写入中断：截断主文件
    await writeFile(file, '{"version":1,"n":"goo', 'utf8');
    const recovered = await readJsonWithFallback(file);
    assert.equal(recovered.n, 'good', '应回退到 .bak 的完整内容');
  } finally {
    await cleanup();
  }
});

test('损坏回退：主文件与 .bak 均损坏时抛错（不静默清空数据）', async () => {
  const { dir, cleanup } = await makeTempDir('webssh-atomic-');
  try {
    const file = join(dir, 'hosts.json');
    await atomicWriteFile(file, JSON.stringify({ version: 1 }));
    await writeFile(`${file}.bak`, '{broken', 'utf8');
    await writeFile(file, '{broken', 'utf8');
    await assert.rejects(() => readJsonWithFallback(file));
  } finally {
    await cleanup();
  }
});

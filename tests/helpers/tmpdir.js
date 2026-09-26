import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 创建一次性临时目录，返回目录路径与清理函数。
 * 用于单元/集成测试的沙箱（宪法第 V 条：测试隔离）。
 */
export async function makeTempDir(prefix = 'webssh-test-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

// 原子写 + 串行化 + 一代备份 + 损坏回退（research R8 / FR-017）
// 写入流程：写 .tmp → fsync → rename；覆盖前复制一代 .bak；单进程内按文件串行。
import { copyFile, mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

/** filePath -> 上一次写入的 Promise（串行链） */
const chains = new Map();

export async function atomicWriteFile(filePath, data) {
  const prev = chains.get(filePath) ?? Promise.resolve();
  const task = prev.then(
    () => writeOnce(filePath, data),
    () => writeOnce(filePath, data) // 前一次失败不阻塞本次
  );
  // 链上吞掉错误，保证后续写入不被卡死；错误仍通过 task 交给调用方
  chains.set(
    filePath,
    task.catch(() => {})
  );
  return task;
}

async function writeOnce(filePath, data) {
  await mkdir(dirname(filePath), { recursive: true });

  // 覆盖前保留一代备份
  try {
    await copyFile(filePath, `${filePath}.bak`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const tmp = `${filePath}.tmp`;
  const fh = await open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, filePath);
}

/**
 * 读取 JSON，主文件损坏/缺失时回退 .bak（FR-017：不静默清空数据）。
 * 两者均不可用时抛错。
 */
export async function readJsonWithFallback(filePath) {
  let mainErr;
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (err) {
    mainErr = err;
  }
  try {
    return JSON.parse(await readFile(`${filePath}.bak`, 'utf8'));
  } catch {
    throw mainErr;
  }
}

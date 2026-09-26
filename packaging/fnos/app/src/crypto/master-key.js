// 数据加密主密钥：首次启动生成 32 字节随机数，存于 etc/master.key（0700）
// research R7：不可逆性来自密钥文件本身不出现在任何导出中
import { chmod, mkdir, open, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const KEY_BYTES = 32;

/**
 * 加载或创建主密钥。
 * @param {string} configDir 配置目录（paths.config）
 * @returns {Promise<Buffer>} 32 字节主密钥（原始字节，非编码文本）
 */
export async function loadOrCreateMasterKey(configDir) {
  const file = join(configDir, 'master.key');
  try {
    const buf = await readFile(file);
    if (buf.length !== KEY_BYTES) {
      throw new Error(`master.key 长度异常（${buf.length} 字节，应为 ${KEY_BYTES}），拒绝启动`);
    }
    return buf;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const key = randomBytes(KEY_BYTES);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  // O_CREAT | O_EXCL：避免并发初始化时互相覆盖
  const fh = await open(file, 'wx', 0o600);
  try {
    await fh.writeFile(key);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await chmod(file, 0o700);
  return key;
}

// known_hosts 维护与指纹计算（research R10 / FR-007）
// 自维护文件而非系统 ~/.ssh/known_hosts：应用以专用低权用户运行，不应读写用户家目录。
// 格式与 OpenSSH 保持可读兼容：`host:port <算法> <指纹>`，便于人工核对。
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 计算主机公钥的 OpenSSH 风格指纹。
 * @param {Buffer} keyBlob ssh2 hostVerifier 收到的原始公钥（SSH wire 格式）
 * @returns {string} 形如 SHA256:base64（无 padding），与 ssh-keygen -lf 一致
 */
export function fingerprintOfKey(keyBlob) {
  return `SHA256:${createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '')}`;
}

export function knownHostsFile(paths) {
  return join(paths.config, 'known_hosts');
}

/** 读取全部已知主机记录（每行 host:port alg fingerprint） */
export async function readKnownHosts(paths) {
  try {
    const text = await readFile(knownHostsFile(paths), 'utf8');
    return text
      .split('\n')
      .filter((l) => l.trim())
      .map((line) => {
        const [target, alg, fp] = line.trim().split(/\s+/);
        return { target, alg, fingerprint: fp };
      });
  } catch {
    return [];
  }
}

/**
 * 追加一条已知主机记录（幂等：同 target + 指纹不重复追加）。
 */
export async function appendKnownHost({ paths, host, port, algorithm, fingerprint }) {
  const file = knownHostsFile(paths);
  await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
  const entries = await readKnownHosts(paths);
  const target = `${host}:${port}`;
  const dup = entries.find((e) => e.target === target && e.fingerprint === fingerprint);
  if (dup) return;
  await appendFile(file, `${target} ${algorithm} ${fingerprint}\n`, 'utf8');
}

/** 测试辅助：重置 known_hosts */
export async function resetKnownHosts(paths) {
  await writeFile(knownHostsFile(paths), '', 'utf8');
}

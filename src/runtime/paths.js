// 路径映射与目录初始化（宪法 VII：差异收敛在适配层）
// fnOS：TRIM_PKGETC / TRIM_PKGVAR / TRIM_PKGTMP / TRIM_APPDEST
// standalone：WEBSSH_HOME（默认 ~/.webssh）
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function resolvePaths(mode, env = process.env) {
  if (mode === 'fnos') {
    return {
      config: env.TRIM_PKGETC,
      data: env.TRIM_PKGVAR,
      tmp: env.TRIM_PKGTMP,
      log: join(env.TRIM_PKGVAR, 'log'),
      program: env.TRIM_APPDEST,
    };
  }
  const home = env.WEBSSH_HOME && env.WEBSSH_HOME !== ''
    ? env.WEBSSH_HOME
    : join(homedir(), '.webssh');
  return {
    config: join(home, 'etc'),
    data: join(home, 'var'),
    tmp: join(home, 'tmp'),
    log: join(home, 'var', 'log'),
    // standalone 程序目录：以本模块所在位置为参考（源码运行即 src/）
    program: import.meta.dirname,
  };
}

/**
 * 校验并创建缺失目录；配置目录含凭据，必须 0700（宪法「运行模式与路径解析」）。
 * 幂等：目录已存在时不报错、不放宽权限。
 */
export async function ensureDirs(paths) {
  for (const p of Object.values(paths)) {
    await mkdir(p, { recursive: true, mode: 0o700 });
  }
}

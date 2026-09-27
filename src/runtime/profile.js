// 运行模式探测与运行时解析（宪法第 VII 条）
// 本模块与 profile.js 是【唯一】允许读取 TRIM_* 环境变量的位置；
// 业务代码必须通过注入的 Runtime 对象访问，禁止散落 if (isFnos) 分支。
import { join } from 'node:path';
import { resolvePaths } from './paths.js';

/**
 * 模式探测：TRIM_APPNAME 存在且非空 → fnos；否则 → standalone。
 * @param {NodeJS.ProcessEnv} env
 * @returns {'fnos' | 'standalone'}
 */
export function detectMode(env = process.env) {
  return typeof env.TRIM_APPNAME === 'string' && env.TRIM_APPNAME !== ''
    ? 'fnos'
    : 'standalone';
}

/**
 * 解析运行时：路径、监听形态、身份来源全部在此收敛。
 * @param {NodeJS.ProcessEnv} env
 * @param {{ standalone?: { bind?: string, port?: number }, fnos?: { mcpDirect?: { enabled?: boolean, bind?: string, port?: number } } }} [config]
 */
export function resolveRuntime(env = process.env, config = {}) {
  const mode = detectMode(env);
  const paths = resolvePaths(mode, env);

  if (mode === 'fnos') {
    // MCP 机器直连（可选）：绕过统一网关的 fnOS 登录态校验，AI 客户端直达 /mcp
    const mcpDirect = config?.fnos?.mcpDirect;
    const mcpListen = mcpDirect?.enabled
      ? { host: mcpDirect.bind ?? '0.0.0.0', port: mcpDirect.port ?? 8422 }
      : null;
    return {
      mode,
      paths,
      listen: { type: 'unix', socketPath: join(env.TRIM_APPDEST, 'app.sock') },
      mcpListen,
      authSource: 'trim-headers',
    };
  }

  const bind = config?.standalone?.bind ?? '127.0.0.1';
  const port = config?.standalone?.port ?? 8080;
  return {
    mode,
    paths,
    listen: { type: 'tcp', host: bind, port },
    authSource: 'app-session',
  };
}

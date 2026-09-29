// 单一 HTTP 服务（宪法 III：单进程、单入口）
// fnOS：监听 ${TRIM_APPDEST}/app.sock（统一网关）；可选 MCP 机器直连 TCP 端口（仅 /mcp，fnos.mcpDirect）
// standalone：监听 127.0.0.1:<port>（非回环绑定必须启用 TLS，否则启动告警）
import { createServer } from 'node:http';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter, sendJson } from './router.js';
import { resolveIdentity } from './auth.js';
import { attachUpgrade } from './upgrade.js';
import { resolveRuntime } from '../runtime/profile.js';
import { ensureDirs } from '../runtime/paths.js';
import { loadConfig } from '../config/loader.js';
import { createFileStore } from '../store/file-store.js';
import { loadOrCreateMasterKey } from '../crypto/master-key.js';
import { createAuditLogger } from '../audit/logger.js';
import { createSessionManager } from '../session/manager.js';
import { hostsRoutes } from '../api/hosts.js';
import { groupsRoutes } from '../api/groups.js';
import { sessionsRoutes } from '../api/sessions.js';
import { auditRoutes } from '../api/audit.js';
import { auditSettingsRoutes } from '../api/audit-settings.js';
import { tokensRoutes } from '../api/tokens.js';
import { mcpDirectRoutes } from '../api/mcp-direct.js';
import { authenticateToken } from '../mcp/tokens.js';
import { handleMcpCall } from '../mcp/server.js';
import { checkRateLimit } from '../mcp/rate-limit.js';
import { readJsonBody } from './router.js';

/** /mcp 处理：Bearer 鉴权 → 限流 → JSON-RPC 分发 */
async function mcpHandler(req, res, deps) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
    return res.end(JSON.stringify({ error: { code: 'method_not_allowed', message: '仅支持 POST' } }));
  }
  const auth = req.headers.authorization ?? '';
  // 令牌来源：Authorization: Bearer（标准）→ X-MCP-Token（回退）。
  // fnOS 统一网关会抢验 Authorization 头（当作 fnOS token），携带网关登录态的
  // 请求经网关转发时只能用自定义头传递 MCP 令牌，故提供等价回退通道。
  const fallback = typeof req.headers['x-mcp-token'] === 'string' ? req.headers['x-mcp-token'].trim() : '';
  const plain = auth.startsWith('Bearer ')
    ? auth.slice(7)
    : fallback;
  if (!plain) {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { code: 'unauthorized', message: '缺少 Bearer 令牌' } }));
  }
  const result = await authenticateToken(deps.store, plain);
  if (!result.ok) {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { code: 'invalid_token', message: `令牌无效（${result.reason}）` } }));
  }
  // 限流（FR-028）：按令牌维度
  const limit = deps.config?.limits?.tokenRateLimitPerMinute ?? 60;
  if (!checkRateLimit(result.token.id, limit)) {
    res.writeHead(429, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { code: 'rate_limited', message: '超出令牌调用频率限制' } }));
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
  }
  // 通知（无 id）按规范返回 202
  if (body && body.id === undefined && !body.method?.startsWith('tools/') && !body.method?.startsWith('initialize')) {
    res.writeHead(202);
    return res.end();
  }
  const response = await handleMcpCall(body, {
    token: result.token,
    runtime: deps.runtime,
    config: deps.config,
    store: deps.store,
    audit: deps.audit,
    masterKey: deps.masterKey,
  });
  const text = JSON.stringify(response);
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

const WEB_DIR = join(fileURLToPath(new URL('../../web', import.meta.url)));

function isLoopback(host) {
  return (
    host === '127.0.0.1' ||
    host === 'localhost' ||
    host === '::1' ||
    (typeof host === 'string' && host.startsWith('127.'))
  );
}

/**
 * 启动应用（单一入口）。测试与生产共用。
 * @param {{env?: NodeJS.ProcessEnv, config?: object, webDir?: string}} [opts]
 */
export async function startApp(opts = {}) {
  const env = opts.env ?? process.env;

  // 配置：优先外部注入（测试），否则从配置目录加载
  let config = opts.config ?? null;
  let warnings = [];
  if (!config) {
    const probe = resolveRuntime(env);
    ({ config, warnings } = await loadConfig(probe.paths));
  }

  const runtime = resolveRuntime(env, config);
  await ensureDirs(runtime.paths);
  for (const w of warnings) console.warn(`[webssh] ${w}`);

  // 非回环绑定且未启用 TLS → 启动告警（宪法「监听」强制约束）
  if (
    runtime.listen.type === 'tcp' &&
    !isLoopback(runtime.listen.host) &&
    !config.standalone?.tls
  ) {
    console.warn(
      `[webssh][security] standalone 绑定非回环地址 ${runtime.listen.host} 且未启用 TLS，` +
        '数据与凭据将明文传输。生产环境必须配置反向代理 TLS 或 standalone.tls。'
    );
  }

  // 核心依赖注入（业务代码通过注入对象访问，禁止直读 TRIM_*）
  const masterKey = await loadOrCreateMasterKey(runtime.paths.config);
  const store = createFileStore({ configDir: runtime.paths.config });
  const audit = createAuditLogger({ logDir: runtime.paths.log, config });
  const sessionManager = createSessionManager({ config, store, audit, masterKey, runtime });

  const deps = { runtime, config, store, audit, masterKey, sessionManager, resolveIdentity };

  // REST 路由（Phase 2：/api/runtime；US1：/api/hosts 只读；后续故事在此扩展）
  const apiRoutes = [
    {
      method: 'GET',
      path: '/api/runtime',
      // 契约：返回运行模式与监听形态，不含具体路径
      handler: (req, res) => sendJson(res, 200, { mode: runtime.mode, listen: runtime.listen.type }),
    },
    ...hostsRoutes(deps),
    ...groupsRoutes(deps),
    ...sessionsRoutes(deps),
    ...auditRoutes(deps),
    ...auditSettingsRoutes(deps),
    ...tokensRoutes(deps),
    ...mcpDirectRoutes(deps),
  ];

  const router = createRouter({
    webDir: opts.webDir ?? WEB_DIR,
    apiRoutes,
    onMcp: (req, res) => mcpHandler(req, res, deps),
  });

  const httpServer = createServer((req, res) => {
    Promise.resolve(router(req, res, deps)).catch((err) => {
      console.error('[webssh] 请求处理失败:', err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'internal', message: '内部错误' } }));
      } else {
        res.destroy();
      }
    });
  });

  // WebSocket 升级（单一入口，宪法 III）
  attachUpgrade(httpServer, deps);

  // 监听
  if (runtime.listen.type === 'unix') {
    try {
      await unlink(runtime.listen.socketPath); // 清理残留 socket
    } catch {
      /* 不存在则忽略 */
    }
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(runtime.listen.socketPath, resolve);
    });
  } else {
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(runtime.listen.port, runtime.listen.host, resolve);
    });
  }

  console.log(
    `[webssh] 运行模式=${runtime.mode} ` +
      (runtime.listen.type === 'unix'
        ? `监听=unix:${runtime.listen.socketPath}`
        : `监听=${runtime.listen.host}:${httpServer.address().port}`)
  );

  // fnOS MCP 机器直连（可选）：独立端口只服务 /mcp，不经过统一网关。
  // 该端口不挂 REST/WS/静态页——机器端口只跑机器协议，缩小暴露面。
  // ctl 支持运行时热启停（设置界面开关，无需重启应用）。
  let mcpServer = null;
  const makeMcpDirectServer = () =>
    createServer((req, res) => {
      let path = req.url ?? '/';
      const q = path.indexOf('?');
      if (q >= 0) path = path.slice(0, q);
      if (path !== '/mcp') {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 'not_found', message: '此端口仅提供 /mcp' } }));
      }
      Promise.resolve(mcpHandler(req, res, deps)).catch((err) => {
        console.error('[webssh][mcp-direct] 请求处理失败:', err.message);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'internal', message: '内部错误' } }));
        } else {
          res.destroy();
        }
      });
    });
  const logMcpDirect = (on, host, port) => {
    if (on && !isLoopback(host)) {
      console.warn(
        `[webssh][security] MCP 直连端口绑定非回环地址 ${host}:${port}，` +
          'HTTP 明文传输（令牌可被窃听）。仅限可信内网使用，跨网请加 TLS 反代。'
      );
    }
    console.log(
      on
        ? `[webssh] MCP 直连=on ${host}:${port}（仅 /mcp，不经过 fnOS 网关）`
        : '[webssh] MCP 直连=off'
    );
  };
  const mcpDirectCtl = {
    /** 当前是否在监听 */
    isRunning: () => mcpServer !== null,
    /** 按当前 runtime.mcpListen 启动（已运行则报错） */
    async start() {
      if (mcpServer) throw new Error('MCP 直连端口已在运行');
      if (!runtime.mcpListen) throw new Error('未配置 mcpDirect');
      mcpServer = makeMcpDirectServer();
      try {
        await new Promise((resolve, reject) => {
          mcpServer.once('error', reject);
          mcpServer.listen(runtime.mcpListen.port, runtime.mcpListen.host, resolve);
        });
      } catch (err) {
        mcpServer = null;
        throw err;
      }
      logMcpDirect(true, runtime.mcpListen.host, mcpServer.address().port);
      return mcpServer.address().port;
    },
    /** 停止监听 */
    async stop() {
      if (!mcpServer) return;
      const s = mcpServer;
      mcpServer = null;
      await new Promise((resolve) => s.close(resolve));
      s.closeIdleConnections?.();
      logMcpDirect(false);
    },
  };

  const close = async () => {
    // 优雅退出：先终止全部会话（否则存活的 WS 连接会阻塞 httpServer.close）
    deps.sessionManager.killAll();
    await deps.audit.drain?.(); // 等待审计队列落盘，避免清理竞态
    await new Promise((resolve) => httpServer.close(resolve));
    httpServer.closeIdleConnections?.();
    await mcpDirectCtl.stop();
    if (runtime.listen.type === 'unix') {
      try {
        await unlink(runtime.listen.socketPath);
      } catch {
        /* 忽略 */
      }
    }
  };

  const app = {
    port: runtime.listen.type === 'tcp' ? httpServer.address().port : undefined,
    close,
    runtime,
    config,
    httpServer,
    deps,
    mcpDirectCtl,
  };
  // 注入到 deps 供 REST 热启停使用（routes 闭包引用同一 deps 对象）
  deps.mcpDirectCtl = mcpDirectCtl;
  deps.app = app;

  if (runtime.mcpListen) await mcpDirectCtl.start();

  return app;
}

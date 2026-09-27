// REST：MCP 机器直连端口管理（fnOS 专属，设置 → 令牌配置 页开关）
// GET  /api/mcp-direct   当前配置与运行状态
// PUT  /api/mcp-direct   { enabled, port?, bind? } —— 更新配置并热启停，无需重启应用
// 仅管理员（fnOS 网关注入 X-Trim-Isadmin；standalone 本地单用户恒为管理员，
// 但 standalone 本就有独立 TCP 端口，此接口返回 mode 提示不适用）
import { sendJson, sendError, readJsonBody } from '../net/router.js';
import { resolveIdentity } from '../net/auth.js';
import { saveConfig } from '../config/loader.js';

function currentState(deps) {
  const { runtime, config, mcpDirectCtl } = deps;
  const cfg = config.fnos?.mcpDirect ?? { enabled: false, bind: '0.0.0.0', port: 8422 };
  return {
    mode: runtime.mode,
    enabled: Boolean(cfg.enabled),
    bind: cfg.bind ?? '0.0.0.0',
    port: cfg.port ?? 8422,
    running: mcpDirectCtl ? mcpDirectCtl.isRunning() : false,
  };
}

export function mcpDirectRoutes(deps) {
  const { runtime, config, audit } = deps;

  const requireAdmin = (req, res) => {
    const identity = resolveIdentity(req, runtime);
    if (!identity) {
      sendError(res, 401, 'unauthorized', '未认证');
      return null;
    }
    if (!identity.isAdmin) {
      sendError(res, 403, 'forbidden', '仅管理员可修改 MCP 直连端口配置');
      return null;
    }
    return identity;
  };

  return [
    {
      method: 'GET',
      path: '/api/mcp-direct',
      handler: async (req, res) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        sendJson(res, 200, currentState(deps));
      },
    },
    {
      method: 'PUT',
      path: '/api/mcp-direct',
      handler: async (req, res) => {
        const identity = requireAdmin(req, res);
        if (!identity) return;
        if (runtime.mode !== 'fnos') {
          return sendError(res, 422, 'not_applicable', 'standalone 模式无需直连端口（主服务即 TCP 监听）');
        }
        let body;
        try {
          body = await readJsonBody(req);
        } catch (e) {
          return sendError(res, 422, 'invalid_json', e.message);
        }
        const enabled = body?.enabled;
        if (typeof enabled !== 'boolean') {
          return sendError(res, 422, 'invalid_field', 'enabled 必须为布尔值');
        }
        let port = config.fnos?.mcpDirect?.port ?? 8422;
        let bind = config.fnos?.mcpDirect?.bind ?? '0.0.0.0';
        if (body?.port !== undefined) {
          port = Number(body.port);
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            return sendError(res, 422, 'invalid_field', 'port 必须为 1–65535');
          }
        }
        if (body?.bind !== undefined) {
          bind = String(body.bind).trim();
          if (!/^[0-9a-zA-Z.:[\]-]+$/.test(bind) || bind.length === 0 || bind.length > 64) {
            return sendError(res, 422, 'invalid_field', 'bind 必须为合法 IP/主机名');
          }
        }

        // 1) 更新内存配置并同步 runtime（ctl 读取 runtime.mcpListen）
        config.fnos = { ...(config.fnos ?? {}), mcpDirect: { enabled, bind, port } };
        runtime.mcpListen = enabled ? { host: bind, port } : null;

        // 2) 持久化（失败不回滚内存——运行态与磁盘可恢复一致，报错提示手动重试）
        let saved = true;
        try {
          await saveConfig(runtime.paths, config);
        } catch (e) {
          saved = false;
          console.error('[webssh] config.json 保存失败:', e.message);
        }

        // 3) 热启停
        const { mcpDirectCtl } = deps;
        let actionError = null;
        try {
          if (enabled && !mcpDirectCtl.isRunning()) {
            await mcpDirectCtl.start();
          } else if (!enabled && mcpDirectCtl.isRunning()) {
            await mcpDirectCtl.stop();
          } else if (enabled && mcpDirectCtl.isRunning() && runtime.mcpListen) {
            // 端口/地址变化：重启监听
            await mcpDirectCtl.stop();
            await mcpDirectCtl.start();
          }
        } catch (e) {
          actionError = e.message;
        }

        audit?.log({
          event: 'mcp_direct_update',
          actorType: 'user',
          userId: identity.id,
          result: actionError ? 'failure' : 'success',
          reason: actionError ?? `enabled=${enabled} port=${port} bind=${bind}`,
        });

        if (actionError) {
          return sendError(res, 500, 'listen_failed', `配置已保存，但端口操作失败：${actionError}`);
        }
        const state = currentState(deps);
        sendJson(res, 200, { ...state, saved });
      },
    },
  ];
}

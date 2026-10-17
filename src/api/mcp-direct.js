// REST：MCP 机器直连端口管理（双模式通用，设置 → 令牌配置 页开关）
// GET  /api/mcp-direct   当前配置与运行状态
// PUT  /api/mcp-direct   { enabled, port?, bind? } —— 更新配置并热启停，无需重启应用
// 仅管理员（fnOS 网关注入 X-Trim-Isadmin；standalone 本地单用户恒为管理员）。
// 配置读写顶层 mcpDirect（旧版 fnos.mcpDirect 兼容读取）。
import { sendJson, sendError, readJsonBody } from '../net/router.js';
import { resolveIdentity } from '../net/auth.js';
import { saveConfig } from '../config/loader.js';

function readCfg(config) {
  return config.mcpDirect ?? config.fnos?.mcpDirect ?? { enabled: false, bind: '0.0.0.0', port: 8422 };
}

function currentState(deps) {
  const { runtime, config, mcpDirectCtl } = deps;
  const cfg = readCfg(config);
  return {
    mode: runtime.mode,
    enabled: Boolean(cfg.enabled),
    bind: cfg.bind ?? '0.0.0.0',
    port: cfg.port ?? 8422,
    customEndpoint: typeof cfg.customEndpoint === 'string' ? cfg.customEndpoint : '',
    running: mcpDirectCtl ? mcpDirectCtl.isRunning() : false,
  };
}

/** 校验自定义 MCP 地址：http(s) URL，含路径（通常以 /mcp 结尾），不含凭据 */
function validCustomEndpoint(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!s) return true; // 允许清空
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password;
  } catch {
    return false;
  }
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
        let port = readCfg(config).port ?? 8422;
        let bind = readCfg(config).bind ?? '0.0.0.0';
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
        // 自定义 MCP 地址（反代场景）：以该地址为接入端点，优先级最高
        let customEndpoint = readCfg(config).customEndpoint ?? '';
        if (body?.customEndpoint !== undefined) {
          if (!validCustomEndpoint(body.customEndpoint)) {
            return sendError(res, 422, 'invalid_field', 'customEndpoint 必须为 http(s):// 开头的合法 URL（不含用户名密码）');
          }
          customEndpoint = String(body.customEndpoint).trim().slice(0, 512);
        }

        // 1) 更新内存配置并同步 runtime（ctl 读取 runtime.mcpListen）
        config.mcpDirect = { enabled, bind, port, customEndpoint };
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
          reason: actionError ?? `启用=${enabled} 端口=${port} 绑定=${bind}`,
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

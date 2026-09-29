// REST：审计行为设置（设置 → 通用设置 → 行为 页开关）
// GET /api/audit-settings   当前审计行为配置
// PUT /api/audit-settings   { recordTerminalOutput } —— 更新并持久化，热生效无需重启
import { sendJson, sendError, readJsonBody } from '../net/router.js';
import { resolveIdentity } from '../net/auth.js';
import { saveConfig } from '../config/loader.js';

/**
 * @param {{runtime: object, config: object, audit: object}} deps
 */
export function auditSettingsRoutes(deps) {
  const { runtime, config, audit } = deps;

  return [
    {
      method: 'GET',
      path: '/api/audit-settings',
      handler: async (req, res) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        sendJson(res, 200, {
          recordTerminalOutput: config.audit?.recordTerminalOutput === true,
        });
      },
    },
    {
      method: 'PUT',
      path: '/api/audit-settings',
      handler: async (req, res) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        if (!identity.isAdmin) return sendError(res, 403, 'forbidden', '仅管理员可修改审计设置');
        let body;
        try {
          body = await readJsonBody(req);
        } catch (e) {
          return sendError(res, 422, 'invalid_json', e.message);
        }
        const recordTerminalOutput = body?.recordTerminalOutput;
        if (typeof recordTerminalOutput !== 'boolean') {
          return sendError(res, 422, 'invalid_field', 'recordTerminalOutput 必须为布尔值');
        }

        // 热更新内存配置（bridge 每次提交命令时读取，即刻生效）
        config.audit = { ...(config.audit ?? {}), recordTerminalOutput };

        let saved = true;
        try {
          await saveConfig(runtime.paths, config);
        } catch (e) {
          saved = false;
          console.error('[webssh] config.json 保存失败:', e.message);
        }

        audit?.log({
          event: 'audit_settings_update',
          actorType: 'user',
          userId: identity.id,
          result: saved ? 'success' : 'error',
          reason: `recordTerminalOutput=${recordTerminalOutput}`,
        });

        sendJson(res, 200, { recordTerminalOutput, saved });
      },
    },
  ];
}

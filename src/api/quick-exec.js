// REST：快捷命令掩码执行 —— 独立于终端 PTY 的一次性 exec 通道
// 命令不经过终端输入流：屏幕无回显、shell 历史无记录；与当前 shell 不共享 cd/环境变量
// 权限面：调用者为已认证用户本人，主机须在其主机列表内——与终端 shell 权限一致，不扩大
import { sendJson, sendError, readJsonBody } from '../net/router.js';
import { resolveIdentity } from '../net/auth.js';
import { withSsh, execCommand } from '../ssh/exec.js';
import { checkHostBlocklist } from '../ssh/policy.js';
import { redact, truncateDigest } from '../crypto/redact.js';

/**
 * @param {{runtime: object, store: object, audit: object, masterKey: Buffer, config: object}} deps
 */
export function quickExecRoutes(deps) {
  const { runtime, store, audit, masterKey, config } = deps;

  return [
    {
      method: 'POST',
      path: '/api/quick-exec',
      handler: async (req, res) => {
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        let body;
        try {
          body = await readJsonBody(req);
        } catch (e) {
          return sendError(res, 422, 'invalid_json', e.message);
        }
        const hostId = typeof body?.hostId === 'string' ? body.hostId : '';
        const command = typeof body?.command === 'string' ? body.command.trim() : '';
        // 快捷命令备注名（前端定义）：随审计留痕，审计页展示备注名而非命令原文
        const quickName = typeof body?.quickName === 'string' ? body.quickName.trim().slice(0, 100) : '';
        if (!hostId || !command) return sendError(res, 400, 'invalid', 'hostId 与 command 不能为空');
        if (command.length > 200) return sendError(res, 400, 'invalid', '命令超长（≤200 字符）');

        // 主机归属校验：只允许对本人主机执行
        const host = (await store.listHosts(identity.id)).find((h) => h.id === hostId);
        if (!host) return sendError(res, 404, 'not_found', '主机不存在');

        // 主机级二次认证：开启且未完成验证 → 拒绝（与终端/MCP 同一门禁；
        // 完成方式：在 Web 终端连接一次该主机，验证一次永久生效）
        if (host.requireTwofa === true && host.twofaVerified !== true) {
          audit.log({
            event: 'quick-exec',
            actor: identity.id,
            actorType: 'user',
            hostId,
            result: 'denied',
            reason: 'host_twofa_required',
          });
          return sendError(res, 403, 'host_twofa_required', '该连接已开启二次认证（2FA）：请先在终端连接一次该主机完成验证（一次验证永久生效）');
        }

        // 连接级命令黑名单（高级页）：快捷命令同样受限
        const blockedHit = checkHostBlocklist(command, host.session?.blockedCommands);
        if (blockedHit) {
          audit.log({
            event: 'quick-exec',
            actor: identity.id,
            actorType: 'user',
            hostId,
            result: 'denied',
            reason: `command_blocked_by_host:${blockedHit}`,
          });
          return sendError(res, 403, 'command_blocked', `命令被拒绝：该连接的黑名单禁用了「${blockedHit}」`);
        }

        const t0 = Date.now();
        try {
          const out = await withSsh({ host, masterKey, config }, (conn) =>
            execCommand(conn, command, config.limits?.execTimeoutMs ?? 60000)
          );
          const digest = truncateDigest(redact(out.stdout), config.limits?.outputDigestBytes ?? 2048);
          audit.log({
            event: 'quick-exec',
            actor: identity.id,
            actorType: 'user',
            hostId,
            hostAddress: `${host.host}:${host.port}`,
            result: out.timedOut ? 'error' : 'success',
            reason: out.timedOut ? 'timeout' : null,
            durationMs: Date.now() - t0,
            command,
            quickName: quickName || null,
            outputDigest: digest.content,
          });
          sendJson(res, 200, {
            exitCode: out.exitCode,
            stdout: out.stdout,
            stderr: out.stderr,
            timedOut: out.timedOut,
          });
        } catch (e) {
          audit.log({
            event: 'quick-exec',
            actor: identity.id,
            actorType: 'user',
            hostId,
            hostAddress: `${host.host}:${host.port}`,
            result: 'error',
            reason: e.message,
            durationMs: Date.now() - t0,
            command,
            quickName: quickName || null,
          });
          sendError(res, 502, 'exec_failed', `执行失败：${e.message}`);
        }
      },
    },
  ];
}

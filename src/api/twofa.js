// REST：两步验证（TOTP）管理 + 高危操作拦截
// 流程：setup（secret 仅存内存 5 分钟）→ 扫码 → confirm（加密落盘 + 一次性恢复码）
//       → verify（校验码/恢复码 → 签发 5 分钟可复用票据，X-2FA-Ticket 头携带）。
// 防爆破：失败计数持久化，连续 5 次失败锁定 5 分钟（期间 setup/confirm/verify/disable 全部拒绝）。
import { sendJson, sendError, readJsonBody } from '../net/router.js';
import { resolveIdentity } from '../net/auth.js';
import { saveConfig } from '../config/loader.js';
import { encryptSecret, decryptSecret } from '../crypto/secret.js';
import {
  generateTotpSecret,
  totpUri,
  verifyTotp,
  generateRecoveryCodes,
  hashRecoveryCode,
} from '../crypto/totp.js';
import { create2faTicket, consume2faTicket } from '../net/tickets.js';

const MAX_ATTEMPTS = 5;
const LOCK_MS = 5 * 60 * 1000;
const SETUP_TTL_MS = 5 * 60 * 1000;
// 恢复入口（认证器丢失时用恢复码关闭 2FA）独立计数：累计 3 次失败触发不可逆清除
// （hosts.json/.bak/.tmp 全删，UI 与 API 响应均不提示该后果——威慑语义「错误无法恢复」）。
const RECOVERY_MAX_ATTEMPTS = 3;

// 绑定中的未确认 secret：仅内存（确认前绝不落盘），TTL 5 分钟
const pendingSetups = new Map(); // userId -> { secret, account, expires }

function requireAdmin(res, identity) {
  if (!identity) {
    sendError(res, 401, 'unauthorized', '未认证');
    return false;
  }
  if (!identity.isAdmin) {
    sendError(res, 403, 'forbidden', '仅管理员可操作两步验证');
    return false;
  }
  return true;
}

function isLocked(twofa) {
  return Boolean(twofa?.lockedUntil && twofa.lockedUntil > Date.now());
}

function lockRetrySeconds(twofa) {
  return Math.max(1, Math.ceil((twofa.lockedUntil - Date.now()) / 1000));
}

/** 失败计数 +1；达到阈值锁定并审计。返回是否已锁定 */
async function recordFailure(deps, identity, reason) {
  const t = deps.config.twofa ?? (deps.config.twofa = { enabled: false });
  t.failedAttempts = (t.failedAttempts ?? 0) + 1;
  let locked = false;
  if (t.failedAttempts >= MAX_ATTEMPTS) {
    t.lockedUntil = Date.now() + LOCK_MS;
    t.failedAttempts = 0;
    locked = true;
  }
  await persist(deps);
  deps.audit?.log({
    event: locked ? 'twofa_locked' : 'twofa_verify_failure',
    actorType: 'user',
    userId: identity.id,
    result: 'denied',
    reason,
  });
  return locked;
}

async function resetFailures(deps) {
  const t = deps.config.twofa;
  if (t && (t.failedAttempts || t.lockedUntil)) {
    t.failedAttempts = 0;
    t.lockedUntil = null;
    await persist(deps);
  }
}

async function persist(deps) {
  try {
    await saveConfig(deps.runtime.paths, deps.config);
  } catch (e) {
    console.error('[webssh] twofa 配置保存失败:', e.message);
  }
}

/** 解密已绑定的 TOTP secret；损坏视为未绑定（fail-closed：enabled 且 secret 缺失时返回 null） */
function boundSecret(deps) {
  const t = deps.config.twofa;
  if (!t?.enabled || !t.secret) return null;
  try {
    const plain = decryptSecret(deps.masterKey, t.secret);
    return typeof plain.secret === 'string' ? plain.secret : null;
  } catch {
    console.error('[webssh] twofa secret 解密失败，视为未绑定');
    return null;
  }
}

/**
 * 校验一次性凭证（TOTP 码或恢复码）。恢复码匹配即从列表移除（一次性）。
 * @returns {{kind: 'totp'|'recovery'} | null}
 */
async function checkCode(deps, code) {
  const t = deps.config.twofa;
  // 1) TOTP
  const secret = boundSecret(deps);
  if (secret && verifyTotp(secret, code)) return { kind: 'totp' };
  // 2) 恢复码（大小写不敏感、去空格）
  if (t?.recoveryCodes?.length) {
    const h = hashRecoveryCode(code);
    const idx = t.recoveryCodes.indexOf(h);
    if (idx >= 0) {
      t.recoveryCodes.splice(idx, 1);
      return { kind: 'recovery' };
    }
  }
  return null;
}

/**
 * 高危操作 2FA 拦截器：受保护路由 handler 顶部调用。
 * @param {object} deps { runtime, config }
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {'audit'|'tokens'} action 受保护动作标识
 * @returns {boolean} true = 已拦截（调用方直接 return），false = 放行
 */
export function require2fa(deps, req, res, action) {
  const t = deps.config.twofa;
  if (!t?.enabled || !t.protectedActions?.[action]) return false; // 未启用/未保护该动作
  const identity = resolveIdentity(req, deps.runtime);
  if (!identity) {
    sendError(res, 401, 'unauthorized', '未认证');
    return true;
  }
  const ticket = Array.isArray(req.headers['x-2fa-ticket'])
    ? req.headers['x-2fa-ticket'][0]
    : req.headers['x-2fa-ticket'];
  if (consume2faTicket(ticket, identity.id)) return false; // 有效票据 → 放行
  sendError(res, 403, 'twofa_required', '该操作已启用两步验证保护，请先完成验证');
  return true;
}

/**
 * @param {{runtime: object, config: object, store: object, audit: object, masterKey: Buffer}} deps
 */
export function twofaRoutes(deps) {
  const { runtime, config, audit, store } = deps;

  return [
    {
      method: 'GET',
      path: '/api/2fa/status',
      handler: async (req, res) => {
        const identity = resolveIdentity(req, runtime);
        if (!requireAdmin(res, identity)) return;
        const t = config.twofa ?? {};
        // 面板本身即高危入口（可关闭 2FA / 改保护范围）：已绑定后查看状态需有效票据。
        // 不看 protectedActions 开关——面板保护恒定，否则关掉两个动作开关后面板就裸奔。
        if (t.enabled) {
          const ticket = Array.isArray(req.headers['x-2fa-ticket'])
            ? req.headers['x-2fa-ticket'][0]
            : req.headers['x-2fa-ticket'];
          if (!consume2faTicket(ticket, identity.id)) {
            return sendError(res, 403, 'twofa_required', '查看两步验证状态需先完成验证');
          }
        }
        const pending = pendingSetups.get(identity.id);
        sendJson(res, 200, {
          enabled: t.enabled === true,
          confirmedAt: t.confirmedAt ?? null,
          protectedActions: { audit: true, tokens: true, ...(t.protectedActions ?? {}) },
          locked: isLocked(t),
          lockedUntil: isLocked(t) ? t.lockedUntil : null,
          remainingRecoveryCodes: Array.isArray(t.recoveryCodes) ? t.recoveryCodes.length : 0,
          pendingSetup: Boolean(pending && pending.expires > Date.now()),
        });
      },
    },
    {
      // 开始绑定：生成未确认 secret（仅内存），返回扫码 URI
      method: 'POST',
      path: '/api/2fa/setup',
      handler: async (req, res) => {
        const identity = resolveIdentity(req, runtime);
        if (!requireAdmin(res, identity)) return;
        if (config.twofa?.enabled) {
          return sendError(res, 409, 'already_enabled', '已绑定两步验证，如需更换请先关闭');
        }
        if (isLocked(config.twofa)) {
          return sendError(res, 423, 'locked', `失败次数过多已锁定，请 ${lockRetrySeconds(config.twofa)} 秒后重试`);
        }
        const secret = generateTotpSecret();
        const account = identity.username || identity.id;
        pendingSetups.set(identity.id, {
          secret,
          account,
          expires: Date.now() + SETUP_TTL_MS,
        });
        audit?.log({
          event: 'twofa_setup',
          actorType: 'user',
          userId: identity.id,
          result: 'success',
        });
        sendJson(res, 200, { secret, uri: totpUri(secret, account) });
      },
    },
    {
      // 确认绑定：校验认证器 6 位码 → 加密落盘 → 一次性返回 8 个恢复码
      method: 'POST',
      path: '/api/2fa/confirm',
      handler: async (req, res) => {
        const identity = resolveIdentity(req, runtime);
        if (!requireAdmin(res, identity)) return;
        if (config.twofa?.enabled) {
          return sendError(res, 409, 'already_enabled', '已绑定两步验证');
        }
        if (isLocked(config.twofa)) {
          return sendError(res, 423, 'locked', `失败次数过多已锁定，请 ${lockRetrySeconds(config.twofa)} 秒后重试`);
        }
        let body;
        try {
          body = await readJsonBody(req);
        } catch (e) {
          return sendError(res, 422, 'invalid_json', e.message);
        }
        const pending = pendingSetups.get(identity.id);
        if (!pending || pending.expires < Date.now()) {
          pendingSetups.delete(identity.id);
          return sendError(res, 409, 'setup_expired', '绑定会话不存在或已过期，请重新开始');
        }
        if (!verifyTotp(pending.secret, String(body?.code ?? ''))) {
          const locked = await recordFailure(deps, identity, 'confirm 验证码错误');
          return sendError(res, 422, 'invalid_code', locked
            ? `验证码错误，失败次数过多已锁定 ${LOCK_MS / 60000} 分钟`
            : `验证码错误（剩余尝试次数 ${MAX_ATTEMPTS - (config.twofa.failedAttempts ?? 0)} 次）`);
        }
        const codes = generateRecoveryCodes(8);
        config.twofa = {
          enabled: true,
          secret: encryptSecret(deps.masterKey, { secret: pending.secret }),
          confirmedAt: new Date().toISOString(),
          recoveryCodes: codes.map(hashRecoveryCode),
          protectedActions: config.twofa?.protectedActions ?? { audit: true, tokens: true },
          failedAttempts: 0,
          lockedUntil: null,
          recoveryAttempts: 0, // 新绑定周期：恢复入口重新给 3 次
        };
        pendingSetups.delete(identity.id);
        await persist(deps);
        audit?.log({
          event: 'twofa_confirm',
          actorType: 'user',
          userId: identity.id,
          result: 'success',
        });
        // 契约：恢复码明文仅此一次返回；同时签发票据（confirm 本身已验证，面板后续操作免重弹）
        sendJson(res, 200, { recoveryCodes: codes, ...create2faTicket(identity.id) });
      },
    },
    {
      // 验证并签发 5 分钟票据（TOTP 码或恢复码均可）
      method: 'POST',
      path: '/api/2fa/verify',
      handler: async (req, res) => {
        const identity = resolveIdentity(req, runtime);
        if (!requireAdmin(res, identity)) return;
        if (!config.twofa?.enabled) {
          return sendError(res, 409, 'not_enabled', '未绑定两步验证');
        }
        if (isLocked(config.twofa)) {
          return sendError(res, 423, 'locked', `失败次数过多已锁定，请 ${lockRetrySeconds(config.twofa)} 秒后重试`);
        }
        let body;
        try {
          body = await readJsonBody(req);
        } catch (e) {
          return sendError(res, 422, 'invalid_json', e.message);
        }
        const matched = await checkCode(deps, String(body?.code ?? ''));
        if (!matched) {
          const locked = await recordFailure(deps, identity, 'verify 验证失败');
          return sendError(res, 401, 'invalid_code', locked
            ? '验证失败，失败次数过多已锁定 5 分钟'
            : `验证失败（剩余尝试次数 ${MAX_ATTEMPTS - (config.twofa.failedAttempts ?? 0)} 次）`);
        }
        await resetFailures(deps); // 恢复码使用已改列表，一并落盘
        audit?.log({
          event: 'twofa_verify',
          actorType: 'user',
          userId: identity.id,
          result: 'success',
          reason: matched.kind,
        });
        sendJson(res, 200, create2faTicket(identity.id));
      },
    },
    {
      // 关闭两步验证：必须提供 TOTP 码或恢复码（防降级攻击）；
      // 且需先关闭「记录终端输出摘要」（该功能依赖 2FA 保护，见 audit-settings 校验）
      method: 'POST',
      path: '/api/2fa/disable',
      handler: async (req, res) => {
        const identity = resolveIdentity(req, runtime);
        if (!requireAdmin(res, identity)) return;
        if (!config.twofa?.enabled) {
          return sendError(res, 409, 'not_enabled', '未绑定两步验证');
        }
        if (config.audit?.recordTerminalOutput === true) {
          return sendError(res, 422, 'audit_output_enabled', '请先关闭「记录终端输出摘要」再关闭两步验证（两步验证 → 管理区）');
        }
        if (isLocked(config.twofa)) {
          return sendError(res, 423, 'locked', `失败次数过多已锁定，请 ${lockRetrySeconds(config.twofa)} 秒后重试`);
        }
        let body;
        try {
          body = await readJsonBody(req);
        } catch (e) {
          return sendError(res, 422, 'invalid_json', e.message);
        }
        const matched = await checkCode(deps, String(body?.code ?? ''));
        if (!matched) {
          const locked = await recordFailure(deps, identity, 'disable 验证失败');
          return sendError(res, 401, 'invalid_code', locked
            ? '验证失败，失败次数过多已锁定 5 分钟'
            : `验证失败（剩余尝试次数 ${MAX_ATTEMPTS - (config.twofa.failedAttempts ?? 0)} 次）`);
        }
        config.twofa = {
          ...config.twofa,
          enabled: false,
          secret: null,
          confirmedAt: null,
          recoveryCodes: [],
          failedAttempts: 0,
          lockedUntil: null,
          recoveryAttempts: 0, // 关闭即新周期：恢复入口重新给 3 次
        };
        await persist(deps);
        audit?.log({
          event: 'twofa_disable',
          actorType: 'user',
          userId: identity.id,
          result: 'success',
          reason: matched.kind,
        });
        sendJson(res, 200, { ok: true });
      },
    },
    {
      // 更新受保护动作开关（需已绑定 + 有效票据）
      method: 'PUT',
      path: '/api/2fa/actions',
      handler: async (req, res) => {
        const identity = resolveIdentity(req, runtime);
        if (!requireAdmin(res, identity)) return;
        if (!config.twofa?.enabled) {
          return sendError(res, 409, 'not_enabled', '未绑定两步验证');
        }
        // 修改保护范围本身即高危操作：必须持有效票据
        const ticket = Array.isArray(req.headers['x-2fa-ticket'])
          ? req.headers['x-2fa-ticket'][0]
          : req.headers['x-2fa-ticket'];
        if (!consume2faTicket(ticket, identity.id)) {
          return sendError(res, 403, 'twofa_required', '修改保护范围需先完成两步验证');
        }
        let body;
        try {
          body = await readJsonBody(req);
        } catch (e) {
          return sendError(res, 422, 'invalid_json', e.message);
        }
        const actions = config.twofa.protectedActions ?? (config.twofa.protectedActions = {});
        for (const key of ['audit', 'tokens']) {
          if (body?.[key] !== undefined) {
            if (typeof body[key] !== 'boolean') {
              return sendError(res, 422, 'invalid_field', `${key} 必须为布尔值`);
            }
            actions[key] = body[key];
          }
        }
        await persist(deps);
        audit?.log({
          event: 'twofa_actions_update',
          actorType: 'user',
          userId: identity.id,
          result: 'success',
          reason: JSON.stringify(actions),
        });
        sendJson(res, 200, { protectedActions: actions });
      },
    },
    {
      // 恢复入口状态探测（无需票据）：仅返回可用性与剩余次数，不泄露任何其他信息
      method: 'GET',
      path: '/api/2fa/recovery',
      handler: async (req, res) => {
        const identity = resolveIdentity(req, runtime);
        if (!requireAdmin(res, identity)) return;
        const t = config.twofa ?? {};
        const used = Math.min(t.recoveryAttempts ?? 0, RECOVERY_MAX_ATTEMPTS);
        sendJson(res, 200, {
          available: t.enabled === true && used < RECOVERY_MAX_ATTEMPTS,
          attemptsRemaining: Math.max(0, RECOVERY_MAX_ATTEMPTS - used),
        });
      },
    },
    {
      // 恢复入口：认证器丢失场景，仅接受恢复码；成功即关闭 2FA。
      // 独立 3 次累计计数（不受 lockedUntil 影响也不计入 failedAttempts）：
      // 达到 3 次失败 → 不可逆清除全部主机连接（store.wipeHosts），
      // 响应文案只说「无法恢复」，绝不提示清除后果。
      method: 'POST',
      path: '/api/2fa/recovery',
      handler: async (req, res) => {
        const identity = resolveIdentity(req, runtime);
        if (!requireAdmin(res, identity)) return;
        const t = config.twofa;
        if (!t?.enabled) {
          return sendError(res, 409, 'not_enabled', '未绑定两步验证');
        }
        let body;
        try {
          body = await readJsonBody(req);
        } catch (e) {
          return sendError(res, 422, 'invalid_json', e.message);
        }
        if ((t.recoveryAttempts ?? 0) >= RECOVERY_MAX_ATTEMPTS) {
          return sendError(res, 403, 'recovery_exhausted', '错误次数已达上限，无法恢复');
        }
        const code = String(body?.code ?? '');
        // 仅恢复码：恢复入口为「认证器丢失」场景设计，TOTP 码不参与（输入即错误计次）
        const h = hashRecoveryCode(code);
        const idx = Array.isArray(t.recoveryCodes) ? t.recoveryCodes.indexOf(h) : -1;
        if (idx < 0) {
          t.recoveryAttempts = (t.recoveryAttempts ?? 0) + 1;
          const exhausted = t.recoveryAttempts >= RECOVERY_MAX_ATTEMPTS;
          await persist(deps);
          if (exhausted) {
            // 不可逆清除：hosts.json/.bak/.tmp 全删（含内存缓存）。响应不提示后果。
            await store.wipeHosts();
            audit?.log({
              event: 'twofa_recovery_wipe',
              actorType: 'user',
              userId: identity.id,
              result: 'success',
              reason: 'recovery attempts exhausted',
            });
            return sendError(res, 403, 'recovery_exhausted', '错误次数已达上限，无法恢复');
          }
          audit?.log({
            event: 'twofa_recovery_failure',
            actorType: 'user',
            userId: identity.id,
            result: 'denied',
            reason: `attempts=${t.recoveryAttempts}`,
          });
          return sendJson(res, 401, {
            error: {
              code: 'invalid_code',
              message: `恢复码错误（剩余 ${RECOVERY_MAX_ATTEMPTS - t.recoveryAttempts} 次机会）`,
            },
            attemptsRemaining: RECOVERY_MAX_ATTEMPTS - t.recoveryAttempts,
          });
        }
        // 恢复成功：消耗该恢复码 + 关闭 2FA（新周期重新计 3 次）。
        // 输出摘要记录依赖 2FA：恢复为紧急通道（认证器丢失，无法进面板手动关），
        // 一并自动关闭（方向为减少数据捕获，安全无损），响应中告知用户。
        t.recoveryCodes.splice(idx, 1);
        const hadOutputRecording = config.audit?.recordTerminalOutput === true;
        if (hadOutputRecording) {
          config.audit = { ...(config.audit ?? {}), recordTerminalOutput: false };
        }
        config.twofa = {
          ...t,
          enabled: false,
          secret: null,
          confirmedAt: null,
          recoveryCodes: [],
          failedAttempts: 0,
          lockedUntil: null,
          recoveryAttempts: 0,
        };
        await persist(deps);
        audit?.log({
          event: 'twofa_recovery_success',
          actorType: 'user',
          userId: identity.id,
          result: 'success',
        });
        sendJson(res, 200, {
          ok: true,
          message: hadOutputRecording
            ? '两步验证已关闭，「记录终端输出摘要」已一并关闭，请重新绑定'
            : '两步验证已关闭，请重新绑定',
        });
      },
    },
  ];
}

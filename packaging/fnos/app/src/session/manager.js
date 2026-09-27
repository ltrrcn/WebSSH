// 会话生命周期管理（FR-013/014/019 + data-model Session）
// 状态机：connecting → ready | failed；ready → closing → closed
// 进入 closed 必须释放全部资源（SC-005：残留进程数为 0）
import { randomUUID } from 'node:crypto';
import { connectShell } from '../ssh/client.js';
import { appendKnownHost } from '../ssh/hostkey.js';
import { decryptSecret } from '../crypto/secret.js';
import { bridgeSession } from './bridge.js';

/**
 * @param {{config: object, store: object, audit: object, masterKey: Buffer, runtime: object}} deps
 */
export function createSessionManager({ config, store, audit, masterKey, runtime }) {
  const limits = config?.limits ?? {};
  const sessionsPerUser = limits.sessionsPerUser ?? 10;
  const connectTimeoutMs = limits.connectTimeoutMs ?? 10000;
  const idleTimeoutMs = limits.idleTimeoutMs ?? 1800000;

  /** @type {Map<string, object>} sessionId -> session */
  const sessions = new Map();

  function countByOwner(ownerId) {
    let n = 0;
    for (const s of sessions.values()) if (s.ownerId === ownerId) n++;
    return n;
  }

  /** 建连中的名额预留（FR-019）：升级检查与注册之间存在异步窗口，必须同步预留防止绕过上限 */
  const reservations = new Map(); // ownerId -> count

  function tryReserve(ownerId) {
    const total = countByOwner(ownerId) + (reservations.get(ownerId) ?? 0);
    if (total >= sessionsPerUser) return false;
    reservations.set(ownerId, (reservations.get(ownerId) ?? 0) + 1);
    return true;
  }

  function releaseReservation(ownerId) {
    const n = (reservations.get(ownerId) ?? 0) - 1;
    if (n > 0) reservations.set(ownerId, n);
    else reservations.delete(ownerId);
  }

  function canCreate(ownerId) {
    return countByOwner(ownerId) + (reservations.get(ownerId) ?? 0) < sessionsPerUser;
  }

  function listSessions(ownerId) {
    return [...sessions.values()]
      .filter((s) => s.ownerId === ownerId)
      .map(({ id, hostId, startedAt, state }) => ({ id, hostId, startedAt, state }));
  }

  function auditBase(session, over = {}) {
    return {
      actor: session.ownerId,
      actorType: 'user',
      hostId: session.hostId,
      hostAddress: session.hostAddress,
      authType: session.authType,
      ...over,
    };
  }

  /**
   * 创建会话：审计 connect-attempt → SSH 连接 → 桥接；失败审计 connect-failure。
   */
  async function createSession({ ws, host, identity }) {
    const now = new Date().toISOString();
    const session = {
      id: `s_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      ownerId: identity.id,
      hostId: host.id,
      hostAddress: host.host,
      authType: host.authType,
      state: 'connecting',
      startedAt: now,
      endedAt: null,
      endReason: null,
      ws,
    };
    sessions.set(session.id, session);
    releaseReservation(identity.id); // 注册完成后由会话本体计数，释放预留

    audit.log(auditBase(session, { event: 'connect-attempt', result: 'success' }));

    let conn;
    let stream;
    // 竞态防护：ws 可能在 SSH 建连期间断开（桥接尚未挂接，close 事件会被错过）
    let wsClosedEarly = false;
    const onEarlyClose = () => {
      wsClosedEarly = true;
    };
    ws.once('close', onEarlyClose);
    ws.once('error', onEarlyClose);
    try {
      const secret = decryptSecret(masterKey, host.secret);
      const connected = await connectShell({
        host: host.host,
        port: host.port,
        username: host.username,
        secret,
        connectTimeoutMs,
        expectedFingerprint: host.fingerprint,
        onHostKeyVerified: ({ fingerprint }) => {
          // known_hosts 仅为人工核对记录（R10），写失败不影响已确认指纹的安全性
          appendKnownHost({
            paths: runtime.paths,
            host: host.host,
            port: host.port,
            algorithm: 'ssh-host-key',
            fingerprint,
          }).catch(() => {});
        },
      });
      conn = connected.conn;
      stream = connected.stream;
      session.conn = conn;
      session.stream = stream;
      session.state = 'ready';
      audit.log(auditBase(session, { event: 'connect-success', result: 'success' }));
    } catch (err) {
      session.state = 'failed';
      sessions.delete(session.id);
      // 错误原因白名单化，不得把异常原文（可能含凭据）直接透出
      const reason = sanitizeFailure(err);
      audit.log(auditBase(session, { event: 'connect-failure', result: 'error', reason }));
      ws.close(4006, reason);
      return session;
    } finally {
      ws.removeListener('close', onEarlyClose);
      ws.removeListener('error', onEarlyClose);
    }

    // 建连期间客户端已断开：立即回收，避免会话与远程连接泄漏
    if (wsClosedEarly) {
      closeSession(session, 'network', 1006);
      return session;
    }

    bridgeSession({
      ws,
      stream,
      session,
      idleTimeoutMs,
      audit,
      onSessionEnd: (endReason, closeCode) => closeSession(session, endReason, closeCode),
    });

    return session;
  }

  function closeSession(session, endReason, wsCloseCode = 1000) {
    if (session.state === 'closing' || session.state === 'closed') return;
    session.state = 'closing';
    session.endReason = endReason;

    // 释放全部资源（FR-013 / SC-005）
    try {
      session.stream?.end();
    } catch {
      /* 忽略 */
    }
    try {
      session.conn?.end();
    } catch {
      /* 忽略 */
    }
    // 兜底：DISCONNECT 若因对端半开而发不出去，强拆底层 socket 防止 sshd 侧残留
    const conn = session.conn;
    if (conn) {
      const t = setTimeout(() => {
        try {
          conn._sock?.destroy?.();
        } catch {
          /* 忽略 */
        }
      }, 500);
      t.unref?.();
    }

    session.state = 'closed';
    session.endedAt = new Date().toISOString();
    sessions.delete(session.id);

    const durationMs =
      session.startedAt ? Date.now() - new Date(session.startedAt).getTime() : null;
    audit.log(
      auditBase(session, {
        event: 'disconnect',
        result: 'success',
        reason: endReason,
        durationMs,
      })
    );

    try {
      if (session.ws.readyState === session.ws.OPEN) session.ws.close(wsCloseCode, endReason);
    } catch {
      /* 忽略 */
    }
  }

  /** 终止指定会话（US3 的 DELETE /api/sessions/{id} 使用） */
  function killSession(id, ownerId) {
    const s = sessions.get(id);
    if (!s || s.ownerId !== ownerId) return false;
    closeSession(s, 'user', 1000);
    return true;
  }

  /** 优雅退出：终止全部会话并释放资源（httpServer.close 前必须调用） */
  function killAll() {
    for (const s of [...sessions.values()]) {
      closeSession(s, 'shutdown', 1001);
    }
  }

  return {
    sessions,
    canCreate,
    countByOwner,
    listSessions,
    createSession,
    killSession,
    killAll,
    tryReserve,
    releaseReservation,
  };
}

/** 失败原因白名单（错误信息不得包含凭据，SC-010） */
function sanitizeFailure(err) {
  const msg = String(err?.message ?? err ?? '');
  if (msg === 'fingerprint_unconfirmed') return 'fingerprint_unconfirmed';
  if (msg === 'fingerprint_changed') return 'fingerprint_changed';
  if (/timed?out|ETIMEDOUT/i.test(msg)) return 'connect_timeout';
  if (/ECONNREFUSED/.test(msg)) return 'connection_refused';
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return 'dns_failure';
  if (/All configured authentication methods failed|authentication/i.test(msg)) return 'auth_failed';
  if (/connection_closed/.test(msg)) return 'connection_closed';
  return 'connect_failed';
}

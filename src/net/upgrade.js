// WebSocket 升级与握手校验（宪法 I + contracts/ws-terminal.md）
// HTTP 层拒绝：403 未授权 Origin、400 version 非法/多余参数
// WS 层关闭码：4001 未授权、4003 主机不在授权范围、4004 并发上限、4005 指纹未确认
import { WebSocketServer } from 'ws';
import { resolveIdentity } from './auth.js';
import { captureFingerprint, captureFingerprintViaJump } from '../ssh/client.js';
import { decryptSecret } from '../crypto/secret.js';
import { stripGatewayPrefix } from './router.js';
import { consumeWsTicket, consumePassTicket } from './tickets.js';
import { PROTOCOL_VERSION } from '../../web/src/protocol/frames.js';

/**
 * Origin 校验（FR-008：拒绝未授权来源）。
 * allowedOrigins 非空 → 精确匹配；为空 → 仅允许同源（Origin 的 host 与 Host 头一致）。
 */
function originAllowed(req, config) {
  const origin = req.headers.origin;
  if (!origin) return false; // 浏览器 WS 握手必带 Origin；缺失视为非浏览器/恶意来源
  const allowed = config?.security?.allowedOrigins ?? [];
  if (allowed.length > 0) return allowed.includes(origin);
  const host = req.headers.host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function rejectHandshake(socket, status, message, req) {
  // 拒绝原因写服务端日志（不含敏感值），便于现场诊断网关行为
  const origin = req?.headers?.origin ?? '-';
  const host = req?.headers?.host ?? '-';
  const hasTrim = 'x-trim-userid' in (req?.headers ?? {});
  console.error(
    `[webssh][ws] 拒绝升级 ${status} ${message} | origin=${origin} host=${host} x-trim-userid=${hasTrim ? '有' : '无'}`
  );
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
  );
  socket.destroy();
}

/**
 * 在既有 HTTP 服务上挂载 WS 升级处理（单一入口，宪法 III）。
 * @param {import('node:http').Server} httpServer
 * @param {{runtime: object, config: object, store: object, audit: object, sessionManager: object}} deps
 */
export function attachUpgrade(httpServer, deps) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return rejectHandshake(socket, 400, 'Bad Request', req);
    }
    // 统一网关前缀剥离（fnOS 模式下转发路径携带 /app/webssh 前缀）
    const wsPath = stripGatewayPrefix(url.pathname);
    if (wsPath !== '/ws/terminal') {
      return rejectHandshake(socket, 404, 'Not Found', req);
    }

    // 宪法 VIII：WS 握手参数必须携带 version；不支持的版本拒绝
    if (url.searchParams.get('version') !== String(PROTOCOL_VERSION)) {
      return rejectHandshake(socket, 400, 'Bad Request', req);
    }

    // 契约：查询参数只允许 hostId / version / ticket / sessionId / pt（不接受客户端指定 host/port/凭据）
    // pt = 私钥口令一次性票据 ID（口令明文永不进 URL）
    const extra = [...url.searchParams.keys()].filter(
      (k) => k !== 'hostId' && k !== 'version' && k !== 'ticket' && k !== 'sessionId' && k !== 'pt'
    );
    if (extra.length > 0) {
      return rejectHandshake(socket, 400, 'Bad Request', req);
    }

    // 身份解析：优先网关注入的 X-Trim-*；网关可能不向 WS 升级注入头 → 一次性票据回退
    let identity = resolveIdentity(req, deps.runtime);
    let gatewayAuthenticated = Boolean(identity); // fnos 模式下 X-Trim-* 即网关凭证
    if (!identity) {
      const ticketIdentity = consumeWsTicket(url.searchParams.get('ticket'));
      if (ticketIdentity) {
        identity = ticketIdentity;
        gatewayAuthenticated = true; // 票据由经网关认证的 REST 签发
      }
    }
    if (!identity) {
      return rejectHandshake(socket, 401, 'Unauthorized', req);
    }

    // Origin 校验（FR-008）：standalone 严格同源；
    // fnos 模式下 unix socket 仅网关可达，凡携带网关凭证（X-Trim-* 或票据）即视为已过网关登录校验
    if (!originAllowed(req, deps.config)) {
      if (deps.runtime.mode === 'fnos' && gatewayAuthenticated) {
        console.error('[webssh][ws] fnos 网关流量 Origin 不匹配但携带网关凭证，放行');
      } else {
        return rejectHandshake(socket, 403, 'Forbidden', req);
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleTerminal(ws, identity, url, deps).catch(() => {
        try {
          ws.close(1011, 'internal');
        } catch {
          /* 忽略 */
        }
      });
    });
  });

  return wss;
}

async function handleTerminal(ws, identity, url, deps) {
  const { store, audit, sessionManager } = deps;
  const hostId = url.searchParams.get('hostId');
  const sessionId = url.searchParams.get('sessionId');

  // FR-059 重新接管挂起的会话：会话已存在（不占新的并发名额），归属由 attachSession 校验
  if (sessionId) {
    const ok = sessionManager.attachSession({ sessionId, ownerId: identity.id, ws });
    if (!ok) {
      auditDenied(audit, identity, hostId, 'session_not_attachable');
      return ws.close(4007, 'session_not_attachable');
    }
    return;
  }

  // 并发会话上限（FR-019）：在任何异步操作之前【同步】预留名额——
  // 升级检查与注册之间的异步窗口会被并发连接绕过（session-limits 挂起的根因）
  if (!sessionManager.tryReserve(identity.id)) {
    auditDenied(audit, identity, hostId, 'session_limit');
    return ws.close(4004, 'session_limit');
  }

  // 主机只能来自授权清单且归属本人（FR-001/009/020）
  const host = hostId ? await store.getHost(hostId, identity.id) : undefined;
  if (!host) {
    sessionManager.releaseReservation(identity.id);
    auditDenied(audit, identity, hostId, 'host_not_allowed');
    return ws.close(4003, 'host_not_allowed');
  }

  // 「仅 MCP」授权范围：网页终端入口对该连接关闭（只有 AI 侧经 MCP 使用），
  // 前端已禁用入口，此处为服务端强制——避免直接构造 WS 请求绕过。
  if (host.scope === 'mcp') {
    sessionManager.releaseReservation(identity.id);
    auditDenied(audit, identity, hostId, 'terminal_not_allowed');
    return ws.close(4003, 'terminal_not_allowed');
  }

  // 指纹未确认：捕获当前指纹供使用者显式确认，禁止静默接受（FR-007）
  if (!host.fingerprint) {
    let pending = host.pendingFingerprint ?? null;
    if (!pending) {
      const connectTimeoutMs = deps.config?.limits?.connectTimeoutMs ?? 10000;
      try {
        // 跳板机连接的目标多为内网地址，本机直连不可达——必须经跳板通道捕获指纹；
        // 跳板不可用（无凭据/指纹未确认）或跳板捕获失败时回退直连探测（原行为）
        let captured = null;
        if (host.connectVia === 'jump' && host.jumpHostId && host.jumpHostId !== host.id) {
          const jump = await store.getHost(host.jumpHostId, identity.id);
          if (jump && jump.connectVia !== 'jump' && jump.secret && jump.fingerprint) {
            captured = await captureFingerprintViaJump({
              jump: {
                host: jump.host,
                port: jump.port,
                username: jump.username,
                secret: decryptSecret(deps.masterKey, jump.secret),
                connectTimeoutMs,
                expectedFingerprint: jump.fingerprint,
              },
              target: { host: host.host, port: host.port },
              connectTimeoutMs,
            }).catch(() => null);
          }
        }
        pending =
          captured ??
          (await captureFingerprint({
            host: host.host,
            port: host.port,
            connectTimeoutMs,
          }));
        await deps.store.touchHost(host.id, { pendingFingerprint: pending });
      } catch {
        /* 捕获失败（不可达等）：仍以未确认关闭，不区分原因以免泄漏 */
      }
    }
    sessionManager.releaseReservation(identity.id);
    auditDenied(audit, identity, hostId, 'fingerprint_unconfirmed');
    return ws.close(4005, pending ? `fingerprint_unconfirmed:${pending}` : 'fingerprint_unconfirmed');
  }

  // 私钥口令/连接密码票据（可选）：一次性消费，校验票据绑定本机与本用户，凭据仅存在于内存
  let passphrase;
  let password;
  const pt = url.searchParams.get('pt');
  if (pt) {
    const entry = consumePassTicket(pt);
    if (!entry || entry.ownerId !== identity.id || entry.hostId !== host.id) {
      sessionManager.releaseReservation(identity.id);
      auditDenied(audit, identity, hostId, 'invalid_pass_ticket');
      return ws.close(4009, 'invalid_pass_ticket');
    }
    passphrase = entry.passphrase;
    password = entry.password;
  }

  // none（不记录凭据）主机：没有票据密码就无法认证，直接以 password_required 关闭让客户端弹输入框
  if (host.authType === 'none' && !password) {
    sessionManager.releaseReservation(identity.id);
    // 审计留痕：新建 none 主机保存后首次连接必然走此分支，漏记会导致操作审计无连接记录
    auditDenied(audit, identity, hostId, 'password_required');
    return ws.close(4006, 'password_required');
  }

  await sessionManager.createSession({ ws, host, identity, passphrase, password });
}

function auditDenied(audit, identity, hostId, reason) {
  audit.log({
    actor: identity.id,
    actorType: 'user',
    hostId,
    event: 'connect-attempt',
    result: 'denied',
    reason,
  });
}

// WebSocket 升级与握手校验（宪法 I + contracts/ws-terminal.md）
// HTTP 层拒绝：403 未授权 Origin、400 version 非法/多余参数
// WS 层关闭码：4001 未授权、4003 主机不在授权范围、4004 并发上限、4005 指纹未确认
import { WebSocketServer } from 'ws';
import { resolveIdentity } from './auth.js';
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

function rejectHandshake(socket, status, message) {
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
      return rejectHandshake(socket, 400, 'Bad Request');
    }
    if (url.pathname !== '/ws/terminal') {
      return rejectHandshake(socket, 404, 'Not Found');
    }

    // 宪法 VIII：WS 握手参数必须携带 version；不支持的版本拒绝
    if (url.searchParams.get('version') !== String(PROTOCOL_VERSION)) {
      return rejectHandshake(socket, 400, 'Bad Request');
    }

    // 契约：查询参数只允许 hostId 与 version（不接受客户端指定 host/port/凭据）
    const extra = [...url.searchParams.keys()].filter(
      (k) => k !== 'hostId' && k !== 'version'
    );
    if (extra.length > 0) {
      return rejectHandshake(socket, 400, 'Bad Request');
    }

    if (!originAllowed(req, deps.config)) {
      return rejectHandshake(socket, 403, 'Forbidden');
    }

    const identity = resolveIdentity(req, deps.runtime);
    if (!identity) {
      return rejectHandshake(socket, 401, 'Unauthorized');
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

  // 主机只能来自授权清单且归属本人（FR-001/009/020）
  const host = hostId ? await store.getHost(hostId, identity.id) : undefined;
  if (!host) {
    auditDenied(audit, identity, hostId, 'host_not_allowed');
    return ws.close(4003, 'host_not_allowed');
  }

  // 指纹未确认：显式要求使用者确认，禁止静默接受（FR-007）
  if (!host.fingerprint) {
    auditDenied(audit, identity, hostId, 'fingerprint_unconfirmed');
    return ws.close(4005, 'fingerprint_unconfirmed');
  }

  // 并发会话上限（FR-019）
  if (!sessionManager.canCreate(identity.id)) {
    auditDenied(audit, identity, hostId, 'session_limit');
    return ws.close(4004, 'session_limit');
  }

  await sessionManager.createSession({ ws, host, identity });
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

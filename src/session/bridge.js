// WS ↔ SSH 双向桥接（contracts/ws-terminal.md 时序）
// 0x00 数据原样透传；0x01 resize → setWindow；0x02 signal → 白名单信号
// 空闲超时：任一方向有数据即重置计时（FR-014）
import { encodeDataFrame, parseClientFrame } from '../../web/src/protocol/frames.js';

/**
 * @param {{ws: import('ws').WebSocket, stream: import('ssh2').Channel,
 *   session: object, idleTimeoutMs: number, audit: object,
 *   onSessionEnd: (endReason: string, wsCloseCode: number) => void}} opts
 */
export function bridgeSession({ ws, stream, session, idleTimeoutMs, audit, onSessionEnd }) {
  let ended = false;
  let idleTimer = null;

  const touchIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // 空闲超时：断开会话并告知原因（关闭码 4010）
      onSessionEnd('idle-timeout', 4010);
    }, idleTimeoutMs);
  };

  const end = (reason, code) => {
    if (ended) return;
    ended = true;
    if (idleTimer) clearTimeout(idleTimer);
    try {
      stream.end();
    } catch {
      /* 忽略 */
    }
    onSessionEnd(reason, code);
  };

  // —— 上行：浏览器 → 远端 ——
  ws.on('message', (data, isBinary) => {
    if (ended) return;
    if (!isBinary) {
      // 契约：所有消息必须为二进制帧
      audit.log({
        actor: session.ownerId,
        actorType: 'user',
        hostId: session.hostId,
        event: 'command',
        result: 'denied',
        reason: 'non-binary-frame',
      });
      return;
    }
    const frame = parseClientFrame(data);
    switch (frame.type) {
      case 'data':
        touchIdle();
        stream.write(frame.payload);
        break;
      case 'resize':
        touchIdle();
        stream.setWindow(frame.rows, frame.cols, 0, 0);
        break;
      case 'signal':
        touchIdle();
        stream.signal(frame.signal);
        break;
      default:
        // 非法控制帧：丢弃并计入审计（契约：非法 cols/rows 丢弃并计入审计）
        audit.log({
          actor: session.ownerId,
          actorType: 'user',
          hostId: session.hostId,
          event: 'command',
          result: 'denied',
          reason: `invalid-frame:${frame.reason}`,
        });
    }
  });

  // —— 下行：远端 → 浏览器 ——
  stream.on('data', (chunk) => {
    if (ended) return;
    touchIdle();
    if (ws.readyState === ws.OPEN) {
      ws.send(encodeDataFrame(chunk), { binary: true });
    }
  });

  ws.on('close', () => end('user', 1000));
  ws.on('error', () => end('network', 1006));

  stream.on('close', () => end(session.endReason ?? 'error', 1000));
  stream.on('error', () => end('error', 1011));

  // 启动空闲计时
  touchIdle();
}

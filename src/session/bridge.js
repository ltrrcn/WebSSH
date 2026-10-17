// WS ↔ SSH 双向桥接（contracts/ws-terminal.md 时序）
// 0x00 数据原样透传；0x01 resize → setWindow；0x02 signal → 白名单信号
// 空闲超时：任一方向有数据即重置计时（FR-014）
// 命令审计：从上行终端输入流按行重组，回车提交时记录命令原文（脱敏由审计层完成）
// 可选输出摘要：按提示符或 shell 标记结束命令，排除输入回显并按提交顺序归属输出
import { encodeDataFrame, encodeMetaFrame, parseClientFrame } from '../../web/src/protocol/frames.js';
import { createCommandRecorder } from './command-recorder.js';

/** WS 就绪态常量（避免依赖实例属性） */
const WS_OPEN = 1;
/** detached 期间的输出缓冲上限（超出丢弃最旧，防内存膨胀） */
const MAX_BUFFER_BYTES = 256 * 1024;

/**
 * @param {{ws: import('ws').WebSocket, stream: import('ssh2').Channel,
 *   session: object, idleTimeoutMs: number, detachedTtlMs?: number, audit: object, config: object,
 *   onSessionEnd: (endReason: string, wsCloseCode: number) => void,
 *   onDetach?: () => void}} opts
 * @returns {{attach: (ws: import('ws').WebSocket) => boolean, detach: () => void}}
 */
export function bridgeSession({ ws, stream, session, idleTimeoutMs, detachedTtlMs = 0, audit, config, onSessionEnd, onDetach }) {
  let ended = false;
  let detached = false;
  let idleTimer = null;
  let currentWs = ws;
  // detached 期间远端输出先入缓冲，重新接管时回放
  let buffer = [];
  let bufferedBytes = 0;
  // 开关运行时读取：设置页热改 config 后即刻生效，无需重开会话
  const getOutputCfg = () => ({
    enabled: config?.audit?.recordTerminalOutput === true,
    digestBytes: config?.limits?.outputDigestBytes ?? 2048,
  });
  const recorder = createCommandRecorder(session, audit, getOutputCfg);

  // 会话元信息下发（FR-058）：前端据此把本地会话卡与审计里的服务端会话 ID 对应，
  // 便于在「命令审计」中定位后台运行/已断开的会话并继续连接
  const sendMeta = (w) => {
    if (w && w.readyState === WS_OPEN) {
      try {
        w.send(encodeMetaFrame({ sessionId: session.id }), { binary: true });
      } catch {
        /* 下发失败不影响终端透传 */
      }
    }
  };
  sendMeta(ws);

  const touchIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // 空闲超时：断开会话并告知原因（关闭码 4010）
      finalize('idle-timeout', 4010);
    }, idleTimeoutMs);
  };

  /** 真正销毁：释放 SSH 通道并结束会话 */
  const finalize = (reason, code) => {
    if (ended) return;
    ended = true;
    if (idleTimer) clearTimeout(idleTimer);
    try {
      recorder.flush(); // 会话结束：未完成的命令记录落盘
    } catch {
      /* 忽略 */
    }
    try {
      stream.end();
    } catch {
      /* 忽略 */
    }
    onSessionEnd(reason, code);
  };

  /** 挂起：解绑 WS、保留 SSH 连接，远端输出转入缓冲（FR-059） */
  const detach = () => {
    if (ended || detached) return;
    // 未启用保活（detachedTtlMs<=0）：维持旧语义，断线即释放
    if (!(detachedTtlMs > 0)) {
      finalize('network', 1006);
      return;
    }
    detached = true;
    if (idleTimer) clearTimeout(idleTimer);
    unbindWs(currentWs);
    currentWs = null;
    onDetach?.(); // 由 manager 置状态、记审计并启动 TTL
  };

  /** 重新接管：绑定新 WS 并回放缓冲输出 */
  const attach = (newWs) => {
    if (ended || !detached) return false;
    detached = false;
    currentWs = newWs;
    bindWs(newWs);
    sendMeta(newWs);
    for (const chunk of buffer) {
      if (newWs.readyState !== WS_OPEN) break;
      try {
        newWs.send(encodeDataFrame(chunk), { binary: true });
      } catch {
        break;
      }
    }
    buffer = [];
    bufferedBytes = 0;
    touchIdle();
    return true;
  };

  const pushBuffer = (chunk) => {
    buffer.push(chunk);
    bufferedBytes += chunk.length;
    while (bufferedBytes > MAX_BUFFER_BYTES && buffer.length > 1) {
      bufferedBytes -= buffer.shift().length;
    }
  };

  // —— 上行：浏览器 → 远端 ——
  const onMessage = (data, isBinary) => {
    if (ended) return;
    if (!isBinary) {
      // 契约：所有消息必须为二进制帧
      audit.log({
        actor: session.ownerId,
        actorType: 'user',
        hostId: session.hostId,
        sessionId: session.id,
        event: 'command',
        result: 'denied',
        reason: '非二进制帧（拒绝）',
      });
      return;
    }
    const frame = parseClientFrame(data);
    switch (frame.type) {
      case 'data':
        touchIdle();
        try {
          recorder.feed(frame.payload);
        } catch {
          /* 审计失败不阻断透传 */
        }
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
          sessionId: session.id,
          event: 'command',
          result: 'denied',
          reason: `非法帧:${frame.reason}`,
        });
    }
  };

  const onWsClose = (code) => {
    if (ended || detached) return;
    // 1000 = 客户端主动关闭（点「关闭会话」）→ 立即释放 SSH；
    // 其余（刷新/关窗口 1001、网络异常 1006 等）→ 挂起保活，等待重新接管
    if (code === 1000) finalize('user', 1000);
    else detach();
  };
  const onWsError = () => {
    if (ended || detached) return;
    detach();
  };

  function bindWs(w) {
    if (!w) return;
    w.on('message', onMessage);
    w.on('close', onWsClose);
    w.on('error', onWsError);
  }
  function unbindWs(w) {
    if (!w) return;
    w.off('message', onMessage);
    w.off('close', onWsClose);
    w.off('error', onWsError);
  }
  bindWs(ws);

  // —— 下行：远端 → 浏览器 ——
  stream.on('data', (chunk) => {
    if (ended) return;
    if (!detached) touchIdle();
    try {
      recorder.onOutput(chunk);
    } catch {
      /* 审计失败不阻断透传 */
    }
    if (currentWs && currentWs.readyState === WS_OPEN) {
      currentWs.send(encodeDataFrame(chunk), { binary: true });
    } else if (!ended) {
      pushBuffer(chunk); // 无 WS（已挂起/正在关闭）：缓冲等接管后回放
    }
  });

  stream.on('close', () => finalize(session.endReason ?? 'error', 1000));
  stream.on('error', () => finalize('error', 1011));

  // 启动空闲计时
  touchIdle();

  return { attach, detach };
}

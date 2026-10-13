// WS ↔ SSH 双向桥接（contracts/ws-terminal.md 时序）
// 0x00 数据原样透传；0x01 resize → setWindow；0x02 signal → 白名单信号
// 空闲超时：任一方向有数据即重置计时（FR-014）
// 命令审计：从上行终端输入流按行重组，回车提交时记录命令原文（脱敏由审计层完成）
// 可选输出摘要：config.audit.recordTerminalOutput 开启后，命令事件延迟落盘并附带
// 其输出摘要（清洗 ANSI + redact 脱敏 + outputDigestBytes 截断）；默认关闭不改变行为
import { encodeDataFrame, encodeMetaFrame, parseClientFrame } from '../../web/src/protocol/frames.js';
import { redact, truncateDigest } from '../crypto/redact.js';

// ANSI 转义序列清洗（CSI / OSC / 其余控制字符，保留换行）
function stripAnsi(text) {
  return String(text)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '') // CSI
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '') // OSC
    .replace(/[\x00-\x09\x0b-\x1a\x1c-\x1f\x7f]/g, ''); // 除 \n 外控制字符
}

/**
 * 命令行重组器：处理用户键入的可见字符，遇 Enter 提交审计。
 * 覆盖：退格（\x7f）删末字符；Ctrl+C / Ctrl+U 作废当前行；Tab/方向键等
 * 控制与转义序列不进入命令文本（补全与历史调出后的最终行以实际键入为准）。
 *
 * 输出摘要模式（recordTerminalOutput=true）：命令提交后暂存为 pending，
 * 其后下行输出视为该命令的输出持续收集，直到下一条命令提交或会话结束时
 * 一并落盘（含脱敏截断的 outputDigest）。关闭时保持回车立即落盘。
 *
 * @param {{ownerId: string, hostId: string}} session
 * @param {object} audit
 * @param {() => {enabled: boolean, digestBytes: number}} getOutputCfg 运行时读取开关
 */
function createCommandRecorder(session, audit, getOutputCfg) {
  let line = '';
  let pending = null; // { command, output }
  // 事件公共字段（含会话 ID：关联同一会话的命令记录）
  const base = () => ({
    actor: session.ownerId,
    actorType: 'user',
    hostId: session.hostId,
    sessionId: session.id,
  });

  const flushPending = () => {
    if (!pending) return;
    const { command, output } = pending;
    pending = null;
    const { digestBytes } = getOutputCfg();
    const ev = {
      ...base(),
      event: 'command',
      result: 'success',
      command,
    };
    if (output.trim()) {
      ev.outputDigest = redact(truncateDigest(stripAnsi(output), digestBytes).content);
    }
    audit.log(ev);
  };

  return {
    /** 上行输入重组 */
    feed(payload) {
      const text = payload.toString('utf8');
      for (const ch of text) {
        const code = ch.codePointAt(0);
        if (ch === '\r' || ch === '\n') {
          const cmd = line;
          line = '';
          if (cmd.trim()) {
            if (getOutputCfg().enabled) {
              flushPending(); // 上一条命令连同其输出落盘
              pending = { command: cmd.slice(0, 2000), output: '' };
            } else {
              audit.log({
                ...base(),
                event: 'command',
                result: 'success',
                command: cmd.slice(0, 2000),
              });
            }
          }
        } else if (ch === '\x7f') {
          line = line.slice(0, -1);
        } else if (ch === '\x03' || ch === '\x15') {
          line = ''; // 中断/清行：作废未提交内容
        } else if (code >= 0x20 && code !== 0x7f) {
          line += ch;
        }
        // 其余控制字节（Tab 补全、ESC 转义序列）忽略
      }
    },
    /** 下行输出收集（仅摘要模式下为 pending 命令收集，收满 2×digestBytes 即止） */
    onOutput(chunk) {
      if (!pending) return;
      const cap = getOutputCfg().digestBytes * 2;
      if (pending.output.length >= cap) return;
      pending.output += chunk.toString('utf8');
      if (pending.output.length > cap) pending.output = pending.output.slice(0, cap);
    },
    /** 会话结束时落盘最后一条 pending 命令 */
    flush: flushPending,
  };
}

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
      recorder.flush(); // 会话结束：最后一条 pending 命令连同输出落盘
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
        reason: 'non-binary-frame',
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
          reason: `invalid-frame:${frame.reason}`,
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
      recorder.onOutput(chunk); // 输出摘要收集（仅开关开启且有 pending 命令时生效）
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

// WS ↔ SSH 双向桥接（contracts/ws-terminal.md 时序）
// 0x00 数据原样透传；0x01 resize → setWindow；0x02 signal → 白名单信号
// 空闲超时：任一方向有数据即重置计时（FR-014）
// 命令审计：从上行终端输入流按行重组，回车提交时记录命令原文（脱敏由审计层完成）
// 可选输出摘要：config.audit.recordTerminalOutput 开启后，命令事件延迟落盘并附带
// 其输出摘要（清洗 ANSI + redact 脱敏 + outputDigestBytes 截断）；默认关闭不改变行为
import { encodeDataFrame, parseClientFrame } from '../../web/src/protocol/frames.js';
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

/**
 * @param {{ws: import('ws').WebSocket, stream: import('ssh2').Channel,
 *   session: object, idleTimeoutMs: number, audit: object, config: object,
 *   onSessionEnd: (endReason: string, wsCloseCode: number) => void}} opts
 */
export function bridgeSession({ ws, stream, session, idleTimeoutMs, audit, config, onSessionEnd }) {
  let ended = false;
  let idleTimer = null;
  // 开关运行时读取：设置页热改 config 后即刻生效，无需重开会话
  const getOutputCfg = () => ({
    enabled: config?.audit?.recordTerminalOutput === true,
    digestBytes: config?.limits?.outputDigestBytes ?? 2048,
  });
  const recorder = createCommandRecorder(session, audit, getOutputCfg);

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

  // —— 上行：浏览器 → 远端 ——
  ws.on('message', (data, isBinary) => {
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
  });

  // —— 下行：远端 → 浏览器 ——
  stream.on('data', (chunk) => {
    if (ended) return;
    touchIdle();
    try {
      recorder.onOutput(chunk); // 输出摘要收集（仅开关开启且有 pending 命令时生效）
    } catch {
      /* 审计失败不阻断透传 */
    }
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

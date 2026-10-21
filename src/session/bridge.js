// WS ↔ SSH 双向桥接（contracts/ws-terminal.md 时序）
// 0x00 数据原样透传；0x01 resize → setWindow；0x02 signal → 白名单信号
// 空闲超时：任一方向有数据即重置计时（FR-014）
// 命令审计：从上行终端输入流按行重组，回车提交时记录命令原文（脱敏由审计层完成）
// 可选输出摘要：按提示符或 shell 标记结束命令，排除输入回显并按提交顺序归属输出
import { encodeDataFrame, encodeMetaFrame, parseClientFrame } from '../../web/src/protocol/frames.js';
import { createCommandRecorder } from './command-recorder.js';
import { checkHostBlocklist } from '../ssh/policy.js';

/** WS 就绪态常量（避免依赖实例属性） */
const WS_OPEN = 1;
/** detached 期间的输出缓冲上限（超出丢弃最旧，防内存膨胀） */
const MAX_BUFFER_BYTES = 256 * 1024;

/**
 * 命令黑名单输入闸门（高级页 blockedCommands 的终端侧执行点）：
 * 字符级跟踪当前输入行（与审计记录器同源的解析语义），Enter 提交时若
 * 首词命中黑名单 → 剥掉该次 Enter、注入 Ctrl+C 取消远端行，由调用方回执提示。
 * 尽力而为语义：方向键/历史回溯/括号粘贴等逃逸序列会让行跟踪失步，
 * 该行保守放行（防误拦正常操作），下一行恢复跟踪。
 * 硬边界仍在 MCP run_command 与 quick-exec（服务端精确校验）。
 * @param {string[]} blocked 黑名单（单个命令词）
 * @param {(hit: string, line: string) => void} onBlocked 命中回调（用于回执与审计）
 */
export function createInputGate(blocked, onBlocked) {
  let line = '';
  let desynced = false;
  let esc = 'text'; // text | esc | csi | ss3
  return {
    /** 过滤一段输入：返回应发往远端的文本（命中的 Enter 被替换为 Ctrl+C） */
    filter(text) {
      let out = '';
      for (const ch of text) {
        if (esc === 'esc') {
          esc = ch === '[' ? 'csi' : ch === 'O' ? 'ss3' : 'text';
          out += ch;
          continue;
        }
        if (esc === 'csi' || esc === 'ss3') {
          if (ch >= '@' && ch <= '~') esc = 'text';
          out += ch;
          continue;
        }
        if (ch === '\x1b') {
          esc = 'esc';
          desynced = true; // 方向键/历史回溯/编辑序列：本行放弃跟踪
          out += ch;
          continue;
        }
        if (ch === '\r' || ch === '\n') {
          const submitted = desynced ? '' : line;
          line = '';
          desynced = false;
          const hit = submitted ? checkHostBlocklist(submitted, blocked) : null;
          if (hit) {
            out += '\x03'; // 取消远端待执行行
            onBlocked(hit, submitted);
          } else {
            out += ch;
          }
          continue;
        }
        if (ch === '\x7f' || ch === '\b') {
          line = Array.from(line).slice(0, -1).join('');
          out += ch;
          continue;
        }
        if (ch === '\x03' || ch === '\x15') {
          line = '';
          out += ch;
          continue;
        }
        if (ch.codePointAt(0) >= 0x20 && ch.codePointAt(0) !== 0x7f) {
          if (line.length < 8192) line += ch;
          out += ch;
          continue;
        }
        out += ch; // Tab / 其他控制字符透传（Tab 补全造成的行偏差由词级匹配容忍）
      }
      return out;
    },
  };
}

/**
 * @param {{ws: import('ws').WebSocket, stream: import('ssh2').Channel,
 *   session: object, idleTimeoutMs: number, detachedTtlMs?: number, audit: object, config: object,
 *   onSessionEnd: (endReason: string, wsCloseCode: number) => void,
 *   onDetach?: () => void}} opts
 * @returns {{attach: (ws: import('ws').WebSocket) => boolean, detach: () => void}}
 */
export function bridgeSession({ ws, stream, session, idleTimeoutMs, detachedTtlMs = 0, audit, config, onSessionEnd, onDetach, auditOutputOverride = null, blockedCommands = null }) {
  let ended = false;
  let detached = false;
  let idleTimer = null;
  let currentWs = ws;
  // detached 期间远端输出先入缓冲，重新接管时回放
  let buffer = [];
  let bufferedBytes = 0;
  // 开关运行时读取：设置页热改 config 后即刻生效，无需重开会话；
  // 连接级覆盖（高级页 auditOutput 'on'/'off'）优先于全局
  const getOutputCfg = () => ({
    enabled:
      auditOutputOverride === 'on'
        ? true
        : auditOutputOverride === 'off'
          ? false
          : config?.audit?.recordTerminalOutput === true,
    digestBytes: config?.limits?.outputDigestBytes ?? 2048,
  });
  const recorder = createCommandRecorder(session, audit, getOutputCfg);
  // 命令黑名单闸门：命中 → 终端回执红字提示 + 审计留痕（denied）
  const gate = Array.isArray(blockedCommands) && blockedCommands.length
    ? createInputGate(blockedCommands, (hit, cmdLine) => {
        try {
          if (currentWs && currentWs.readyState === WS_OPEN) {
            currentWs.send(encodeDataFrame(`\r\n\x1b[31m—— 命令被拒绝：该连接的黑名单禁用了「${hit}」——\x1b[0m\r\n`), { binary: true });
          }
        } catch {
          /* 回执失败不影响拦截 */
        }
        try {
          audit.log({
            actor: session.ownerId,
            actorType: 'user',
            hostId: session.hostId,
            sessionId: session.id,
            event: 'command',
            result: 'denied',
            reason: `command_blocked_by_host:${hit}`,
            command: cmdLine.slice(0, 2000),
          });
        } catch {
          /* 审计失败不影响拦截 */
        }
      })
    : null;

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
    // 0 = 永不断开（连接级覆盖，见「高级」页空闲断开设置）
    if (!idleTimeoutMs) return;
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
        // 命令黑名单（高级页）：终端输入侧尽力拦截；命中时替换 Enter 为 Ctrl+C 并回执
        if (gate) {
          const raw = typeof frame.payload === 'string' ? frame.payload : Buffer.from(frame.payload).toString('utf8');
          const filtered = gate.filter(raw);
          stream.write(Buffer.from(filtered, 'utf8'));
        } else {
          stream.write(frame.payload);
        }
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

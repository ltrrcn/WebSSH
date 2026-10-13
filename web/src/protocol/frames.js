// WS 终端协议帧编解码（contracts/ws-terminal.md Version 1）
// 前后端共享的唯一帧定义（宪法 IV）。
// 实现 MUST 同构：只使用 Uint8Array/TextEncoder/TextDecoder（浏览器与 Node 均可用），
// 禁止使用 Node 专有的 Buffer —— 否则浏览器端输入即抛「Buffer is not defined」。

export const FrameType = {
  DATA: 0x00, // 双向：终端数据（原始字节流，不解析为文本）
  RESIZE: 0x01, // C→S：窗口尺寸变更 {cols, rows}
  SIGNAL: 0x02, // C→S：信号 {signal: "INT"}
  SESSION: 0x03, // S→C：会话元信息 {sessionId}（下发一次，用于与审计记录对应）
};

/** 服务端版本（握手 version 参数必须等于该值） */
export const PROTOCOL_VERSION = 1;

/** resize 合法范围（契约：1–1000 的整数） */
const DIM_MIN = 1;
const DIM_MAX = 1000;

/** 信号白名单（初始仅 INT） */
const SIGNALS = new Set(['INT']);

const encoder = /* @__PURE__ */ new TextEncoder();
const decoder = /* @__PURE__ */ new TextDecoder();

/** 任意输入归一化为 Uint8Array（浏览器 string / Node Buffer 均可） */
function toBytes(input) {
  if (input instanceof Uint8Array) return input; // Buffer 是 Uint8Array 子类
  if (typeof input === 'string') return encoder.encode(input);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return encoder.encode(String(input));
}

/** 编码 0x00 数据帧（返回 Uint8Array，可直接 ws.send） */
export function encodeDataFrame(payload) {
  const body = toBytes(payload);
  const out = new Uint8Array(1 + body.length);
  out[0] = FrameType.DATA;
  out.set(body, 1);
  return out;
}

/** 编码 0x03 会话元信息帧（S→C，建连就绪后下发一次） */
export function encodeMetaFrame(meta) {
  const body = encoder.encode(JSON.stringify(meta ?? {}));
  const out = new Uint8Array(1 + body.length);
  out[0] = FrameType.SESSION;
  out.set(body, 1);
  return out;
}

/**
 * 解析客户端帧。
 * @param {Uint8Array | Buffer | ArrayBuffer} data 二进制消息
 * @returns {{type:'data', payload: Uint8Array}
 *   | {type:'resize', cols:number, rows:number}
 *   | {type:'signal', signal:string}
 *   | {type:'invalid', reason:string}}
 */
export function parseClientFrame(data) {
  const buf = toBytes(data);
  if (buf.length === 0) return { type: 'invalid', reason: 'empty-frame' };
  const kind = buf[0];
  const body = buf.subarray(1);

  if (kind === FrameType.DATA) {
    return { type: 'data', payload: body };
  }

  if (kind === FrameType.RESIZE || kind === FrameType.SIGNAL) {
    let obj;
    try {
      obj = JSON.parse(decoder.decode(body));
    } catch {
      return { type: 'invalid', reason: 'bad-json' };
    }
    if (kind === FrameType.RESIZE) {
      const { cols, rows } = obj ?? {};
      if (
        !Number.isInteger(cols) || !Number.isInteger(rows) ||
        cols < DIM_MIN || cols > DIM_MAX || rows < DIM_MIN || rows > DIM_MAX
      ) {
        return { type: 'invalid', reason: 'bad-resize' };
      }
      return { type: 'resize', cols, rows };
    }
    if (typeof obj?.signal !== 'string' || !SIGNALS.has(obj.signal)) {
      return { type: 'invalid', reason: 'bad-signal' };
    }
    return { type: 'signal', signal: obj.signal };
  }

  return { type: 'invalid', reason: 'unknown-type' };
}

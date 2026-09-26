// WS 终端协议帧编解码（contracts/ws-terminal.md Version 1）
// 前后端共享的唯一帧定义（宪法 IV）；浏览器与 Node 均可直接 import（纯 ESM，无构建）。

export const FrameType = {
  DATA: 0x00, // 双向：终端数据（原始字节流，不解析为文本）
  RESIZE: 0x01, // C→S：窗口尺寸变更 {cols, rows}
  SIGNAL: 0x02, // C→S：信号 {signal: "INT"}
};

/** 服务端版本（握手 version 参数必须等于该值） */
export const PROTOCOL_VERSION = 1;

/** resize 合法范围（契约：1–1000 的整数） */
const DIM_MIN = 1;
const DIM_MAX = 1000;

/** 信号白名单（初始仅 INT） */
const SIGNALS = new Set(['INT']);

/** 编码 0x00 数据帧 */
export function encodeDataFrame(payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return Buffer.concat([Buffer.from([FrameType.DATA]), body]);
}

/**
 * 解析客户端帧。
 * @param {Buffer} data 二进制消息
 * @returns {{type:'data', payload: Buffer}
 *   | {type:'resize', cols:number, rows:number}
 *   | {type:'signal', signal:string}
 *   | {type:'invalid', reason:string}}
 */
export function parseClientFrame(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length === 0) return { type: 'invalid', reason: 'empty-frame' };
  const kind = buf[0];
  const body = buf.subarray(1);

  if (kind === FrameType.DATA) {
    return { type: 'data', payload: body };
  }

  if (kind === FrameType.RESIZE || kind === FrameType.SIGNAL) {
    let obj;
    try {
      obj = JSON.parse(body.toString('utf8'));
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

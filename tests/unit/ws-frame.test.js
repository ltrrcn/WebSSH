// WS 帧编解码（contracts/ws-terminal.md）：
// 所有消息为二进制帧，首字节为帧类型，其余为负载；0x00 负载不得被解析为文本。
// 本模块为前后端共享的唯一帧定义（宪法 IV：共享类型定义）。
import { test } from 'node:test';
import assert from 'node:assert';
import { FrameType, encodeDataFrame, parseClientFrame } from '../../web/src/protocol/frames.js';

test('0x00 数据帧：任意二进制字节原样透传', () => {
  const payload = Buffer.from([0xff, 0x00, 0x0a, 0x1b, 0x5b, 0x41, 0xe4, 0xb8, 0xad]);
  const frame = encodeDataFrame(payload);
  assert.equal(frame[0], FrameType.DATA);
  const parsed = parseClientFrame(frame);
  assert.equal(parsed.type, 'data');
  assert.ok(Buffer.from(parsed.payload).equals(payload));
});

test('0x00 数据帧：多字节 UTF-8 与控制字符完整保留', () => {
  const text = '中文测试\r\n\x1b[31mred\x1b[0m';
  const frame = encodeDataFrame(Buffer.from(text, 'utf8'));
  const parsed = parseClientFrame(frame);
  assert.equal(Buffer.from(parsed.payload).toString('utf8'), text);
});

test('0x01 resize 帧：合法 cols/rows 解析', () => {
  const frame = Buffer.concat([Buffer.from([FrameType.RESIZE]), Buffer.from(JSON.stringify({ cols: 120, rows: 30 }))]);
  const parsed = parseClientFrame(frame);
  assert.equal(parsed.type, 'resize');
  assert.equal(parsed.cols, 120);
  assert.equal(parsed.rows, 30);
});

test('0x01 resize 帧：非法值（越界/非整数/缺字段/坏 JSON）→ invalid', () => {
  const mk = (obj, raw = false) =>
    Buffer.concat([Buffer.from([FrameType.RESIZE]), Buffer.from(raw ? obj : JSON.stringify(obj))]);
  assert.equal(parseClientFrame(mk({ cols: 0, rows: 30 })).type, 'invalid');
  assert.equal(parseClientFrame(mk({ cols: 1001, rows: 30 })).type, 'invalid');
  assert.equal(parseClientFrame(mk({ cols: 1.5, rows: 30 })).type, 'invalid');
  assert.equal(parseClientFrame(mk({ cols: '120', rows: 30 })).type, 'invalid');
  assert.equal(parseClientFrame(mk({ cols: 120 })).type, 'invalid');
  assert.equal(parseClientFrame(mk('{broken', true)).type, 'invalid');
});

test('0x02 signal 帧：白名单内（INT）通过，其他拒绝', () => {
  const mk = (s) => Buffer.concat([Buffer.from([FrameType.SIGNAL]), Buffer.from(JSON.stringify({ signal: s }))]);
  const ok = parseClientFrame(mk('INT'));
  assert.equal(ok.type, 'signal');
  assert.equal(ok.signal, 'INT');
  assert.equal(parseClientFrame(mk('KILL')).type, 'invalid');
  assert.equal(parseClientFrame(mk('SIGKILL')).type, 'invalid');
});

test('未知帧类型 / 空帧 → invalid', () => {
  assert.equal(parseClientFrame(Buffer.from([0x07, 0x01])).type, 'invalid');
  assert.equal(parseClientFrame(Buffer.alloc(0)).type, 'invalid');
});

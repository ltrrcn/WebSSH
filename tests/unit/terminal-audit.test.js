import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { bridgeSession } from '../../src/session/bridge.js';
import { FrameType, encodeDataFrame } from '../../web/src/protocol/frames.js';

const prompt = 'xiaohuzi@FnOS:~/logs$ ';

function fixture(t, { enabled = true, detachedTtlMs = 0 } = {}) {
  const events = [];
  const writes = [];
  const sends = [];
  const stream = new EventEmitter();
  Object.assign(stream, {
    write: (payload) => writes.push(Buffer.from(payload)),
    end() {},
  });
  const makeWs = () => {
    const ws = new EventEmitter();
    Object.assign(ws, { readyState: 1, send: (frame) => sends.push(Buffer.from(frame)) });
    return ws;
  };
  const ws = makeWs();
  const bridge = bridgeSession({
    ws,
    stream,
    session: { id: 'S20261016133000', ownerId: 'test-user', hostId: 'test-host' },
    idleTimeoutMs: 60000,
    detachedTtlMs,
    audit: { log: (event) => events.push(event) },
    config: { audit: { recordTerminalOutput: enabled }, limits: { outputDigestBytes: 2048 } },
    onSessionEnd() {},
  });
  t.after(() => stream.emit('close'));
  return {
    events, writes, sends, stream, ws, bridge, makeWs,
    input: (text) => ws.emit('message', Buffer.from(encodeDataFrame(text)), true),
    output: (text) => stream.emit('data', Buffer.from(text)),
  };
}

test('终端审计：ll 完成即保存，后续 cat 回显不进入其摘要', (t) => {
  const f = fixture(t);
  f.output(prompt);
  f.input('ll\r');
  f.output(`ll\r\ntotal 1.2M\r\n${prompt}`);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].command, 'll');
  assert.equal(f.events[0].outputDigest.trim(), 'total 1.2M');
  f.input('cat local_worker.log');
  f.output('cat local_worker.log');
  assert.equal(f.events.length, 1);
  assert.ok(!f.events[0].outputDigest.includes('cat'));
  f.input('\r');
  f.output(`\r\nlog-content\r\n${prompt}`);
  assert.equal(f.events[1].command, 'cat local_worker.log');
  assert.equal(f.events[1].outputDigest.trim(), 'log-content');
});

test('终端审计：cd 空输出无需后续命令即可保存', (t) => {
  const f = fixture(t);
  f.output(prompt);
  f.input('cd lo\r');
  f.output(`cd lo\r\n${prompt}`);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].command, 'cd lo');
  assert.equal(f.events[0].outputDigest, undefined);
  f.input('ll\r');
  f.output(`ll\r\ndirectory-content\r\n${prompt}`);
  assert.equal(f.events[1].command, 'll');
  assert.equal(f.events[1].outputDigest.trim(), 'directory-content');
});

test('终端审计：同帧连续命令按顺序归属，不将所有输出归最后一条', (t) => {
  const f = fixture(t);
  f.output(prompt);
  f.input('echo one\recho two\recho three\r');
  f.output(`echo one\r\necho two\r\necho three\r\none\r\n${prompt}two\r\n${prompt}three\r\n${prompt}`);
  assert.deepEqual(f.events.map((event) => event.command), ['echo one', 'echo two', 'echo three']);
  assert.deepEqual(f.events.map((event) => event.outputDigest.trim()), ['one', 'two', 'three']);
});

test('终端审计：上行输入与下行输出字节原样透传', (t) => {
  const f = fixture(t);
  const input = Buffer.from('echo 中文\x1b[D\x7f\r');
  const output = Buffer.from('\x1b[32m中文\x1b[0m\r\n');
  f.input(input);
  f.output(output);
  assert.deepEqual(f.writes, [input]);
  const data = f.sends.filter((frame) => frame[0] === FrameType.DATA).map((frame) => frame.subarray(1));
  assert.deepEqual(data, [output]);
});

test('终端审计：保活断线期间仍完成命令，重新接管不重复记录', (t) => {
  const f = fixture(t, { detachedTtlMs: 60000 });
  f.output(prompt);
  f.input('echo detached\r');
  f.output('echo detached\r\n');
  f.ws.emit('close', 1006);
  f.output(`detached\r\n${prompt}`);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].outputDigest.trim(), 'detached');
  assert.equal(f.bridge.attach(f.makeWs()), true);
  f.stream.emit('close');
  assert.equal(f.events.length, 1);
});

test('终端审计：关闭摘要时仍保持回车立即记录与会话关联', (t) => {
  const f = fixture(t, { enabled: false });
  f.input('echo disabled\r');
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].command, 'echo disabled');
  assert.equal(f.events[0].sessionId, 'S20261016133000');
  f.output(`echo disabled\r\ndisabled\r\n${prompt}`);
  assert.equal(f.events[0].outputDigest, undefined);
});

// 单元：MCP 会话粘性注册表（src/mcp/session-registry.js）
import { test } from 'node:test';
import assert from 'node:assert';
import { createSessionRegistry, newMcpSessionId } from '../../src/mcp/session-registry.js';

const SID_RE = /^m_[0-9a-f]{12}$/;

test('无头调用：首次合成新会话，窗口内重复调用归同一会话', () => {
  const reg = createSessionRegistry({ getWindowMs: () => 60000 });
  const s1 = reg.resolve('tok1', null, 1000);
  const s2 = reg.resolve('tok1', null, 2000);
  const s3 = reg.resolve('tok1', null, 59000);
  assert.match(s1, SID_RE);
  assert.equal(s1, s2, '窗口内归同一粘性会话');
  assert.equal(s1, s3);
  assert.equal(reg.size(), 1);
});

test('静默超窗口：视为会话结束，下次调用开新会话', () => {
  const reg = createSessionRegistry({ getWindowMs: () => 60000 });
  const s1 = reg.resolve('tok1', null, 1000);
  const s2 = reg.resolve('tok1', null, 61000); // 超过 60s 静默
  assert.notEqual(s1, s2, '超窗口应开新会话');
  assert.match(s2, SID_RE);
});

test('带头调用：尊重客户端会话并绑定为当前会话，后续无头调用归入', () => {
  const reg = createSessionRegistry({ getWindowMs: () => 60000 });
  const clientSid = newMcpSessionId();
  assert.equal(reg.resolve('tok1', clientSid, 1000), clientSid, '带头时尊重客户端会话');
  assert.equal(reg.resolve('tok1', null, 2000), clientSid, '带头后无头调用归入该会话');
});

test('initialize 绑定：bind 后无头调用归入该会话', () => {
  const reg = createSessionRegistry({ getWindowMs: () => 60000 });
  const sid = newMcpSessionId();
  reg.bind('tok1', sid, 1000);
  assert.equal(reg.resolve('tok1', null, 2000), sid);
});

test('令牌隔离：不同令牌各自成会话，互不串扰', () => {
  const reg = createSessionRegistry({ getWindowMs: () => 60000 });
  const a = reg.resolve('tokA', null, 1000);
  const b = reg.resolve('tokB', null, 1000);
  assert.notEqual(a, b, '不同令牌不同会话');
  assert.equal(reg.resolve('tokA', null, 2000), a);
  assert.equal(reg.resolve('tokB', null, 2000), b);
});

test('会话结束（end）：解除粘性，下次调用开新会话', () => {
  const reg = createSessionRegistry({ getWindowMs: () => 60000 });
  const s1 = reg.resolve('tok1', null, 1000);
  reg.end('tok1');
  const s2 = reg.resolve('tok1', null, 2000);
  assert.notEqual(s1, s2, 'end 后应开新会话');
});

test('窗口=0：关闭粘性，无头调用维持无会话（null）原语义', () => {
  const reg = createSessionRegistry({ getWindowMs: () => 0 });
  assert.equal(reg.resolve('tok1', null, 1000), null, '无头 → null');
  const clientSid = newMcpSessionId();
  assert.equal(reg.resolve('tok1', clientSid, 2000), clientSid, '带头仍尊重客户端');
  assert.equal(reg.resolve('tok1', null, 3000), null, '带头之后无头仍为 null（不粘）');
});

test('滑动窗口：每次调用刷新活跃时间，长会话不中断', () => {
  const reg = createSessionRegistry({ getWindowMs: () => 60000 });
  const s1 = reg.resolve('tok1', null, 1000);
  // 每 50s 一次调用，持续 5 分钟——始终在窗口内，同一会话
  let t = 1000;
  for (let i = 0; i < 6; i++) {
    t += 50000;
    assert.equal(reg.resolve('tok1', null, t), s1, `第 ${i + 1} 次续期应保持同会话`);
  }
});

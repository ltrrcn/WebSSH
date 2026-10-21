// 命令黑名单输入闸门（bridge.createInputGate）：终端侧尽力拦截
import test from 'node:test';
import assert from 'node:assert';
import { createInputGate } from '../../src/session/bridge.js';

test('输入闸门：命中黑名单的 Enter 被替换为 Ctrl+C，正常命令透传', () => {
  const hits = [];
  const gate = createInputGate(['rm', 'shutdown'], (hit, line) => hits.push({ hit, line }));
  // 命中：整行 + Enter → 字符透传但 Enter 替换为 \x03
  const out1 = gate.filter('rm -rf /\r');
  assert.equal(out1, 'rm -rf /\x03');
  assert.deepEqual(hits, [{ hit: 'rm', line: 'rm -rf /' }]);
  // 正常命令：原样透传
  assert.equal(gate.filter('ls -la\r'), 'ls -la\r');
  assert.equal(hits.length, 1);
  // 退格修正后再提交：按修正后的行判定
  assert.equal(gate.filter('rmm\x7f -rf /\r'), 'rmm\x7f -rf /\x03');
  // Ctrl+C 清行后重新输入
  assert.equal(gate.filter('rm\x03ls\r'), 'rm\x03ls\r');
  // 方向键（历史回溯）后提交：保守放行（尽力而为）
  assert.equal(gate.filter('\x1b[A\r'), '\x1b[A\r');
  // 多行粘贴：逐 Enter 判定
  assert.equal(gate.filter('rm x\rwhoami\r'), 'rm x\x03whoami\r');
});

test('输入闸门：空黑名单不建闸', () => {
  const gate = createInputGate([], () => {});
  assert.equal(gate.filter('rm -rf /\r'), 'rm -rf /\r');
});

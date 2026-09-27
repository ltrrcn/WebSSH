// T072：命令三层判定（FR-030~034，contracts/mcp-tools.md）
import { test } from 'node:test';
import assert from 'node:assert';
import { checkCommand } from '../../src/ssh/policy.js';

const rules = {
  readOnlyCommands: ['ls', 'cat', 'head', 'tail', 'grep', 'ps', 'df', 'free', 'uname', 'whoami'],
  dangerousCommands: ['rm', 'dd', 'mkfs', 'shutdown', 'reboot', 'halt', 'chmod', 'chown', 'userdel'],
};

test('FR-034：拼接/重定向语法一律拒绝，不拆分放行', () => {
  for (const bad of [
    'ls; rm -rf /', 'ls && whoami', 'ls || whoami', 'cat a | grep b',
    'echo $(whoami)', 'echo `whoami`', 'echo hi > /etc/passwd', 'cat < /etc/shadow',
  ]) {
    assert.deepEqual(checkCommand(bad, rules, { level: 'writable' }), { allowed: false, reason: 'syntax_rejected' }, bad);
  }
});

test('FR-032：readonly 白名单默认拒绝（首词未列入即拒绝）', () => {
  assert.deepEqual(checkCommand('ls /', rules, { level: 'readonly' }), { allowed: true, reason: 'ok' });
  assert.deepEqual(checkCommand('curl http://x', rules, { level: 'readonly' }), { allowed: false, reason: 'not_in_readonly_whitelist' });
  assert.deepEqual(checkCommand('whoami', rules, { level: 'readonly' }), { allowed: true, reason: 'ok' });
  // 白名单内条目也不得包含可改变系统状态的命令（配置层面的约定由默认值保证）
  assert.ok(!rules.readOnlyCommands.includes('rm'));
});

test('FR-033：危险黑名单任何级别不放行（writable 同样拒绝）', () => {
  assert.deepEqual(checkCommand('rm -rf /tmp/x', rules, { level: 'writable' }), { allowed: false, reason: 'dangerous_command' });
  assert.deepEqual(checkCommand('shutdown now', rules, { level: 'writable' }), { allowed: false, reason: 'dangerous_command' });
  // readonly 级别：先命中白名单拒绝（rm 不在白名单）
  assert.equal(checkCommand('rm -rf /tmp', rules, { level: 'readonly' }).allowed, false);
});

test('writable 级别：非黑名单命令放行（白名单不参与，契约 run_command 判定顺序）', () => {
  assert.deepEqual(checkCommand('echo hello', rules, { level: 'writable' }), { allowed: true, reason: 'ok' });
  assert.deepEqual(checkCommand('systemctl status nginx', rules, { level: 'writable' }), { allowed: true, reason: 'ok' });
});

test('空/超长命令拒绝', () => {
  assert.equal(checkCommand('', rules).allowed, false);
  assert.equal(checkCommand('x'.repeat(5000), rules).allowed, false);
});

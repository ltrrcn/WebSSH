import { test } from 'node:test';
import assert from 'node:assert';

// FR-042 + SC-021：审计脱敏——检出疑似凭据与私钥内容即以占位符替换
import { redact, truncateDigest } from '../../src/crypto/redact.js';

test('PEM 私钥片段被整体替换为占位符', () => {
  const input = [
    'user ran a command',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'b3BlbnNzaC1rZXktdjEAAAAA',
    '-----END OPENSSH PRIVATE KEY-----',
  ].join('\n');
  const out = redact(input);
  assert.ok(!out.includes('b3BlbnNzaC1rZXktdjEAAAAA'), '私钥体不得残留');
  assert.ok(out.includes('[REDACTED'), '应出现占位符');
  assert.ok(out.includes('user ran a command'), '其余内容保留');
});

test('RSA/EC 私钥头同样被替换', () => {
  assert.ok(!redact('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----').includes('abc'));
  assert.ok(!redact('-----BEGIN PRIVATE KEY-----\nxyz\n-----END PRIVATE KEY-----').includes('xyz'));
});

test('口令赋值形式被脱敏（password=/passwd=/pass=）', () => {
  const out = redact('connect with password=hunter2 ok');
  assert.ok(!out.includes('hunter2'));
  assert.ok(out.includes('[REDACTED'));
  assert.ok(out.includes('connect with'), '前后文保留');
});

test('其余内容不受影响', () => {
  const input = 'ls -la /var/log && cat syslog | grep error';
  assert.equal(redact(input), input);
});

test('truncateDigest：超长输出截断到上限并标记', () => {
  const long = 'x'.repeat(5000);
  const { content, truncated } = truncateDigest(long, 1024);
  assert.equal(content.length, 1024);
  assert.equal(truncated, true);
});

test('truncateDigest：未超长时原样返回且不标记', () => {
  const { content, truncated } = truncateDigest('short', 1024);
  assert.equal(content, 'short');
  assert.equal(truncated, false);
});

test('redact 与 truncateDigest 组合：先脱敏再截断', () => {
  const secretTail = `password=leak-me ${'y'.repeat(4000)}`;
  const { content } = truncateDigest(redact(secretTail), 2048);
  assert.ok(!content.includes('leak-me'));
  assert.ok(content.length <= 2048);
});

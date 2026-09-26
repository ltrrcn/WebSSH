import { test } from 'node:test';
import assert from 'node:assert';

// FR-036/037/038/039 + spec Edge Cases：路径判定的全部安全规则
import { normalizeRequestPath, checkPathAccess } from '../../src/ssh/policy.js';

const ctx = () => ({
  // 与 config.json 默认一致（contracts/storage-schema.md）
  sensitivePaths: ['/etc/shadow', '/root/.ssh', '/home/*/.ssh'],
  matrix: [
    { prefix: '/var/log', read: true, write: false, download: false, modify: false, systemLevel: true },
    { prefix: '/tmp', read: true, write: true, download: false, modify: true, systemLevel: true },
  ],
});

test('FR-039: 含 .. 向上穿越语法的路径被拒绝，不做拼接判定', () => {
  const r = normalizeRequestPath('/var/log/../../etc/shadow');
  assert.equal(r, null);
});

test('FR-039: 无穿越语法的相对路径规范化为绝对路径', () => {
  assert.equal(normalizeRequestPath('var/log/x'), '/var/log/x');
  assert.equal(normalizeRequestPath('/var/log//x/'), '/var/log/x');
});

test('FR-036: 系统敏感路径恒定拒绝（读/写/下载/修改均不可）', () => {
  for (const op of ['read', 'write', 'download', 'modify']) {
    assert.equal(checkPathAccess('/etc/shadow', ctx(), op).allowed, false, `${op} 应被拒绝`);
    assert.equal(checkPathAccess('/etc/shadow', ctx(), op).reason, 'sensitive-path');
  }
});

test('FR-036: /home/*/.ssh 通配敏感条目命中任意用户家目录', () => {
  assert.equal(checkPathAccess('/home/alice/.ssh/id_ed25519', ctx(), 'read').reason, 'sensitive-path');
  assert.equal(checkPathAccess('/root/.ssh/authorized_keys', ctx(), 'read').reason, 'sensitive-path');
  // 子路径同样命中
  assert.equal(checkPathAccess('/root/.ssh/sub/x', ctx(), 'read').reason, 'sensitive-path');
});

test('FR-035: 矩阵最长前缀匹配决定权限', () => {
  assert.equal(checkPathAccess('/var/log/syslog', ctx(), 'read').allowed, true);
  assert.equal(checkPathAccess('/var/log/syslog', ctx(), 'write').allowed, false, '/var/log 不可写');
  assert.equal(checkPathAccess('/tmp/x', ctx(), 'write').allowed, true, '/tmp 可写');
});

test('FR-038: 系统级非敏感路径默认可读可修改', () => {
  assert.equal(checkPathAccess('/tmp/a/b/c', ctx(), 'read').allowed, true);
  assert.equal(checkPathAccess('/tmp/a/b/c', ctx(), 'modify').allowed, true);
});

test('FR-040: 令牌条目在系统级条目内收紧（最长前缀优先于父目录）', () => {
  const c = ctx();
  c.matrix.push({ prefix: '/tmp/strict', read: true, write: false, download: false, modify: false, source: 'token-override' });
  assert.equal(checkPathAccess('/tmp/strict/f', c, 'read').allowed, true);
  assert.equal(checkPathAccess('/tmp/strict/f', c, 'write').allowed, false, '子目录收紧后不可写');
  assert.equal(checkPathAccess('/tmp/other', c, 'write').allowed, true, '父目录默认不受影响');
});

test('FR-037: 未被矩阵覆盖且非系统级默认的路径 → 默认拒绝', () => {
  const r = checkPathAccess('/srv/private/app.conf', ctx(), 'read');
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'not-covered');
});

test('FR-039: 符号链接按解析后的真实路径判定（realPath 优先于字面路径）', () => {
  // 字面路径在矩阵内，真实路径解析到敏感路径 → 拒绝
  const r1 = checkPathAccess('/var/log/link', ctx(), 'read', { realPath: '/root/.ssh/known_hosts' });
  assert.equal(r1.allowed, false);
  assert.equal(r1.reason, 'sensitive-path');
  // 字面路径未覆盖，真实路径落在矩阵内 → 允许
  const r2 = checkPathAccess('/mnt/data/link', ctx(), 'read', { realPath: '/var/log/app.log' });
  assert.equal(r2.allowed, true);
});

test('越权操作：矩阵仅允许 read 时 write 被拒', () => {
  const r = checkPathAccess('/var/log/x', ctx(), 'write');
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'denied-by-matrix');
});

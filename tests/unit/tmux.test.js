// R001 tmux 会话模式：纯逻辑单元测试（探测状态机 / 会话名净化 / 命令构造）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TMUX_SESSION,
  sanitizeTmuxSessionName,
  buildTmuxProbeCommand,
  buildTmuxAttachCommand,
  createTmuxDetector,
} from '../../web/src/tmux.js';

// —— 会话名净化 ——

test('sanitize: 保留字母数字下划线连字符', () => {
  assert.equal(sanitizeTmuxSessionName('web-ssh_01'), 'web-ssh_01');
});

test('sanitize: 剥离 tmux 语法保留字符（: 与 .）与空格', () => {
  // `:`/`.` 在 tmux target 语法中有含义，空格会拆分命令行
  assert.equal(sanitizeTmuxSessionName('a:b.c d'), 'abcd');
});

test('sanitize: 空名/全非法字符回退默认会话名', () => {
  assert.equal(sanitizeTmuxSessionName(''), DEFAULT_TMUX_SESSION);
  assert.equal(sanitizeTmuxSessionName('::..'), DEFAULT_TMUX_SESSION);
  assert.equal(sanitizeTmuxSessionName(null), DEFAULT_TMUX_SESSION);
});

test('sanitize: 超长截断到 48 字符', () => {
  assert.equal(sanitizeTmuxSessionName('a'.repeat(100)).length, 48);
});

// —— 命令构造 ——

test('attach 命令：-A 语义（存在 attach / 不存在创建）+ 净化后的会话名', () => {
  assert.equal(buildTmuxAttachCommand('webssh'), 'tmux new -A -s webssh');
  assert.equal(buildTmuxAttachCommand('bad:name'), 'tmux new -A -s badname');
});

test('探测命令：无参数无回显歧义（回显不含数字版本，不误判 found）', () => {
  assert.equal(buildTmuxProbeCommand(), 'tmux -V');
});

// —— 探测状态机 ——

test('detector: 版本输出判定 found（tmux 3.3a）', () => {
  const feed = createTmuxDetector();
  assert.equal(feed('root@nas:~# tmux 3.3a\r\n'), 'found');
});

test('detector: 命令回显本身不误判（"tmux -V" 无数字）', () => {
  const feed = createTmuxDetector();
  assert.equal(feed('root@nas:~# tmux -V\r\n'), null);
});

test('detector: command not found 判定 missing', () => {
  const feed = createTmuxDetector();
  assert.equal(feed('bash: tmux: command not found\r\n'), 'missing');
});

test('detector: 中文 locale 未找到命令判定 missing', () => {
  const feed = createTmuxDetector();
  assert.equal(feed('bash: tmux：未找到命令\r\n'), 'missing');
});

test('detector: 跨 chunk 分片到达仍可判定（版本号被拆开）', () => {
  const feed = createTmuxDetector();
  assert.equal(feed('root@nas:~# tm'), null);
  assert.equal(feed('ux 3.3a\r\n'), 'found');
});

test('detector: 跨 chunk 分片的 not found 判定 missing', () => {
  const feed = createTmuxDetector();
  assert.equal(feed('bash: tmux: comm'), null);
  assert.equal(feed('and not found\r\n'), 'missing');
});

test('detector: 超长输出防膨胀（4096 截断后标记仍可命中）', () => {
  const feed = createTmuxDetector();
  // 5KB 无关输出（触发截断保留尾部窗口）
  assert.equal(feed('x'.repeat(5000)), null);
  assert.equal(feed('tmux 3.3a\r\n'), 'found');
});

test('detector: 无关输出持续返回 null', () => {
  const feed = createTmuxDetector();
  assert.equal(feed('Last login: Thu Oct 1 14:00:00 2026\r\n'), null);
  assert.equal(feed('root@nas:~# \r\n'), null);
});

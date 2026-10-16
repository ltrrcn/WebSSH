import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCommandRecorder } from '../../src/session/command-recorder.js';

const PROMPT = 'alice@nas:~$ ';

function fixture({ enabled = true, digestBytes = 2048, learn = true } = {}) {
  const events = [];
  const cfg = { enabled, digestBytes };
  const recorder = createCommandRecorder(
    { ownerId: 'user-1', hostId: 'host-1', id: 'session-1' },
    { log: (event) => events.push(event) },
    () => cfg,
  );
  const feed = (text) => recorder.feed(Buffer.from(text));
  const output = (text) => recorder.onOutput(Buffer.from(text));
  if (learn) output(PROMPT);
  return { recorder, events, cfg, feed, output };
}

function splitBytes(buffer, write) {
  for (const byte of buffer) write(Buffer.from([byte]));
}

test('关闭摘要时回车立即记录且公共字段完备，空白和CRLF不重复', () => {
  const { recorder, events, feed, output } = fixture({ enabled: false });
  feed('   \r\n');
  feed('ll\r\ncat file\n');
  output('password=hidden\n');
  recorder.flush();
  assert.deepEqual(events, [
    { actor: 'user-1', actorType: 'user', hostId: 'host-1', sessionId: 'session-1', event: 'command', result: 'success', command: 'll' },
    { actor: 'user-1', actorType: 'user', hostId: 'host-1', sessionId: 'session-1', event: 'command', result: 'success', command: 'cat file' },
  ]);
});

test('ll在提示符返回就结束，不串入下一cat回显或输出', () => {
  const { recorder, events, feed, output } = fixture();
  feed('ll\r');
  output(`ll\r\nfile.txt\r\n${PROMPT}`);
  assert.equal(events.length, 1);
  assert.equal(events[0].outputDigest, 'file.txt');
  feed('cat file.txt\r');
  output(`cat file.txt\r\ncontents\r\n${PROMPT}`);
  recorder.flush();
  assert.deepEqual(events.map((event) => event.outputDigest), ['file.txt', 'contents']);
});

test('cd和true零输出在prompt返回立即落盘，无摘要字段', () => {
  const { events, feed, output } = fixture();
  feed('cd /tmp\r');
  output('cd /tmp\r\nalice@nas:/tmp$ ');
  feed('true\r');
  output('true\r\nalice@nas:/tmp$ ');
  assert.deepEqual(events.map((event) => event.command), ['cd /tmp', 'true']);
  assert.ok(events.every((event) => !('outputDigest' in event)));
});

test('快速三命令全部提前回显，单chunk输出依然按FIFO分别归属', () => {
  const { events, feed, output } = fixture();
  feed('echo first\recho second\recho third\r');
  output(`echo first\r\necho second\r\necho third\r\nfirst\r\n${PROMPT}second\r\n${PROMPT}third\r\n${PROMPT}`);
  assert.deepEqual(events.map((event) => event.command), ['echo first', 'echo second', 'echo third']);
  assert.deepEqual(events.map((event) => event.outputDigest), ['first', 'second', 'third']);
});

test('快速两命令标准prompt+echo合并chunk，不会跨命令剔除同名真实输出', () => {
  const { events, feed, output } = fixture();
  feed('echo hi\rcat file\r');
  output(`echo hi\r\necho hi\r\n${PROMPT}cat file\r\ncat file\r\n${PROMPT}`);
  assert.deepEqual(events.map((event) => event.outputDigest), ['echo hi', 'cat file']);
});

test('上一命令真实输出等于下一命令，在同chunk后续echo确认后不误吞', () => {
  const { events, feed, output } = fixture();
  const first = 'printf "cat file\\n"';
  feed(`${first}\rcat file\r`);
  output(`${first}\r\ncat file\r\n${PROMPT}cat file\r\ncontents\r\n${PROMPT}`);
  assert.deepEqual(events.map((event) => event.outputDigest), ['cat file', 'contents']);
});

test('命令完整回显含已学习prompt时不能提前结束审计', () => {
  const { events, feed, output } = fixture();
  feed('echo alice@nas:~$\r');
  output('echo alice@nas:~$');
  assert.equal(events.length, 0);
  output(`\r\nalice@nas:~$\r\n${PROMPT}`);
  assert.equal(events.length, 1);
  assert.equal(events[0].command, 'echo alice@nas:~$');
});

test('动态cwd包含美元符号，marker分片不得提前识别prompt', () => {
  const { events, feed, output } = fixture();
  feed('cd /tmp/cash$dir\recho next\r');
  output('cd /tmp/cash$dir\r\nalice@nas:/tmp/cash$');
  assert.equal(events.length, 0);
  output('dir$ echo next\r\nnext\r\nalice@nas:/tmp/cash$dir$ ');
  assert.deepEqual(events.map((event) => event.command), ['cd /tmp/cash$dir', 'echo next']);
  assert.ok(!('outputDigest' in events[0]));
  assert.equal(events[1].outputDigest, 'next');
});

test('上下行UTF8按字节分包不损坏中文与非BMP字符', () => {
  const { recorder, events } = fixture();
  splitBytes(Buffer.from('echo 中文𝄞\r'), (chunk) => recorder.feed(chunk));
  splitBytes(Buffer.from(`echo 中文𝄞\r\n中文𝄞\r\n${PROMPT}`), (chunk) => recorder.onOutput(chunk));
  assert.equal(events[0].command, 'echo 中文𝄞');
  assert.equal(events[0].outputDigest, '中文𝄞');
});

test('ANSI、OSC标题、prompt、回显和CRLF跨包均被增量解析', () => {
  const { recorder, events, feed } = fixture({ learn: false });
  splitBytes(Buffer.from(`\x1b]0;title\x1b\\\x1b[32m${PROMPT}\x1b[0m`), (chunk) => recorder.onOutput(chunk));
  feed('ll\r');
  splitBytes(Buffer.from(`\x1b[?2004l\rll\r\n\x1b[31mfile\x1b[0m\r\n\x1b]0;next\x07${PROMPT}`), (chunk) => recorder.onOutput(chunk));
  assert.equal(events.length, 1);
  assert.equal(events[0].outputDigest, 'file');
});

test('方向键CSI、SS3完整序列跨包不混入命令，退格处理Unicode', () => {
  const { recorder, events } = fixture({ enabled: false });
  splitBytes(Buffer.from('ec\x1b[A\x1bOBho 中文𝄞\x7f好\r'), (chunk) => recorder.feed(chunk));
  assert.equal(events[0].command, 'echo 中文好');
});

test('Ctrl+C、Ctrl+U作废草稿，空行不记录', () => {
  const { events, feed } = fixture({ enabled: false });
  feed('aborted\x03\rdeleted\x15\r \ntrue\r');
  assert.deepEqual(events.map((event) => event.command), ['true']);
});

test('截断后持续解析prompt，后续命令不丢失边界', () => {
  const { events, feed, output } = fixture({ digestBytes: 16 });
  feed('first\rsecond\r');
  output(`first\r\n${'x'.repeat(50000)}\r\n${PROMPT}second\r\nyes\r\n${PROMPT}`);
  assert.deepEqual(events.map((event) => event.outputDigest), ['x'.repeat(16), 'yes']);
});

test('摘要先脱敏再截断，超长不完整私钥保守去除', () => {
  const { events, feed, output } = fixture({ digestBytes: 64 });
  feed('cat key\r');
  output(`cat key\r\npassword=very-secret-token\r\n-----BEGIN OPENSSH PRIVATE KEY-----\r\n${'private-key-body'.repeat(400)}\r\n${PROMPT}`);
  assert.equal(events.length, 1);
  assert.ok(events[0].outputDigest.includes('[REDACTED'));
  assert.ok(!events[0].outputDigest.includes('very-secret-token'));
  assert.ok(!events[0].outputDigest.includes('private-key-body'));
  assert.ok(!events[0].outputDigest.includes('-----BEGIN'));
  assert.ok(events[0].outputDigest.length <= 64);
});

test('完整PEM脱敏后保留其他输出', () => {
  const { events, feed, output } = fixture();
  feed('cat key\r');
  output(`cat key\r\n-----BEGIN RSA PRIVATE KEY-----\r\nsecret-body\r\n-----END RSA PRIVATE KEY-----\r\ndone\r\n${PROMPT}`);
  assert.equal(events[0].outputDigest, '[REDACTED PRIVATE KEY]\ndone');
});

test('未回车的下一条键入和回显不进入上一摘要', () => {
  const { recorder, events, feed, output } = fixture();
  feed('sleep 1\r');
  output('sleep 1\r\n');
  feed('cat next');
  output(`cat next\r\ndone\r\n${PROMPT}`);
  assert.equal(events[0].outputDigest, 'done');
  recorder.flush();
  assert.equal(events.length, 1);
});

test('初始prompt不会误flush已提交但尚未执行的第一条命令', () => {
  const { events, feed, output } = fixture({ learn: false });
  feed('ll\r');
  output(PROMPT);
  assert.equal(events.length, 0);
  output(`ll\r\nfile\r\n${PROMPT}`);
  assert.equal(events[0].outputDigest, 'file');
});

test('首条输入早于登录banner，初始prompt不误记录也不串入banner', () => {
  const { events, feed, output } = fixture({ learn: false });
  feed('ll\r');
  output(`Welcome to the shell\r\n\r\n${PROMPT}`);
  assert.equal(events.length, 0);
  output(`ll\r\nfile\r\n${PROMPT}`);
  assert.equal(events[0].outputDigest, 'file');
});

test('初始prompt学习后无回显零输出的首条命令可正确结束', () => {
  const { events, feed, output } = fixture({ learn: false });
  feed('true\r');
  output(PROMPT);
  assert.equal(events.length, 0);
  output(PROMPT);
  assert.equal(events.length, 1);
  assert.ok(!('outputDigest' in events[0]));
});

test('已学习prompt支持关闭终端回显的零输出命令', () => {
  const { events, feed, output } = fixture();
  feed('true\r');
  output(PROMPT);
  assert.equal(events.length, 1);
  assert.ok(!('outputDigest' in events[0]));
});

test('prompt后紧接带前导空格的回显按完整位置匹配排除', () => {
  const { events, feed, output } = fixture();
  feed('true\r  echo spaced\r');
  output(`true\r\n${PROMPT}  echo spaced\r\nspaced\r\n${PROMPT}`);
  assert.equal(events.length, 2);
  assert.ok(!('outputDigest' in events[0]));
  assert.equal(events[1].command, '  echo spaced');
  assert.equal(events[1].outputDigest, 'spaced');
});

test('无末换行输出接已学习prompt，后面紧接echo与输出', () => {
  const { events, feed, output } = fixture();
  feed('printf one\rprintf two\r');
  output(`printf one\r\none${PROMPT}printf two\r\ntwo${PROMPT}`);
  assert.deepEqual(events.map((event) => event.outputDigest), ['one', 'two']);
});

test('任意$/#输出行不是prompt，未知prompt close不附不可信摘要', () => {
  const { recorder, events, feed, output } = fixture({ learn: false });
  feed('first\rsecond\r');
  output('first\r\nprice$\r\nheading#\r\ncustom> second\r\nresult\r\ncustom> ');
  assert.equal(events.length, 0);
  recorder.flush();
  assert.deepEqual(events.map((event) => event.command), ['first', 'second']);
  assert.ok(events.every((event) => !('outputDigest' in event)));
});

test('OSC133 D+A及文本prompt只flush一次，不提前结束下一命令', () => {
  const { events, feed, output } = fixture();
  feed('first\rsecond\r');
  output('first\r\nsecond\r\n\x1b]133;C\x07one\r\n\x1b]133;D;0\x07');
  assert.equal(events.length, 1);
  output(`\x1b]133;A\x07${PROMPT}\x1b]133;B\x07`);
  assert.equal(events.length, 1);
  output('\x1b]133;C\x07two\x1b]133;D;0\x07\x1b]133;A\x07');
  assert.deepEqual(events.map((event) => event.outputDigest), ['one', 'two']);
});

test('重复OSC133 D与随后A不重复完成下一条待执行命令', () => {
  const { events, feed, output } = fixture();
  feed('first\rsecond\r');
  output(`first\r\nsecond\r\n\x1b]133;C\x07one\x1b]133;D;0\x07\x1b]133;D;0\x07\x1b]133;A\x07${PROMPT}\x1b]133;B\x07`);
  assert.equal(events.length, 1);
  output('\x1b]133;C\x07two\x1b]133;D;0\x07');
  assert.deepEqual(events.map((event) => event.outputDigest), ['one', 'two']);
});

for (const phase of ['', `\x1b]133;A\x07${PROMPT}\x1b]133;B\x07`]) {
  test(`重复D跨chunk保留下一echo分片，完成周期不被${phase ? 'A/prompt/B' : '重复D'}重置`, () => {
    const { events, feed, output } = fixture();
    feed('first\rsecond\r');
    output('first\r\nsecond\r\n\x1b]133;C\x07one\x1b]133;D;0\x07');
    output(`${phase}se`);
    output('\x1b]133;D;0\x07');
    assert.equal(events.length, 1);
    output('cond\r\n\x1b]133;C\x07two\x1b]133;D;0\x07');
    assert.deepEqual(events.map((event) => event.outputDigest), ['one', 'two']);
  });
}

test('OSC133自定义prompt可跨包，无输出命令D立即结束', () => {
  const { recorder, events, feed } = fixture({ learn: false });
  splitBytes(Buffer.from('\x1b]133;A\x1b\\custom> \x1b]133;B\x1b\\'), (chunk) => recorder.onOutput(chunk));
  feed('true\r');
  splitBytes(Buffer.from('true\r\n\x1b]133;C\x1b\\\x1b]133;D;0\x1b\\'), (chunk) => recorder.onOutput(chunk));
  assert.equal(events.length, 1);
  assert.ok(!('outputDigest' in events[0]));
});

test('运行时热关闭丢弃已采集摘要且后续回车立即记录', () => {
  const { recorder, events, cfg, feed, output } = fixture();
  feed('first\rsecond\r');
  output('first\r\nsecond\r\nold-output\r\n');
  cfg.enabled = false;
  output('new-private-output\r\n');
  feed('third\r');
  recorder.flush();
  assert.deepEqual(events.map((event) => event.command), ['first', 'second', 'third']);
  assert.ok(events.every((event) => !('outputDigest' in event)));
});

test('无pending时热关闭也清理旧逻辑行，重新开启不会串入旧输出', () => {
  const { events, cfg, feed, output } = fixture();
  output('stale-private-output');
  cfg.enabled = false;
  output('disabled-private-output');
  cfg.enabled = true;
  feed('true\r');
  output(`true\r\n${PROMPT}`);
  assert.equal(events.length, 1);
  assert.ok(!('outputDigest' in events[0]));
});

test('关闭时每条一次、未知并行归属保守丢弃，关闭后接口幂等', () => {
  const { recorder, events, feed, output } = fixture();
  feed('first\rsecond\rthird\r');
  output('first\r\nuncertain\r\n');
  recorder.flush();
  recorder.flush();
  feed('after-close\r');
  output(PROMPT);
  assert.deepEqual(events.map((event) => event.command), ['first', 'second', 'third']);
  assert.ok(events.every((event) => !('outputDigest' in event)));
});

test('单个可信执行中的命令close保留摘要但排除尚未回车草稿', () => {
  const { recorder, events, feed, output } = fixture();
  feed('first\r');
  output('first\r\npartial-result\r\n');
  feed('draft');
  output('draft');
  recorder.flush();
  assert.equal(events[0].outputDigest, 'partial-result');
});

test('命令最多2000字符，超长输入和OSC不无限缓存', () => {
  const { recorder, events, feed, output } = fixture();
  feed(`${'x'.repeat(30000)}\r`);
  output(`\x1b]0;${'title'.repeat(20000)}\x07${'x'.repeat(30000)}\r\n${PROMPT}`);
  recorder.flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].command.length, 2000);
  assert.ok(!('outputDigest' in events[0]));
});

test('FIFO溢出降级仍每命令一次，prompt恢复后能继续采集', () => {
  const { recorder, events, feed, output } = fixture();
  feed(Array.from({ length: 300 }, (_, index) => `cmd-${index}\r`).join(''));
  output(PROMPT);
  feed('echo recovered\r');
  output(`echo recovered\r\nrecovered\r\n${PROMPT}`);
  recorder.flush();
  assert.equal(events.length, 301);
  assert.equal(new Set(events.map((event) => event.command)).size, 301);
  assert.equal(events.at(-1).outputDigest, 'recovered');
});

test('审计sink抛异常不会让flush重复记录或影响后续解析', () => {
  let attempts = 0;
  const recorder = createCommandRecorder(
    { ownerId: 'u', hostId: 'h', id: 's' },
    { log() { attempts += 1; throw new Error('sink failed'); } },
    () => ({ enabled: true, digestBytes: 16 }),
  );
  recorder.onOutput(Buffer.from(PROMPT));
  recorder.feed(Buffer.from('true\rfalse\r'));
  recorder.flush();
  recorder.flush();
  assert.equal(attempts, 2);
});

for (const shellPrompt of ['root@host:/# ', 'user@host /tmp % ', 'bash-5.2$ ', '[root@host ~]# ']) {
  test(`常见prompt边界：${shellPrompt.trim()}`, () => {
    const { events, feed, output } = fixture({ learn: false });
    output(shellPrompt);
    feed('true\r');
    output(`true\r\n${shellPrompt}`);
    assert.equal(events.length, 1);
    assert.ok(!('outputDigest' in events[0]));
  });
}

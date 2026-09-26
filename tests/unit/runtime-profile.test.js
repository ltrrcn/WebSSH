import { test } from 'node:test';
import assert from 'node:assert';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from '../helpers/tmpdir.js';

// 宪法第 VII 条：运行模式探测与路径解析是适配层职责，业务代码不得读 TRIM_*
import { detectMode, resolveRuntime } from '../../src/runtime/profile.js';
import { ensureDirs } from '../../src/runtime/paths.js';

test('detectMode: TRIM_APPNAME 存在且非空 → fnos', () => {
  assert.equal(detectMode({ TRIM_APPNAME: 'webssh' }), 'fnos');
});

test('detectMode: TRIM_APPNAME 为空字符串 → standalone', () => {
  assert.equal(detectMode({ TRIM_APPNAME: '' }), 'standalone');
});

test('detectMode: 无 TRIM_ 环境变量 → standalone', () => {
  assert.equal(detectMode({}), 'standalone');
});

test('resolveRuntime(fnos): 路径取自 TRIM_*，监听 Unix Socket，身份来自 X-Trim-*', () => {
  const env = {
    TRIM_APPNAME: 'webssh',
    TRIM_APPDEST: '/var/apps/webssh/target',
    TRIM_PKGETC: '/vol1/@appetc/webssh',
    TRIM_PKGVAR: '/vol1/@apphome/webssh',
    TRIM_PKGTMP: '/vol1/@apptmp/webssh',
  };
  const rt = resolveRuntime(env);
  assert.equal(rt.mode, 'fnos');
  assert.equal(rt.paths.config, env.TRIM_PKGETC);
  assert.equal(rt.paths.data, env.TRIM_PKGVAR);
  assert.equal(rt.paths.tmp, env.TRIM_PKGTMP);
  assert.equal(rt.paths.log, join(env.TRIM_PKGVAR, 'log'));
  assert.equal(rt.listen.type, 'unix');
  assert.equal(rt.listen.socketPath, join(env.TRIM_APPDEST, 'app.sock'));
  assert.equal(rt.authSource, 'trim-headers');
});

test('resolveRuntime(standalone): 路径取自 WEBSSH_HOME，监听回环 TCP，身份来自应用会话', () => {
  const env = { WEBSSH_HOME: '/home/u/.webssh' };
  const rt = resolveRuntime(env, {});
  assert.equal(rt.mode, 'standalone');
  assert.equal(rt.paths.config, '/home/u/.webssh/etc');
  assert.equal(rt.paths.data, '/home/u/.webssh/var');
  assert.equal(rt.paths.tmp, '/home/u/.webssh/tmp');
  assert.equal(rt.paths.log, '/home/u/.webssh/var/log');
  assert.equal(rt.listen.type, 'tcp');
  assert.equal(rt.listen.host, '127.0.0.1');
  assert.equal(rt.listen.port, 8080);
  assert.equal(rt.authSource, 'app-session');
});

test('resolveRuntime(standalone): 监听地址与端口可由 config 覆盖', () => {
  const env = { WEBSSH_HOME: '/home/u/.webssh' };
  const rt = resolveRuntime(env, { standalone: { bind: '127.0.0.2', port: 9000 } });
  assert.equal(rt.listen.host, '127.0.0.2');
  assert.equal(rt.listen.port, 9000);
});

test('ensureDirs: 缺失目录自动创建且权限 0700（配置目录含凭据）', async () => {
  const { dir, cleanup } = await makeTempDir('webssh-paths-');
  try {
    const paths = {
      config: join(dir, 'etc'),
      data: join(dir, 'var'),
      tmp: join(dir, 'tmp'),
      log: join(dir, 'var', 'log'),
    };
    await ensureDirs(paths);
    for (const p of Object.values(paths)) {
      const st = await stat(p);
      assert.equal(st.mode & 0o777, 0o700, `${p} 应为 0700`);
      assert.ok(st.isDirectory());
    }
    // 幂等：已存在时再次调用不报错
    await ensureDirs(paths);
  } finally {
    await cleanup();
  }
});

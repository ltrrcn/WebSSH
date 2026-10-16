// 用户资料契约测试（R003）：GET/PUT 昵称 + 头像上传（magic bytes/大小上限）/读取/移除
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from '../helpers/tmpdir.js';
import { startApp } from '../../src/net/server.js';

async function makeApp() {
  const { dir, cleanup } = await makeTempDir('webssh-profile-');
  const app = await startApp({
    env: { WEBSSH_HOME: dir },
    config: { standalone: { bind: '127.0.0.1', port: 0 } },
  });
  return {
    base: `http://127.0.0.1:${app.port}`,
    etcDir: join(dir, 'etc'),
    cleanup: async () => {
      await app.close();
      await cleanup();
    },
  };
}

const json = (r) => r.json().catch(() => null);

// 1×1 透明 PNG（magic bytes 合法）
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);
// GIF89a 头（magic bytes 合法）
const TINY_GIF = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(16)]);

describe('GET /api/profile', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await makeApp();
  });

  test('初始返回空资料（standalone：nickname null / hasAvatar false）', async () => {
    const { base, cleanup } = ctx;
    try {
      const res = await fetch(`${base}/api/profile`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.id, 'local');
      assert.equal(body.username, 'local');
      assert.equal(body.nickname, null);
      assert.equal(body.hasAvatar, false);
      assert.equal(body.avatarUpdatedAt, null);
    } finally {
      await cleanup();
    }
  });

  test('昵称设置/读回/清除闭环；非法值 422', async () => {
    const { base, cleanup } = ctx;
    try {
      const put = await fetch(`${base}/api/profile`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nickname: '  张三  ' }),
      });
      assert.equal(put.status, 200);
      assert.equal((await put.json()).nickname, '张三');
      assert.equal((await json(await fetch(`${base}/api/profile`))).nickname, '张三');

      // 空串 = 清除
      const clear = await fetch(`${base}/api/profile`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nickname: '' }),
      });
      assert.equal(clear.status, 200);
      assert.equal((await clear.json()).nickname, null);
      assert.equal((await json(await fetch(`${base}/api/profile`))).nickname, null);

      // 非法：非字符串 / 超长 / 缺字段
      const badType = await fetch(`${base}/api/profile`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nickname: 123 }),
      });
      assert.equal(badType.status, 422);
      const tooLong = await fetch(`${base}/api/profile`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nickname: 'a'.repeat(33) }),
      });
      assert.equal(tooLong.status, 422);
      const missing = await fetch(`${base}/api/profile`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(missing.status, 422);
    } finally {
      await cleanup();
    }
  });
});

describe('头像上传/读取/移除', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await makeApp();
  });

  test('PNG 上传 → 字节回读一致 → profile.hasAvatar=true → 移除幂等', async () => {
    const { base, etcDir, cleanup } = ctx;
    try {
      // 无头像时读取 404
      assert.equal((await fetch(`${base}/api/profile/avatar`)).status, 404);

      const up = await fetch(`${base}/api/profile/avatar`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: TINY_PNG,
      });
      assert.equal(up.status, 200);
      const ts = (await up.json()).avatarUpdatedAt;
      assert.ok(ts);

      const prof = await json(await fetch(`${base}/api/profile`));
      assert.equal(prof.hasAvatar, true);
      assert.equal(prof.avatarUpdatedAt, ts);

      const img = await fetch(`${base}/api/profile/avatar`);
      assert.equal(img.status, 200);
      assert.equal(img.headers.get('content-type'), 'image/png');
      assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(Buffer.from(await img.arrayBuffer()).equals(TINY_PNG));

      // 头像文件落在 etc/avatars/（文件名应为 ownerId 的 sha256，无原名穿越面）
      const files = await readdir(join(etcDir, 'avatars'));
      assert.equal(files.length, 1);
      assert.match(files[0], /^[0-9a-f]{64}\.png$/);

      // 换格式（GIF）：旧 PNG 清理，仅剩一个文件
      const up2 = await fetch(`${base}/api/profile/avatar`, {
        method: 'POST',
        body: TINY_GIF,
      });
      assert.equal(up2.status, 200);
      const files2 = await readdir(join(etcDir, 'avatars'));
      assert.equal(files2.length, 1);
      assert.ok(files2[0].endsWith('.gif'));

      // 移除：幂等（两次 DELETE 均 200）
      assert.equal((await fetch(`${base}/api/profile/avatar`, { method: 'DELETE' })).status, 200);
      assert.equal((await fetch(`${base}/api/profile/avatar`, { method: 'DELETE' })).status, 200);
      assert.equal((await fetch(`${base}/api/profile/avatar`)).status, 404);
      assert.equal((await json(await fetch(`${base}/api/profile`))).hasAvatar, false);
      assert.deepEqual(await readdir(join(etcDir, 'avatars')), []);

      // 昵称保留不受头像移除影响（users.json 记录仅在头像字段置空）
      const put = await fetch(`${base}/api/profile`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nickname: '备注名' }),
      });
      assert.equal(put.status, 200);
      assert.equal((await json(await fetch(`${base}/api/profile`))).nickname, '备注名');
    } finally {
      await cleanup();
    }
  });

  test('非图片字节 422；超 2MB 413', async () => {
    const { base, cleanup } = ctx;
    try {
      const bad = await fetch(`${base}/api/profile/avatar`, {
        method: 'POST',
        body: Buffer.from('not an image at all'),
      });
      assert.equal(bad.status, 422);
      assert.equal((await bad.json()).error.code, 'invalid_image');

      const tooBig = await fetch(`${base}/api/profile/avatar`, {
        method: 'POST',
        body: Buffer.concat([TINY_PNG, Buffer.alloc(2 * 1024 * 1024)]),
      });
      assert.equal(tooBig.status, 413);
      assert.equal((await tooBig.json()).error.code, 'payload_too_large');
      assert.equal((await json(await fetch(`${base}/api/profile`))).hasAvatar, false);
    } finally {
      await cleanup();
    }
  });
});

describe('users.json 落盘', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await makeApp();
  });

  test('资料变更原子写入 etc/users.json（version/users 结构）', async () => {
    const { base, etcDir, cleanup } = ctx;
    try {
      await fetch(`${base}/api/profile`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nickname: '昵称A' }),
      });
      const data = JSON.parse(await readFile(join(etcDir, 'users.json'), 'utf8'));
      assert.equal(data.version, 1);
      assert.equal(Array.isArray(data.users), true);
      assert.equal(data.users[0].ownerId, 'local');
      assert.equal(data.users[0].nickname, '昵称A');
    } finally {
      await cleanup();
    }
  });
});

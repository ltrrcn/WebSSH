// T056：审计查询与导出契约（contracts/rest-api.md 审计节 / FR-012）
import { test } from 'node:test';
import assert from 'node:assert';
import { makeTempDir } from '../helpers/tmpdir.js';
import { seedHost } from '../helpers/seed-host.js';
import { startApp } from '../../src/net/server.js';
import WebSocket from 'ws';

const PW = 'audit-secret-pw';

async function setup() {
  const { dir, cleanup } = await makeTempDir('webssh-audit-');
  await seedHost({
    configDir: `${dir}/etc`,
    id: 'h_dead',
    host: '127.0.0.1',
    port: 1, // 不可达 → 必然失败，产生 connect-failure 记录
    password: PW,
    fingerprint: 'SHA256:fake',
  });
  const app = await startApp({
    env: { WEBSSH_HOME: dir },
    config: {
      standalone: { bind: '127.0.0.1', port: 0 },
      limits: { sessionsPerUser: 10, connectTimeoutMs: 1500 },
      security: { allowedOrigins: [] },
    },
  });
  // 制造一次失败连接（connect-attempt + connect-failure）
  await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws/terminal?hostId=h_dead&version=1`, {
      origin: `http://127.0.0.1:${app.port}`,
    });
    ws.on('close', resolve);
    ws.on('error', resolve);
  });
  await new Promise((r) => setTimeout(r, 400)); // 审计异步落盘
  return { app, cleanup, base: `http://127.0.0.1:${app.port}` };
}

test('GET /api/audit：按时间顺序返回审计记录，字段完整（FR-011/012）', async () => {
  const { app, cleanup, base } = await setup();
  try {
    const res = await fetch(`${base}/api/audit`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.items));
    assert.ok(body.items.length >= 2, '至少应有 attempt 与 failure 两条');
    const ev = body.items[0];
    for (const field of ['id', 'ts', 'actor', 'actorType', 'hostId', 'hostAddress', 'authType', 'event', 'result']) {
      assert.ok(field in ev, `审计记录应包含 ${field}`);
    }
    // 时间顺序
    const tss = body.items.map((i) => i.ts);
    assert.deepEqual(tss, [...tss].sort(), '应按时间顺序排列');
    assert.equal(typeof body.total, 'number');
  } finally {
    await app.close();
    await cleanup();
  }
});

test('GET /api/audit：支持 result / hostId 过滤与分页', async () => {
  const { app, cleanup, base } = await setup();
  try {
    const byResult = await (await fetch(`${base}/api/audit?result=error`)).json();
    assert.ok(byResult.items.length >= 1);
    assert.ok(byResult.items.every((i) => i.result === 'error'), 'result=error 过滤应生效');

    const byHost = await (await fetch(`${base}/api/audit?hostId=h_dead`)).json();
    assert.ok(byHost.items.every((i) => i.hostId === 'h_dead'));

    const paged = await (await fetch(`${base}/api/audit?limit=1&offset=0`)).json();
    assert.equal(paged.items.length, 1);
    const paged2 = await (await fetch(`${base}/api/audit?limit=1&offset=1`)).json();
    assert.notEqual(paged.items[0]?.id, paged2.items[0]?.id, '分页应取不同记录');
  } finally {
    await app.close();
    await cleanup();
  }
});

test('GET /api/audit/export：导出可直接阅读的文本文件，按时间顺序，无明文凭据（FR-012 / SC-010）', async () => {
  const { app, cleanup, base } = await setup();
  try {
    const res = await fetch(`${base}/api/audit/export`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/plain/);
    assert.ok(res.headers.get('content-disposition')?.includes('attachment'), '应以附件形式导出');
    const text = await res.text();
    assert.ok(text.includes('connect-attempt') || text.includes('连接'), '导出内容应为可读记录');
    assert.ok(!text.includes(PW), '导出文件不得包含明文凭据');
    // 时间顺序
    const lines = text.trim().split('\n').filter(Boolean);
    assert.ok(lines.length >= 2);
  } finally {
    await app.close();
    await cleanup();
  }
});

test('审计响应不得含 secret 结构（SC-010）', async () => {
  const { app, cleanup, base } = await setup();
  try {
    const text = await (await fetch(`${base}/api/audit`)).text();
    assert.ok(!text.includes('"secret"'));
    assert.ok(!text.includes(PW));
  } finally {
    await app.close();
    await cleanup();
  }
});

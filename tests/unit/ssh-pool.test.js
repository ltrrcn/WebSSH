// 单元：SSH 连接池（src/ssh/pool.js）——复用、空闲断开、死亡重建、并发共享建连
import { test } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { createSshPool } from '../../src/ssh/pool.js';

/** 假连接：EventEmitter + end() 模拟断开（触发 close 事件） */
function fakeConn() {
  const conn = new EventEmitter();
  conn.ended = false;
  conn.end = () => {
    if (conn.ended) return;
    conn.ended = true;
    conn.emit('close');
  };
  return conn;
}

test('复用：同 key 连续调用只建一次连接，fn 拿到同一实例', async () => {
  let connects = 0;
  const conns = [fakeConn(), fakeConn()];
  const pool = createSshPool({
    getIdleMs: () => 60000,
    connect: async () => {
      connects++;
      return conns[connects - 1];
    },
  });
  const seen = [];
  await pool.withPooled('u1:h1', {}, (c) => { seen.push(c); });
  await pool.withPooled('u1:h1', {}, (c) => { seen.push(c); });
  await pool.withPooled('u1:h1', {}, (c) => { seen.push(c); });
  assert.equal(connects, 1, '三次调用只建一条连接');
  assert.equal(seen[0], conns[0]);
  assert.ok(seen.every((c) => c === conns[0]), 'fn 拿到同一连接');
  assert.equal(pool.size(), 1);
  pool.closeAll();
});

test('不同 key 不互相复用（属主/主机隔离）', async () => {
  let connects = 0;
  const pool = createSshPool({
    getIdleMs: () => 60000,
    connect: async () => {
      connects++;
      return fakeConn();
    },
  });
  await pool.withPooled('u1:h1', {}, () => {});
  await pool.withPooled('u1:h2', {}, () => {});
  await pool.withPooled('u2:h1', {}, () => {});
  assert.equal(connects, 3, '不同 key 各建一条');
  assert.equal(pool.size(), 3);
  pool.closeAll();
});

test('空闲关闭：超过 idleMs 无占用自动断开，下次调用重建', async () => {
  let connects = 0;
  const conns = [fakeConn(), fakeConn()];
  const pool = createSshPool({
    getIdleMs: () => 30,
    connect: async () => {
      connects++;
      return conns[connects - 1];
    },
  });
  await pool.withPooled('k', {}, () => {});
  assert.equal(pool.size(), 1, '占用结束后连接保留等待复用');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(pool.size(), 0, '空闲超时后连接出池');
  assert.ok(conns[0].ended, '空闲连接已 end');
  await pool.withPooled('k', {}, () => {});
  assert.equal(connects, 2, '空闲断开后再次调用重建连接');
  pool.closeAll();
});

test('连接死亡：close/error 立即出池，下次调用重建', async () => {
  let connects = 0;
  const conns = [fakeConn(), fakeConn()];
  const pool = createSshPool({
    getIdleMs: () => 60000,
    connect: async () => {
      connects++;
      return conns[connects - 1];
    },
  });
  await pool.withPooled('k', {}, () => {});
  conns[0].emit('error', new Error('ECONNRESET')); // 远端重置
  assert.equal(pool.size(), 0, '错误后连接出池');
  const c = await pool.withPooled('k', {}, (conn) => conn);
  assert.equal(c, conns[1], '下次调用拿到新建连接');
  pool.closeAll();
});

test('并发：同时发起共享一次建连，全部归还不关连接', async () => {
  let connects = 0;
  const conn = fakeConn();
  let release;
  const gate = new Promise((r) => (release = r));
  const pool = createSshPool({
    getIdleMs: () => 60000,
    connect: async () => {
      connects++;
      await gate; // 模拟慢建连，制造并发等待窗口
      return conn;
    },
  });
  const p1 = pool.withPooled('k', {}, async () => 'a');
  const p2 = pool.withPooled('k', {}, async () => 'b');
  const p3 = pool.withPooled('k', {}, async () => 'c');
  release();
  assert.deepEqual(await Promise.all([p1, p2, p3]), ['a', 'b', 'c']);
  assert.equal(connects, 1, '并发调用只建一条连接');
  assert.equal(pool.size(), 1, '全部归还后连接保留');
  assert.ok(!conn.ended);
  pool.closeAll();
});

test('建连失败：占位清除，下次调用重试', async () => {
  let attempts = 0;
  const conn = fakeConn();
  const pool = createSshPool({
    getIdleMs: () => 60000,
    connect: async () => {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error('connect fail'), { code: 'ECONNREFUSED' });
      return conn;
    },
  });
  await assert.rejects(() => pool.withPooled('k', {}, () => {}), /connect fail/);
  assert.equal(pool.size(), 0, '失败后无残留占位');
  const c = await pool.withPooled('k', {}, (conn) => conn);
  assert.equal(c, conn, '第二次调用建连成功');
  pool.closeAll();
});

test('closeAll：全部断开', async () => {
  const conns = [fakeConn(), fakeConn()];
  let i = 0;
  const pool = createSshPool({
    getIdleMs: () => 60000,
    connect: async () => conns[i++],
  });
  await pool.withPooled('k1', {}, () => {});
  await pool.withPooled('k2', {}, () => {});
  pool.closeAll();
  assert.equal(pool.size(), 0);
  assert.ok(conns.every((c) => c.ended), '所有连接已断开');
});

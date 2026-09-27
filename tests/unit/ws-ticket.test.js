// 一次性 WS 票据（网关 WS 头回退通道）
import { test } from 'node:test';
import assert from 'node:assert';
import { createWsTicket, consumeWsTicket } from '../../src/net/tickets.js';

test('签发 → 消费 → 返回绑定身份（一次性）', () => {
  const identity = { id: '1000', username: 'u', isAdmin: false };
  const t = createWsTicket(identity);
  assert.match(t, /^[0-9a-f]{48}$/);
  const got = consumeWsTicket(t);
  assert.equal(got.id, '1000');
  // 一次性：第二次消费失败
  assert.equal(consumeWsTicket(t), null);
});

test('伪造 / 空票据 → null', () => {
  assert.equal(consumeWsTicket('deadbeef'), null);
  assert.equal(consumeWsTicket(''), null);
  assert.equal(consumeWsTicket(null), null);
  assert.equal(consumeWsTicket('x'.repeat(500)), null);
});

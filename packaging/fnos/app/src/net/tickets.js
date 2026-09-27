// 一次性 WS 连接票据（网关不向 WS 升级请求注入 X-Trim-* 时的回退通道）
// 票据由已认证的 REST 接口签发，60 秒有效、一次性、绑定身份。
import { randomBytes } from 'node:crypto';

const TTL_MS = 60 * 1000;
const tickets = new Map(); // ticket -> { identity, expires }

function cleanup() {
  const now = Date.now();
  for (const [t, e] of tickets) {
    if (e.expires < now) tickets.delete(t);
  }
}

/** 签发一次性票据（仅限已认证调用方：REST 路由） */
export function createWsTicket(identity) {
  cleanup();
  const ticket = randomBytes(24).toString('hex');
  tickets.set(ticket, { identity, expires: Date.now() + TTL_MS });
  return ticket;
}

/** 消费票据：一次性，过期/不存在返回 null */
export function consumeWsTicket(ticket) {
  if (typeof ticket !== 'string' || ticket.length === 0 || ticket.length > 128) return null;
  const entry = tickets.get(ticket);
  if (!entry) return null;
  tickets.delete(ticket); // 一次性
  if (Date.now() > entry.expires) return null;
  return entry.identity;
}

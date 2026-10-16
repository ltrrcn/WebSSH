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

// —— 私钥口令一次性票据 ——
// 连接加密私钥时口令由用户临时输入：经已认证 REST 换票据，WS 只携带票据 ID，
// 口令明文不出现在 URL / 访问日志 / 进程参数中。
const passTickets = new Map(); // ticket -> { hostId, ownerId, passphrase?, password?, expires }

function cleanupPass() {
  const now = Date.now();
  for (const [t, e] of passTickets) {
    if (e.expires < now) passTickets.delete(t);
  }
}

/** 签发口令票据（仅限已认证调用方：REST 路由）。passphrase=私钥口令，password=none 主机的连接密码 */
export function createPassTicket({ hostId, ownerId, passphrase, password }) {
  cleanupPass();
  const ticket = randomBytes(24).toString('hex');
  passTickets.set(ticket, { hostId, ownerId, passphrase, password, expires: Date.now() + TTL_MS });
  return ticket;
}

/** 消费口令票据：一次性，过期/不存在返回 null */
export function consumePassTicket(ticket) {
  if (typeof ticket !== 'string' || ticket.length === 0 || ticket.length > 128) return null;
  const entry = passTickets.get(ticket);
  if (!entry) return null;
  passTickets.delete(ticket); // 一次性
  if (Date.now() > entry.expires) return null;
  return entry;
}

// —— 2FA 通过票据 ——
// 高危操作验证通过后签发：TTL 内可复用（非一次性），绑定身份。
// 服务重启自然失效（内存态），届时受保护操作需重新输码。
// TTL 由调用方传入（config.twofa.ticketTtlMinutes，服务端统一执行），默认 5 分钟。
const T2FA_DEFAULT_TTL_MS = 5 * 60 * 1000;
const twofaTickets = new Map(); // ticket -> { identityId, expires }

/** 签发 2FA 票据（仅限 verify 通过后的 2FA 路由）；ttlMs 为有效期（毫秒） */
export function create2faTicket(identityId, ttlMs = T2FA_DEFAULT_TTL_MS) {
  const now = Date.now();
  for (const [t, e] of twofaTickets) {
    if (e.expires < now) twofaTickets.delete(t);
  }
  const ttl = Math.max(60 * 1000, Number(ttlMs) || T2FA_DEFAULT_TTL_MS); // 下限 1 分钟
  const ticket = randomBytes(24).toString('hex');
  twofaTickets.set(ticket, { identityId, expires: now + ttl });
  return { ticket, ttlSeconds: Math.floor(ttl / 1000) };
}

/** 校验 2FA 票据：过期/身份不符返回 false（不过期不删除，期限内可复用） */
export function consume2faTicket(ticket, identityId) {
  if (typeof ticket !== 'string' || ticket.length === 0 || ticket.length > 128) return false;
  const entry = twofaTickets.get(ticket);
  if (!entry) return false;
  if (Date.now() > entry.expires) {
    twofaTickets.delete(ticket);
    return false;
  }
  return entry.identityId === identityId;
}

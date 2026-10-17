// SSH 连接复用池：MCP 工具调用（run_command / read_file）按「属主+主机」复用连接。
// 背景：一次性连接（exec.withSsh）在批量执行时每条命令都要完整走一遍 TCP+SSH 握手，
// 高频建连会触发对端 sshd 的并发/频率限制（MaxStartups 等），表现为连续 ECONNRESET。
// 池化后同一主机的连续请求复用同一条连接（ssh2 单连接多通道），空闲超过 idleMs
// 自动断开，下次请求重新建立；连接死亡（远端关闭/错误）立即出池并重建。
// 审计归组不受影响：MCP 会话 ID 由客户端经 Mcp-Session-Id 头回传，与底层 SSH
// 连接的生命周期无关——命令始终记录到同一会话 ID。
import { Client } from 'ssh2';
import { fingerprintOfKey } from './hostkey.js';
import { decryptSecret } from '../crypto/secret.js';
import { withSsh } from './exec.js';

const DEFAULT_IDLE_MS = 10000;

/** 建立连接并交由池管理（参数与 exec.withSsh 同语义；带 keepalive 探测死链） */
function realConnect({ host, masterKey, config }) {
  return new Promise((resolve, reject) => {
    let secret;
    try {
      secret = decryptSecret(masterKey, host.secret);
    } catch (e) {
      return reject(e);
    }
    const conn = new Client();
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch { /* 忽略 */ }
      reject(err);
    };
    conn.on('ready', () => {
      settled = true;
      resolve(conn);
    });
    conn.on('error', fail);
    conn.connect({
      host: host.host,
      port: host.port,
      username: host.username,
      password: secret.password,
      privateKey: secret.privateKey,
      passphrase: secret.passphrase,
      readyTimeout: config.limits?.connectTimeoutMs ?? 10000,
      // 空闲保活：探测对端死链（无 keepalive 时 NAT/防火墙静默掐断后无从感知）
      keepaliveInterval: 15000,
      hostVerifier: (keyBlob) => fingerprintOfKey(keyBlob) === host.fingerprint,
    });
  });
}

/**
 * 创建连接池。
 * @param {{getIdleMs?: () => number, connect?: typeof realConnect}} [opts]
 *   getIdleMs：空闲关闭毫秒数（0 = 关闭池化，退回一次性连接语义）；connect 可注入测试替身
 */
export function createSshPool(opts = {}) {
  const connectFn = opts.connect ?? realConnect;
  // key: `${ownerId}:${hostId}` → entry
  // entry: { conn: Client|null, connecting: Promise|null, active: number, timer: null }
  const entries = new Map();

  const idleMs = () => {
    const v = typeof opts.getIdleMs === 'function' ? Number(opts.getIdleMs()) : DEFAULT_IDLE_MS;
    return Number.isFinite(v) && v >= 0 ? v : DEFAULT_IDLE_MS;
  };

  function evict(key, entry) {
    if (entries.get(key) !== entry) return;
    entries.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    // 正在借出（active>0）的调用仍持有 conn 引用，由 ssh2 流错误自然失败
    try { entry.conn?.end(); } catch { /* 忽略 */ }
  }

  /**
   * 借出连接执行 fn(conn)：借出期间空闲计时暂停；结束后若仍有并发占用则保持连接，
   * 全部归还后重启空闲计时，到点关闭。
   */
  async function withPooled(key, params, fn) {
    if (idleMs() === 0) return withSsh(params, fn); // 池化关闭 → 一次性连接
    let entry = entries.get(key);
    if (!entry) {
      entry = { conn: null, connecting: null, active: 0, timer: null };
      entries.set(key, entry);
    }
    entry.active++;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    try {
      if (!entry.conn) {
        // 并发调用共享同一个建连 Promise（避免同时开多条连接）
        entry.connecting ??= connectFn(params).then(
          (conn) => {
            entry.conn = conn;
            entry.connecting = null;
            // 连接死亡（远端关闭/错误）→ 立即出池；在途调用由流错误自行失败，下次请求重建
            conn.on('close', () => evict(key, entry));
            conn.on('error', () => evict(key, entry));
            return conn;
          },
          (err) => {
            // 建连失败：清掉占位（守卫：期间可能已被新 entry 替换），下次调用重试
            if (entries.get(key) === entry) entries.delete(key);
            entry.connecting = null;
            throw err;
          }
        );
        await entry.connecting;
      }
      return await fn(entry.conn);
    } finally {
      entry.active--;
      if (entry.active === 0 && entries.get(key) === entry) {
        const idle = idleMs();
        if (idle > 0) entry.timer = setTimeout(() => evict(key, entry), idle);
      }
    }
  }

  /** 全部断开（应用退出时） */
  function closeAll() {
    for (const [key, entry] of [...entries]) evict(key, entry);
  }

  return { withPooled, closeAll, size: () => entries.size };
}

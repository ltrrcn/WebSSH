// TOTP（RFC 6238）+ 一次性恢复码：仅用 Node 内置 crypto，零外部依赖
// 兼容 Google Authenticator / 腾讯令牌 / Microsoft Authenticator 等标准 TOTP 认证器。
import { createHmac, createHash, randomBytes } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;
// 时间窗容错：±1 个 step（共可接受 90 秒内的码，与主流认证器行为一致）
const WINDOW = 1;

// 防重放：同一 secret 同一时间步的码只能通过一次（secret 哈希前缀 -> 已用 step 集合）。
// 集合语义（非单调游标）：允许乱序（认证器与服务器相位差时更早窗口的码仍可用），只拒真重放。
const lastUsedSteps = new Map();

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`非法 Base32 字符: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 生成 TOTP secret（160 bit，RFC 6238 推荐强度） */
export function generateTotpSecret(bytes = 20) {
  return base32Encode(randomBytes(bytes));
}

/** 生成某时间步的 HOTP/TOTP 码（测试与服务端内部使用） */
export function totpAt(secretBase32, step) {
  const secretBuf = base32Decode(secretBase32);
  const counter = Buffer.from(BigInt(step).toString(16).padStart(16, '0'), 'hex');
  const mac = createHmac('sha1', secretBuf).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function currentStep(now = Date.now()) {
  return Math.floor(now / 1000 / STEP_SECONDS);
}

/** otpauth:// URI（认证器扫码绑定的标准格式，全 ASCII） */
export function totpUri(secret, account, issuer = 'WebSSH') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * 校验 6 位 TOTP 码（±1 窗口容错 + 同时间步防重放）。
 * @param {string} secretBase32 Base32 secret
 * @param {string} code 6 位数字
 * @param {{now?: number}} [opts] 可注入时间（测试）
 * @returns {boolean}
 */
export function verifyTotp(secretBase32, code, { now = Date.now() } = {}) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return false;
  const secretBuf = base32Decode(secretBase32);
  const step = currentStep(now);
  // 以 secret 哈希为键防重放（内存态：服务重启即重置，单机单管理员场景可接受）
  const key = createHash('sha256').update(secretBuf).digest('hex').slice(0, 16);
  const used = lastUsedSteps.get(key) ?? new Set();
  // 顺手清理远离当前窗口的条目，防集合无限增长
  for (const u of used) {
    if (u < step - 2) used.delete(u);
  }
  for (let delta = -WINDOW; delta <= WINDOW; delta++) {
    const s = step + delta;
    if (used.has(s)) continue; // 该时间步已被消耗
    if (totpAt(secretBase32, s) === code.trim()) {
      used.add(s);
      lastUsedSteps.set(key, used);
      return true;
    }
  }
  return false;
}

// —— 一次性恢复码：xxxx-xxxx 格式（去除易混淆字符 0/O/1/I/L），落盘仅存 SHA-256 ——
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateRecoveryCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const raw = Array.from(randomBytes(8), (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  return codes;
}

export function hashRecoveryCode(code) {
  return createHash('sha256').update(String(code).trim().toUpperCase()).digest('hex');
}

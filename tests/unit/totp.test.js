// TOTP（RFC 6238）单元测试：官方测试向量 + Base32 + 防重放 + 恢复码
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  base32Encode,
  base32Decode,
  generateTotpSecret,
  totpAt,
  currentStep,
  verifyTotp,
  totpUri,
  generateRecoveryCodes,
  hashRecoveryCode,
} from '../../src/crypto/totp.js';

// RFC 6238 附录 B 测试向量（SHA1，secret = '12345678901234567890'）
// 8 位向量截取后 6 位：59s→287082、1111111109s→081804、1111111111s→050471、
// 1234567890s→005924、2000000000s→279037、20000000000s→353130
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));
const VECTORS = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

describe('Base32', () => {
  test('编解码往返（含非 5 整数倍字节）', () => {
    for (const len of [1, 5, 10, 20, 32]) {
      const buf = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37 + 11) & 0xff));
      assert.deepEqual(base32Decode(base32Encode(buf)), buf);
    }
  });

  test('RFC 4648 示例向量（编码不带 padding，解码兼容带 padding）', () => {
    // 'foobar' -> 'MZXW6YTBOI'（无 padding 变体；解码端同时接受 '======' 形式）
    assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
    assert.equal(base32Decode('MZXW6YTBOI').toString(), 'foobar');
    assert.equal(base32Decode('MZXW6YTBOI======').toString(), 'foobar');
  });
});

describe('TOTP（RFC 6238 向量）', () => {
  for (const [t, code] of VECTORS) {
    test(`T=${t} → ${code}`, () => {
      assert.equal(totpAt(RFC_SECRET, Math.floor(t / 30)), code);
    });
  }

  test('verifyTotp 接受向量时间点；+35s 同码因防重放被拒（落在 -1 容错窗内但已消耗）', () => {
    const t = 1111111111; // step 37037037, code 050471
    assert.equal(verifyTotp(RFC_SECRET, '050471', { now: t * 1000 }), true);
    // +35s 后 step+1：同码匹配 -1 容错窗，但该 step 已被上次验证消耗 → 防重放拒绝
    assert.equal(verifyTotp(RFC_SECRET, '050471', { now: (t + 35) * 1000 }), false);
    // 另一向量的独立时间点仍正常通过
    assert.equal(verifyTotp(RFC_SECRET, '081804', { now: 1111111109 * 1000 }), true);
  });

  test('verifyTotp 拒绝错误格式与非数字码', () => {
    assert.equal(verifyTotp(RFC_SECRET, 'abcdef'), false);
    assert.equal(verifyTotp(RFC_SECRET, '12345'), false);
    assert.equal(verifyTotp(RFC_SECRET, '1234567'), false);
    assert.equal(verifyTotp(RFC_SECRET, '000000'), false);
  });
});

describe('防重放', () => {
  test('同一码在容错窗内不可二次使用', () => {
    const secret = generateTotpSecret();
    const code = totpAt(secret, currentStep());
    assert.equal(verifyTotp(secret, code), true);
    // 30 秒内（下一 step 的 -1 窗口）重放同一码 → 拒绝
    assert.equal(verifyTotp(secret, code, { now: Date.now() + 31 * 1000 }), false);
  });

  test('不同时间步的新码仍可使用', () => {
    const secret = generateTotpSecret();
    const s = currentStep();
    assert.equal(verifyTotp(secret, totpAt(secret, s), { now: s * 30000 + 1000 }), true);
    assert.equal(verifyTotp(secret, totpAt(secret, s + 1), { now: (s + 1) * 30000 + 1000 }), true);
  });
});

describe('otpauth URI', () => {
  test('标准格式：label 编码 + secret/issuer/algorithm/digits/period 参数', () => {
    const uri = totpUri('JBSWY3DPEHPK3PXP', 'local', 'WebSSH');
    assert.equal(uri, 'otpauth://totp/WebSSH%3Alocal?secret=JBSWY3DPEHPK3PXP&issuer=WebSSH&algorithm=SHA1&digits=6&period=30');
  });
});

describe('恢复码', () => {
  test('生成 8 个 xxxx-xxxx 格式码且互不重复', () => {
    const codes = generateRecoveryCodes(8);
    assert.equal(codes.length, 8);
    const set = new Set(codes);
    assert.equal(set.size, 8);
    for (const c of codes) assert.match(c, /^[A-HJ-KM-NP-Z2-9]{4}-[A-HJ-KM-NP-Z2-9]{4}$/);
  });

  test('哈希大小写不敏感 + 匹配正确性', () => {
    const [code] = generateRecoveryCodes(1);
    assert.equal(hashRecoveryCode(code), hashRecoveryCode(code.toLowerCase()));
    assert.equal(hashRecoveryCode(code), hashRecoveryCode(` ${code} `));
    assert.notEqual(hashRecoveryCode(code), hashRecoveryCode('AAAA-AAAA'));
  });
});

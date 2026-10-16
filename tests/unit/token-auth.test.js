// T073：令牌目录矩阵收紧校验（FR-035~040）+ T074：令牌认证（FR-022~026）
import { test } from 'node:test';
import assert from 'node:assert';
import { assertMatrixTightened } from '../../src/ssh/policy.js';
import { createTokenRecord, hashToken, authenticateToken, publicTokenView } from '../../src/mcp/tokens.js';
import { createFileStore } from '../../src/store/file-store.js';
import { makeTempDir } from '../helpers/tmpdir.js';

const defaults = [
  { prefix: '/var/log', read: true, write: false, download: false, modify: false, source: 'global-default' },
  { prefix: '/tmp', read: true, write: true, download: false, modify: true, source: 'global-default' },
];

test('FR-040：令牌条目只能收紧——放开权限返回 permission_out_of_range', () => {
  // 新增范围（前缀不在默认内）→ 拒绝
  assert.throws(
    () => assertMatrixTightened([{ prefix: '/etc', read: true, source: 'token-override' }], defaults),
    (e) => e.code === 'permission_out_of_range'
  );
  // 放开 write（默认 false）→ 拒绝
  assert.throws(
    () => assertMatrixTightened([{ prefix: '/var/log', read: true, write: true, source: 'token-override' }], defaults),
    (e) => e.code === 'permission_out_of_range'
  );
  // 收紧（去掉 /tmp 的写）→ 通过
  assert.doesNotThrow(() =>
    assertMatrixTightened([{ prefix: '/tmp', read: true, write: false, modify: false, source: 'token-override' }], defaults)
  );
});

test('T074：创建令牌——明文一次性返回、摘要不可逆、提示为末四位', async () => {
  const { dir, cleanup } = await makeTempDir('webssh-token-');
  try {
    const store = createFileStore({ configDir: dir });
    const { record, plaintext } = await createTokenRecord(store, {
      ownerId: '1000', name: '巡检', level: 'readonly', hostScope: ['h1'], permissions: defaults, expiresAt: null,
    });
    assert.match(plaintext, /^mcp_[0-9a-f]{48}$/);
    assert.equal(record.tokenHash, hashToken(plaintext));
    assert.equal(record.tokenHint, `${plaintext.slice(0, 6)}*${plaintext.slice(-4)}`);
    assert.ok(!JSON.stringify(record).includes(plaintext), '令牌记录不得含明文');
    const view = publicTokenView(record);
    assert.ok(!('tokenHash' in view), '公开视图不含摘要');
  } finally {
    await cleanup();
  }
});

test('T074：认证——正确明文通过、错误/撤销/过期拒绝（FR-023/026）', async () => {
  const { dir, cleanup } = await makeTempDir('webssh-token-');
  try {
    const store = createFileStore({ configDir: dir });
    async function mk(over = {}) {
      const { record, plaintext } = await createTokenRecord(store, {
        ownerId: '1000', name: 't', level: 'writable', hostScope: ['h1'], permissions: defaults, expiresAt: null, ...over,
      });
      const tokens = await store.listTokensAll();
      tokens.push(record);
      await store.saveTokens(tokens);
      return { record, plaintext };
    }
    const ok = await mk();
    assert.equal((await authenticateToken(store, ok.plaintext)).ok, true);

    const wrong = await authenticateToken(store, 'mcp_wrong'.padEnd(52, '0'));
    assert.deepEqual(wrong, { ok: false, reason: 'invalid' });

    const revoked = await mk();
    await store.touchToken(revoked.record.id, { status: 'revoked' });
    assert.equal((await authenticateToken(store, revoked.plaintext)).reason, 'revoked');

    const expired = await mk({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.equal((await authenticateToken(store, expired.plaintext)).reason, 'expired');
    // 过期后状态自动翻转为 expired
    const t = await store.getTokenById(expired.record.id);
    assert.equal(t.status, 'expired');
  } finally {
    await cleanup();
  }
});

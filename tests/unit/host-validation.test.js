// T043：主机创建/更新请求体校验（FR-004 / contracts/rest-api.md）
import { test } from 'node:test';
import assert from 'node:assert';
import { validateHostPayload } from '../../src/api/hosts.js';

const validCreate = () => ({
  name: '测试主机',
  host: '192.168.1.10',
  port: 22,
  username: 'root',
  authType: 'password',
  password: 'pw123',
});

test('合法创建载荷通过并规范化（port 缺省 22）', () => {
  const { value } = validateHostPayload({ ...validCreate(), port: undefined }, { partial: false });
  assert.equal(value.port, 22);
  assert.equal(value.authType, 'password');
});

test('创建缺失必填字段 → 抛错', () => {
  for (const field of ['name', 'host', 'username', 'authType']) {
    const bad = validCreate();
    delete bad[field];
    assert.throws(() => validateHostPayload(bad, { partial: false }), new RegExp(field));
  }
});

test('host 字段：禁止空白与分隔符（仅域名/IP 字面量）', () => {
  for (const h of ['a b', 'a;b', 'a|b', 'a&b', 'a$b', 'a\nb', '']) {
    assert.throws(() => validateHostPayload({ ...validCreate(), host: h }, { partial: false }), /host/);
  }
  // 合法值
  for (const h of ['192.168.1.10', 'nas.example.com', 'my-nas_01.example', '::ffff:1.2.3.4'.replace(/:/g, '.')]) {
    assert.ok(validateHostPayload({ ...validCreate(), host: h }, { partial: false }).value);
  }
});

test('port 越界或非整数 → 拒绝', () => {
  for (const p of [0, -1, 65536, 1.5, '22']) {
    assert.throws(() => validateHostPayload({ ...validCreate(), port: p }, { partial: false }), /port/);
  }
});

test('authType 仅允许 password / privateKey', () => {
  assert.throws(() => validateHostPayload({ ...validCreate(), authType: 'agent' }, { partial: false }), /authType/);
  assert.throws(() => validateHostPayload({ ...validCreate(), authType: null }, { partial: false }), /authType/);
});

test('凭据形态必须与 authType 匹配', () => {
  // password 认证缺 password
  const p = validCreate();
  delete p.password;
  assert.throws(() => validateHostPayload(p, { partial: false }), /password/);
  // privateKey 认证缺 privateKey
  assert.throws(
    () => validateHostPayload({ ...validCreate(), authType: 'privateKey' }, { partial: false }),
    /privateKey/
  );
  // privateKey + passphrase 合法
  assert.ok(
    validateHostPayload(
      { ...validCreate(), authType: 'privateKey', password: undefined, privateKey: '-----BEGIN...', passphrase: 'x' },
      { partial: false }
    ).value
  );
});

test('name 长度 1–64，username 非空', () => {
  assert.throws(() => validateHostPayload({ ...validCreate(), name: '' }, { partial: false }), /name/);
  assert.throws(() => validateHostPayload({ ...validCreate(), name: 'x'.repeat(65) }, { partial: false }), /name/);
  assert.throws(() => validateHostPayload({ ...validCreate(), username: '' }, { partial: false }), /username/);
});

test('group 可选，null 归一化为内置 default，字符串原样保留', () => {
  assert.equal(validateHostPayload({ ...validCreate(), group: null }, { partial: false }).value.group, 'Default');
  assert.equal(validateHostPayload({ ...validCreate(), group: '家庭' }, { partial: false }).value.group, '家庭');
  assert.throws(() => validateHostPayload({ ...validCreate(), group: 42 }, { partial: false }), /group/);
});

test('更新（partial）：字段可选但出现即校验', () => {
  // 只改名字
  const { value } = validateHostPayload({ name: 'new' }, { partial: true });
  assert.equal(value.name, 'new');
  // 出现非法值仍拒绝
  assert.throws(() => validateHostPayload({ port: 0 }, { partial: true }), /port/);
  assert.throws(() => validateHostPayload({ host: 'a b' }, { partial: true }), /host/);
});

test('未知字段被剔除（不允许注入 fingerprint / ownerId / id）', () => {
  const { value } = validateHostPayload(
    { ...validCreate(), id: 'h_evil', ownerId: 'other', fingerprint: 'SHA256:fake' },
    { partial: false }
  );
  assert.equal(value.id, undefined);
  assert.equal(value.ownerId, undefined);
  assert.equal(value.fingerprint, undefined);
});

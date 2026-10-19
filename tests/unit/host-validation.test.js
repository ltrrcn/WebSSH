// T043：主机创建/更新请求体校验（FR-004 / contracts/rest-api.md）
import { test } from 'node:test';
import assert from 'node:assert';
import { validateHostPayload, validateMcpPrefer, computeMcpOrders } from '../../src/api/hosts.js';

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

test('authType 仅允许 password / privateKey / none', () => {
  assert.throws(() => validateHostPayload({ ...validCreate(), authType: 'agent' }, { partial: false }), /authType/);
  assert.throws(() => validateHostPayload({ ...validCreate(), authType: null }, { partial: false }), /authType/);
});

test('authType=none（不记录凭据）：无需凭据即可创建，携带凭据则拒绝', () => {
  // 创建：none 不要求 password/privateKey
  const p = validCreate();
  delete p.password;
  const { value } = validateHostPayload({ ...p, authType: 'none' }, { partial: false });
  assert.equal(value.authType, 'none');
  assert.equal(value.secret, undefined, 'none 不应产生 secret');
  // none 携带凭据 → 拒绝（防止误以为会保存）
  assert.throws(
    () => validateHostPayload({ ...validCreate(), authType: 'none' }, { partial: false }),
    /none/
  );
  // PUT（partial）：仅切 authType 到 none 合法（凭据清空由路由层处理）
  assert.equal(validateHostPayload({ authType: 'none' }, { partial: true }).value.authType, 'none');
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

test('授权范围 scope：缺省/全选/终端/MCP 合法，其他值拒绝', () => {
  // 创建缺省 → all（全选）
  assert.equal(validateHostPayload(validCreate(), { partial: false }).value.scope, 'all');
  for (const s of ['all', 'terminal', 'mcp']) {
    assert.equal(validateHostPayload({ ...validCreate(), scope: s }, { partial: false }).value.scope, s);
  }
  // null 等同未提交 → 回落 all（与 group 的 null 语义一致）
  assert.equal(validateHostPayload({ ...validCreate(), scope: null }, { partial: false }).value.scope, 'all');
  for (const s of ['ALL', 'both', '', 1, true]) {
    assert.throws(
      () => validateHostPayload({ ...validCreate(), scope: s }, { partial: false }),
      /scope/,
      `scope=${JSON.stringify(s)} 应被拒绝`
    );
  }
});

test('MCP 终端提示词：合法值规范化；非法 preferHostId/scenario/requireConsent 拒绝', () => {
  const { value } = validateHostPayload(
    { ...validCreate(), scope: 'mcp', mcpPrompt: { scenario: '排查磁盘' } },
    { partial: false }
  );
  assert.deepEqual(value.mcpPrompt, {
    preferHostId: null, // 默认：不指定优先使用的连接
    scenario: '排查磁盘',
    requireConsent: false, // 默认关闭：需 Agent 经用户同意后执行
  });
  const ok = validateHostPayload(
    { ...validCreate(), scope: 'mcp', mcpPrompt: { preferHostId: '另一条连接' } },
    { partial: false }
  ).value;
  assert.equal(ok.mcpPrompt.preferHostId, '另一条连接');
  // 已无「使用优先级」字段：提交也被剔除（白名单）
  const noPriority = validateHostPayload(
    { ...validCreate(), scope: 'mcp', mcpPrompt: { priority: 'high' } },
    { partial: false }
  ).value;
  assert.equal(noPriority.mcpPrompt.priority, undefined);
  const bad = [
    { mcpPrompt: { preferHostId: 42 } },
    { mcpPrompt: { preferHostId: '' } },
    { mcpPrompt: { scenario: 'x'.repeat(501) } },
    { mcpPrompt: { requireConsent: 'yes' } },
    { mcpPrompt: [] },
  ];
  for (const over of bad) {
    assert.throws(
      () => validateHostPayload({ ...validCreate(), scope: 'mcp', ...over }, { partial: false }),
      /mcpPrompt/,
      `${JSON.stringify(over)} 应被拒绝`
    );
  }
  // 「需经用户同意」默认关闭，显式 true 才开启
  assert.equal(
    validateHostPayload({ ...validCreate(), scope: 'mcp', mcpPrompt: { requireConsent: true } }, { partial: false })
      .value.mcpPrompt.requireConsent,
    true
  );
});

test('终端范围：携带 mcpPrompt 拒绝；切到 terminal 时提示词置空', () => {
  assert.throws(
    () => validateHostPayload({ ...validCreate(), scope: 'terminal', mcpPrompt: { scenario: 'x' } }, { partial: false }),
    /mcpPrompt/
  );
  // 未提交提示词但把范围切成 terminal → 显式清空，避免残留对 MCP 不可见的提示词
  const { value } = validateHostPayload({ scope: 'terminal' }, { partial: true, current: { scope: 'mcp' } });
  assert.equal(value.scope, 'terminal');
  assert.equal(value.mcpPrompt, null);
  // 未提交 scope 时沿用既有范围：mcp 记录仍接受提示词
  const keep = validateHostPayload({ mcpPrompt: { scenario: 'y' } }, { partial: true, current: { scope: 'mcp' } });
  assert.equal(keep.value.mcpPrompt.scenario, 'y');
  // 未提交 scope 且既有范围为 terminal → 提示词仍被拒绝
  assert.throws(
    () => validateHostPayload({ mcpPrompt: { scenario: 'y' } }, { partial: true, current: { scope: 'terminal' } }),
    /mcpPrompt/
  );
});

test('MCP 使用顺序：默认 1；指定优先连接后顺延为「目标顺序 + 1」（链式 1→2→3）', () => {
  const h = (id, preferHostId = null, over = {}) => ({ id, mcpPrompt: { preferHostId }, ...over });
  // 全部默认 → 都是 1
  assert.deepEqual([...computeMcpOrders([h('a'), h('b')]).values()], [1, 1]);
  // a 优先使用 b → b=1，a=2
  const two = computeMcpOrders([h('a', 'b'), h('b')]);
  assert.equal(two.get('b'), 1);
  assert.equal(two.get('a'), 2);
  // 链：c=1，b 优先 c → 2，a 优先 b → 3（前面已是 2 则当前为 3）
  const three = computeMcpOrders([h('a', 'b'), h('b', 'c'), h('c')]);
  assert.equal(three.get('c'), 1);
  assert.equal(three.get('b'), 2);
  assert.equal(three.get('a'), 3);
  // 悬空引用（目标已删除）→ 回落 1
  assert.equal(computeMcpOrders([h('a', 'gone')]).get('a'), 1);
  // 自引用与环：截断为有限值，不得无限递增
  const cyc = computeMcpOrders([h('a', 'b'), h('b', 'a')]);
  for (const n of cyc.values()) assert.ok(Number.isFinite(n) && n >= 1 && n <= 3, `环中顺序应有界，实际 ${n}`);
  // 终端范围的连接不参与顺序计算（对 MCP 不可见）
  assert.equal(computeMcpOrders([h('a', 'b'), h('b', null, { scope: 'terminal' })]).get('a'), 1);
});

test('优先使用目标校验：须为同分组、对 MCP 可见的其他连接，且不得成环', () => {
  const hosts = [
    { id: 'a', group: 'Default', scope: 'all', mcpPrompt: null },
    { id: 'b', group: 'Default', scope: 'all', mcpPrompt: null },
    { id: 'c', group: '生产', scope: 'all', mcpPrompt: null },
    { id: 't', group: 'Default', scope: 'terminal', mcpPrompt: null },
  ];
  // 默认（不指定）→ 合法
  assert.equal(validateMcpPrefer({ preferHostId: null, hosts }), null);
  assert.equal(validateMcpPrefer({ preferHostId: 'b', selfId: 'a', group: 'Default', hosts }), null);
  assert.match(validateMcpPrefer({ preferHostId: 'a', selfId: 'a', group: 'Default', hosts }), /自身/);
  assert.match(validateMcpPrefer({ preferHostId: '不存在', selfId: 'a', group: 'Default', hosts }), /不存在或无权访问/);
  assert.match(validateMcpPrefer({ preferHostId: 'c', selfId: 'a', group: 'Default', hosts }), /同一分组/);
  assert.match(validateMcpPrefer({ preferHostId: 't', selfId: 'a', group: 'Default', hosts }), /不可见/);
  // 成环：b 已优先 a，再让 a 优先 b
  const cyclic = [{ id: 'a', group: 'Default', scope: 'all', mcpPrompt: { preferHostId: 'b' } }, { id: 'b', group: 'Default', scope: 'all', mcpPrompt: { preferHostId: 'a' } }];
  assert.match(validateMcpPrefer({ preferHostId: 'a', selfId: 'b', group: 'Default', hosts: cyclic }), /循环依赖/);
  assert.equal(validateMcpPrefer({ preferHostId: 'a', selfId: 'c', group: 'Default', hosts: cyclic }), null);
});

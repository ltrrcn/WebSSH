// T042：主机 CRUD 契约（contracts/rest-api.md）
// 越权 403 且不暴露资源存在性；任何响应不得含明文凭据或 secret 结构
import { test } from 'node:test';
import assert from 'node:assert';
import { makeTempDir } from '../helpers/tmpdir.js';
import { seedHost } from '../helpers/seed-host.js';
import { startApp } from '../../src/net/server.js';
import { totpAt, currentStep } from '../../src/crypto/totp.js';

async function setup() {
  const { dir, cleanup } = await makeTempDir('webssh-hosts-');
  const app = await startApp({
    env: { WEBSSH_HOME: dir },
    config: {
      standalone: { bind: '127.0.0.1', port: 0 },
      limits: { sessionsPerUser: 10 },
    },
  });
  return { app, cleanup, base: `http://127.0.0.1:${app.port}` };
}

const SECRET_PW = 'super-secret-pw-123';

function createBody(over = {}) {
  return {
    name: '测试主机',
    host: '127.0.0.1',
    port: 22,
    username: 'root',
    authType: 'password',
    password: SECRET_PW,
    group: '测试组',
    ...over,
  };
}

test('POST /api/hosts 创建主机 → 201，响应不含 secret 与明文凭据', async () => {
  const { app, cleanup, base } = await setup();
  try {
    const res = await fetch(`${base}/api/hosts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody()),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.id, '应返回生成的 id');
    assert.equal(body.id, '测试主机', '设备 ID 应取会话名称');
    const text = JSON.stringify(body);
    assert.ok(!('secret' in body), '响应不得包含 secret 结构');
    assert.ok(!text.includes(SECRET_PW), '响应不得包含明文口令');
    assert.equal(body.hasSecret, true);
    // 落盘内容必须是密文结构
    const host = await app.deps.store.getHost(body.id, 'local');
    assert.equal(host.secret.alg, 'aes-256-gcm');
    assert.ok(!JSON.stringify(host.secret).includes(SECRET_PW));
  } finally {
    await app.close();
    await cleanup();
  }
});

test('设备 ID 取会话名称：同名追加序号，副本取副本名，多主机互不相同', async () => {
  const { app, cleanup, base } = await setup();
  try {
    const post = async () =>
      (await fetch(`${base}/api/hosts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createBody()),
      })).json();
    const a = await post();
    const b = await post();
    assert.equal(a.id, '测试主机', '设备 ID 取会话名称');
    assert.equal(b.id, '测试主机-2', '同名设备追加序号保证唯一');
    assert.notEqual(a.id, b.id, 'ID 不得重复');
    // 副本 ID 取副本名
    const dup = await (await fetch(`${base}/api/hosts/${encodeURIComponent(b.id)}/duplicate`, { method: 'POST' })).json();
    assert.equal(dup.id, '测试主机-副本');
    assert.notEqual(dup.id, a.id);
    assert.notEqual(dup.id, b.id);
  } finally {
    await app.close();
    await cleanup();
  }
});

test('设备 ID 全局唯一：他人已占用同名 ID 时追加序号（跨用户不重复）', async () => {
  const { app, cleanup, base } = await setup();
  try {
    await seedHost({
      configDir: app.runtime.paths.config,
      id: '测试主机',
      ownerId: 'someone-else',
      password: 'their-pw',
    });
    const res = await fetch(`${base}/api/hosts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody()),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.id, '测试主机-2', '他人已占用该设备 ID 时必须另取，不得重复');
  } finally {
    await app.close();
    await cleanup();
  }
});

test('GET /api/hosts 与 /api/hosts/{id} 返回条目（无凭据）', async () => {
  const { app, cleanup, base } = await setup();
  try {
    const created = await (await fetch(`${base}/api/hosts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody()),
    })).json();

    const list = await (await fetch(`${base}/api/hosts`)).json();
    assert.ok(list.some((h) => h.id === created.id));

    const one = await (await fetch(`${base}/api/hosts/${created.id}`)).json();
    assert.equal(one.id, created.id);
    assert.equal(one.name, '测试主机');
    assert.ok(!('secret' in one));
    assert.ok(!JSON.stringify(one).includes(SECRET_PW));
  } finally {
    await app.close();
    await cleanup();
  }
});

test('PUT /api/hosts/{id}：改名生效；不传凭据保持不变', async () => {
  const { app, cleanup, base } = await setup();
  try {
    const created = await (await fetch(`${base}/api/hosts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody()),
    })).json();
    const before = await app.deps.store.getHost(created.id, 'local');

    const res = await fetch(`${base}/api/hosts/${created.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '新名字' }),
    });
    assert.equal(res.status, 200);
    const after = await app.deps.store.getHost(created.id, 'local');
    assert.equal(after.name, '新名字');
    assert.deepEqual(after.secret, before.secret, '不传凭据 → secret 保持不变');
  } finally {
    await app.close();
    await cleanup();
  }
});

test('PUT 修改目标地址 → 指纹重置为未确认（防新地址沿用旧指纹）', async () => {
  const { app, cleanup, base } = await setup();
  try {
    const created = await (await fetch(`${base}/api/hosts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody()),
    })).json();
    // 人为写入已确认指纹
    await app.deps.store.touchHost(created.id, { fingerprint: 'SHA256:old' });

    await fetch(`${base}/api/hosts/${created.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: '192.168.50.20' }),
    });
    const after = await app.deps.store.getHost(created.id, 'local');
    assert.equal(after.fingerprint, null, '地址变化后指纹必须重置');
    assert.equal(after.host, '192.168.50.20');
  } finally {
    await app.close();
    await cleanup();
  }
});

test('PUT 更换凭据 → secret 被替换', async () => {
  const { app, cleanup, base } = await setup();
  try {
    const created = await (await fetch(`${base}/api/hosts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody()),
    })).json();
    const before = (await app.deps.store.getHost(created.id, 'local')).secret;
    await fetch(`${base}/api/hosts/${created.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'brand-new-pw' }),
    });
    const after = (await app.deps.store.getHost(created.id, 'local')).secret;
    assert.notEqual(after.data, before.data, '凭据应被替换');
    assert.notEqual(after.iv, before.iv);
    assert.ok(!JSON.stringify(after).includes('brand-new-pw'));
  } finally {
    await app.close();
    await cleanup();
  }
});

test('DELETE /api/hosts/{id}：删除后不可见、不可连', async () => {
  const { app, cleanup, base } = await setup();
  try {
    const created = await (await fetch(`${base}/api/hosts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody()),
    })).json();
    const res = await fetch(`${base}/api/hosts/${created.id}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal((await fetch(`${base}/api/hosts/${created.id}`)).status, 404);
    const gone = await app.deps.store.getHost(created.id, 'local');
    assert.equal(gone, undefined, '凭据随主机一并删除');
  } finally {
    await app.close();
    await cleanup();
  }
});

test('非法字段 → 422，错误信息不含凭据', async () => {
  const { app, cleanup, base } = await setup();
  try {
    for (const bad of [
      { host: 'a b' }, { port: 0 }, { port: 70000 }, { authType: 'agent' },
      { username: '' }, { name: '' },
    ]) {
      const res = await fetch(`${base}/api/hosts`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createBody(bad)),
      });
      assert.equal(res.status, 422, `应 422: ${JSON.stringify(bad)}`);
      const err = await res.json();
      assert.ok(err.error?.code, '应返回结构化错误');
    }
  } finally {
    await app.close();
    await cleanup();
  }
});

test('越权访问他人主机 → 403，不暴露存在性与凭据（FR-009）', async () => {
  const { app, cleanup, base } = await setup();
  try {
    // 归属 other 用户的主机
    const dir = app.runtime.paths.config;
    const other = await seedHost({ configDir: dir, id: 'h_other', ownerId: 'someone-else', password: 'their-pw' });

    for (const [method, path] of [
      ['GET', `/api/hosts/${other.id}`],
      ['PUT', `/api/hosts/${other.id}`],
      ['DELETE', `/api/hosts/${other.id}`],
    ]) {
      const res = await fetch(`${base}${path}`, { method });
      assert.equal(res.status, 403, `${method} 他人主机应 403`);
      const text = await res.text();
      assert.ok(!text.includes('their-pw'), '不得泄露凭据');
    }
    // 列表中也看不到
    const list = await (await fetch(`${base}/api/hosts`)).json();
    assert.ok(!list.some((h) => h.id === other.id), '他人主机不可见');
  } finally {
    await app.close();
    await cleanup();
  }
});

test('POST /api/hosts/{id}/duplicate：复制连接（含凭据密文），生成独立「副本」（FR-056）', async () => {
  const { app, cleanup, base } = await setup();
  try {
    const created = await (await fetch(`${base}/api/hosts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody()),
    })).json();

    const res = await fetch(`${base}/api/hosts/${created.id}/duplicate`, { method: 'POST' });
    assert.equal(res.status, 200);
    const copy = await res.json();
    assert.notEqual(copy.id, created.id, '副本必须是独立条目');
    assert.equal(copy.name, '测试主机 副本');
    assert.equal(copy.hasSecret, true);
    assert.ok(!JSON.stringify(copy).includes(SECRET_PW), '副本响应不含明文');

    // 凭据密文原样复制，解密可用
    const src = await app.deps.store.getHost(created.id, 'local');
    const dup = await app.deps.store.getHost(copy.id, 'local');
    assert.deepEqual(dup.secret, src.secret);
    // 删除原条目不影响副本（独立性）
    await fetch(`${base}/api/hosts/${created.id}`, { method: 'DELETE' });
    const stillThere = await app.deps.store.getHost(copy.id, 'local');
    assert.ok(stillThere, '副本独立于原条目存在');
  } finally {
    await app.close();
    await cleanup();
  }
});

test('duplicate 越权/不存在：他人条目 403，不存在 404（FR-056）', async () => {
  const { app, cleanup, base } = await setup();
  try {
    const dir = app.runtime.paths.config;
    const other = await seedHost({ configDir: dir, id: 'h_other2', ownerId: 'someone-else', password: 'x' });
    const r1 = await fetch(`${base}/api/hosts/${other.id}/duplicate`, { method: 'POST' });
    assert.equal(r1.status, 403);
    const r2 = await fetch(`${base}/api/hosts/h_nonexistent/duplicate`, { method: 'POST' });
    assert.equal(r2.status, 404);
  } finally {
    await app.close();
    await cleanup();
  }
});

test('授权范围 scope：默认全选；MCP 模式保留终端提示词；终端模式不携带提示词', async () => {
  const { app, cleanup, base } = await setup();
  try {
    const post = async (over) =>
      (await fetch(`${base}/api/hosts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createBody(over)),
      })).json();

    // 默认：全选
    const all = await post({ name: '默认范围' });
    assert.equal(all.scope, 'all');
    assert.deepEqual(all.mcpPrompt, {
      preferHostId: null,
      scenario: '',
      requireConsent: false, // 默认关闭：需 Agent 经用户同意后执行
    });

    // MCP 模式：提示词落盘并回读
    const mcp = await post({
      name: 'MCP 范围',
      scope: 'mcp',
      mcpPrompt: { scenario: '排查磁盘' },
    });
    assert.equal(mcp.scope, 'mcp');
    assert.deepEqual(mcp.mcpPrompt, {
      preferHostId: null,
      scenario: '排查磁盘',
      requireConsent: false,
    });

    // 「需经用户同意」默认关闭，可显式开启并落盘
    const on = await (await fetch(`${base}/api/hosts/${encodeURIComponent(mcp.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mcpPrompt: { scenario: '排查磁盘', requireConsent: true } }),
    })).json();
    assert.equal(on.mcpPrompt.requireConsent, true);

    // 终端模式：提示词恒为 null
    const term = await post({ name: '终端范围', scope: 'terminal' });
    assert.equal(term.scope, 'terminal');
    assert.equal(term.mcpPrompt, null);

    // 终端模式携带提示词 → 422
    const bad = await fetch(`${base}/api/hosts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody({ name: '非法组合', scope: 'terminal', mcpPrompt: { scenario: 'x' } })),
    });
    assert.equal(bad.status, 422);
    assert.match((await bad.json()).error.message, /mcpPrompt/);

    // 切到终端模式：已保存的提示词被清空
    const switched = await (await fetch(`${base}/api/hosts/${encodeURIComponent(mcp.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'terminal' }),
    })).json();
    assert.equal(switched.scope, 'terminal');
    assert.equal(switched.mcpPrompt, null);
  } finally {
    await app.close();
    await cleanup();
  }
});

test('MCP 优先使用：仅同分组内其他连接可选；顺序默认 1，指定后顺延（前面是 2 则当前 3）', async () => {
  const { app, cleanup, base } = await setup();
  try {
    const post = async (over) =>
      (await fetch(`${base}/api/hosts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createBody(over)),
      })).json();
    const put = async (id, body) =>
      fetch(`${base}/api/hosts/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const orders = async () =>
      Object.fromEntries((await (await fetch(`${base}/api/hosts`)).json()).map((h) => [h.id, h.mcpOrder]));

    const c = await post({ name: 'C', group: 'Default' });
    const b = await post({ name: 'B', group: 'Default' });
    const a = await post({ name: 'A', group: 'Default' });
    const x = await post({ name: 'X', group: '生产' }); // 不同分组
    // 未指定优先使用 → 顺序均为 1
    assert.deepEqual(
      [a, b, c].map((h) => h.mcpOrder),
      [1, 1, 1]
    );

    // A 优先使用 B：B 保持 1，A 顺延为 2
    const r1 = await put(a.id, { mcpPrompt: { preferHostId: b.id } });
    assert.equal(r1.status, 200);
    assert.equal((await orders())[a.id], 2);
    assert.equal((await orders())[b.id], 1);

    // B 优先使用 C：C=1，B=2 → A 顺延为 3（前面已是 2 则当前为 3）
    const r2 = await put(b.id, { mcpPrompt: { preferHostId: c.id } });
    assert.equal(r2.status, 200);
    const chain = await orders();
    assert.deepEqual([chain[c.id], chain[b.id], chain[a.id]], [1, 2, 3]);

    // 非法指向：跨分组 / 自身 / 不存在 / 成环
    for (const [target, self, re] of [
      [x.id, a.id, /同一分组/],
      [a.id, a.id, /自身/],
      ['不存在', a.id, /不存在或无权访问/],
      [a.id, c.id, /循环依赖/], // C→A 与既有 A→B→C 成环
    ]) {
      const bad = await put(self, { mcpPrompt: { preferHostId: target } });
      assert.equal(bad.status, 422, `应 422: ${self} → ${target}`);
      assert.match((await bad.json()).error.message, re);
    }
    // 创建时同样校验：跨分组 → 422
    const badCreate = await fetch(`${base}/api/hosts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody({ name: '跨分组优先', group: 'Default', mcpPrompt: { preferHostId: x.id } })),
    });
    assert.equal(badCreate.status, 422);

    // 删除被指向的连接 → 引用失效置回默认（B 回到 1，A 顺延为 2）
    await fetch(`${base}/api/hosts/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
    const after = await orders();
    assert.equal(after[b.id], 1);
    assert.equal(after[a.id], 2);
  } finally {
    await app.close();
    await cleanup();
  }
});

test('仅 MCP 授权范围：编辑受 2FA 保护（未验证 403 twofa_required，持票据放行）', async () => {
  const { app, cleanup, base } = await setup();
  try {
    // 绑定 2FA（setup → TOTP 确认），拿到受保护操作票据
    const { secret } = await (await fetch(`${base}/api/2fa/setup`, { method: 'POST' })).json();
    const code = totpAt(secret, currentStep());
    const confirm = await (await fetch(`${base}/api/2fa/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })).json();
    const ticket = confirm.ticket;
    assert.ok(ticket, '确认绑定应签发票据');

    // 创建「仅 MCP」连接：未验证 → 403
    const blocked = await fetch(`${base}/api/hosts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody({ name: '仅MCP', scope: 'mcp' })),
    });
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error.code, 'twofa_required');

    // 持票据创建成功
    const created = await (await fetch(`${base}/api/hosts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-2fa-ticket': ticket },
      body: JSON.stringify(createBody({ name: '仅MCP', scope: 'mcp' })),
    })).json();
    assert.equal(created.scope, 'mcp');

    // 编辑（唯一变更入口）同样受保护
    const editBlocked = await fetch(`${base}/api/hosts/${encodeURIComponent(created.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '仅MCP改名' }),
    });
    assert.equal(editBlocked.status, 403);
    assert.equal((await editBlocked.json()).error.code, 'twofa_required');

    const edited = await (await fetch(`${base}/api/hosts/${encodeURIComponent(created.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-2fa-ticket': ticket },
      body: JSON.stringify({ name: '仅MCP改名' }),
    })).json();
    assert.equal(edited.name, '仅MCP改名');

    // 全选范围的普通编辑不受 2FA 影响
    const plain = await (await fetch(`${base}/api/hosts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody({ name: '普通连接' })),
    })).json();
    const plainEdit = await fetch(`${base}/api/hosts/${encodeURIComponent(plain.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '普通连接改名' }),
    });
    assert.equal(plainEdit.status, 200);
  } finally {
    await app.close();
    await cleanup();
  }
});

test('「仅终端」范围的会话连接对 MCP 不可见（list_hosts 不列出、工具调用越权）', async () => {
  const { app, cleanup, base } = await setup();
  try {
    const post = async (over) =>
      (await fetch(`${base}/api/hosts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createBody(over)),
      })).json();
    const visible = await post({ name: '可被MCP使用' });
    const hidden = await post({ name: '仅终端', scope: 'terminal' });

    const token = await (await fetch(`${base}/api/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '范围可见性', level: 'readonly', hostScope: [], hostGroups: [], allHosts: true }),
    })).json();

    const rpc = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_hosts', arguments: {} } }),
    });
    const listed = JSON.parse((await rpc.json()).result.content[0].text).hosts.map((h) => h.id);
    assert.ok(listed.includes(visible.id), '全选范围的连接应可见');
    assert.ok(!listed.includes(hidden.id), '仅终端范围的连接对 MCP 不可见');

    // 即便直接指定目标主机也判定越权
    const call = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token.token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { hostId: hidden.id, path: '/var/log/syslog' } },
      }),
    });
    const err = JSON.parse((await call.json()).result.content[0].text);
    assert.equal(err.error, 'host_not_allowed');
  } finally {
    await app.close();
    await cleanup();
  }
});

test('verify-hostkey：确认指纹后可连接前的状态翻转（FR-007）', async () => {
  const { app, cleanup, base } = await setup();
  try {
    const created = await (await fetch(`${base}/api/hosts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody()),
    })).json();

    // 未确认前
    let one = await (await fetch(`${base}/api/hosts/${created.id}`)).json();
    assert.equal(one.fingerprintConfirmed, false);

    // 确认指纹
    const res = await fetch(`${base}/api/hosts/${created.id}/verify-hostkey`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fingerprint: 'SHA256:testconfirmedfp0123456789' }),
    });
    assert.equal(res.status, 200);
    const host = await app.deps.store.getHost(created.id, 'local');
    assert.equal(host.fingerprint, 'SHA256:testconfirmedfp0123456789');
    assert.ok(host.fingerprintConfirmedAt);

    one = await (await fetch(`${base}/api/hosts/${created.id}`)).json();
    assert.equal(one.fingerprintConfirmed, true);
  } finally {
    await app.close();
    await cleanup();
  }
});

// —— 登录后自动执行脚本（scripts 字段全链路：创建回读 / 更新清空 / 非法拒绝）——
test('scripts 字段：创建保存 → GET 回读 → PUT 整体替换与清空 → 非法值 422', async () => {
  const { app, cleanup, base } = await setup();
  try {
    // 创建携带脚本 → 201 且回读可见
    const res = await fetch(`${base}/api/hosts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody({ scripts: [' df -h ', 'uptime'] })),
    });
    assert.equal(res.status, 201);
    const created = await res.json();
    assert.deepEqual(created.scripts, [{ command: 'df -h', delaySec: 0 }, { command: 'uptime', delaySec: 0 }], '脚本应 trim 后按序返回（字符串简写归一为对象）');
    assert.equal(created.lastConnectedAt, null, '未连接过的主机最近连接时间应为 null');
    const id = created.id;

    // 不携带 scripts 的 GET 同样可见
    const got = await (await fetch(`${base}/api/hosts/${id}`)).json();
    assert.deepEqual(got.scripts, [{ command: 'df -h', delaySec: 0 }, { command: 'uptime', delaySec: 0 }]);

    // PUT 整体替换
    const put = await fetch(`${base}/api/hosts/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scripts: [{ command: 'free -m', delaySec: 3 }] }),
    });
    assert.equal(put.status, 200);
    assert.deepEqual((await put.json()).scripts, [{ command: 'free -m', delaySec: 3 }]);

    // PUT 空数组 = 清空
    const clear = await fetch(`${base}/api/hosts/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scripts: [] }),
    });
    assert.equal(clear.status, 200);
    assert.deepEqual((await clear.json()).scripts, []);

    // 非法形态：含换行 → 422
    const bad = await fetch(`${base}/api/hosts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody({ scripts: ['a\nb'] })),
    });
    assert.equal(bad.status, 422);
    assert.match((await bad.json()).error.message, /换行/);
  } finally {
    await app.close();
    await cleanup();
  }
});

// —— 连接级会话参数（高级页）：创建回读 / 整体替换 / 清空 ——
test('session 字段：创建保存 → GET 回读 → PUT 替换与清空', async () => {
  const { app, cleanup, base } = await setup();
  try {
    const res = await fetch(`${base}/api/hosts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody({ session: { idleTimeoutMs: 0, connectTimeoutMs: 30000, startDirectory: '~/projects' } })),
    });
    assert.equal(res.status, 201);
    const created = await res.json();
    assert.equal(created.session.idleTimeoutMs, 0);
    assert.equal(created.session.connectTimeoutMs, 30000);
    assert.equal(created.session.startDirectory, '~/projects');
    assert.equal(created.session.blockedCommands, null);
    const id = created.id;

    // PUT 整体替换（未携带字段 = 跟随全局）
    const put = await fetch(`${base}/api/hosts/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: { idleTimeoutMs: 300000 } }),
    });
    assert.equal(put.status, 200);
    const putBody = (await put.json()).session;
    assert.equal(putBody.idleTimeoutMs, 300000);
    assert.equal(putBody.connectTimeoutMs, null);
    assert.equal(putBody.startDirectory, null);

    // null 清空
    const clear = await fetch(`${base}/api/hosts/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: null }),
    });
    assert.equal(clear.status, 200);
    assert.equal((await clear.json()).session, null);

    // 非法值 → 422
    const bad = await fetch(`${base}/api/hosts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody({ session: { idleTimeoutMs: 5 } })),
    });
    assert.equal(bad.status, 422);
  } finally {
    await app.close();
    await cleanup();
  }
});

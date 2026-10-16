// 2FA 契约测试：绑定状态机全流转 + 受保护路由 403 → verify → ticket → 放行 + 防爆破锁定 + 恢复入口
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from '../helpers/tmpdir.js';
import { startApp } from '../../src/net/server.js';
import { totpAt, currentStep } from '../../src/crypto/totp.js';

async function makeApp() {
  const { dir, cleanup } = await makeTempDir('webssh-2fa-');
  const app = await startApp({
    env: { WEBSSH_HOME: dir },
    config: {
      standalone: { bind: '127.0.0.1', port: 0 },
      twofa: {
        enabled: false,
        secret: null,
        confirmedAt: null,
        recoveryCodes: [],
        protectedActions: { audit: true, tokens: true },
        failedAttempts: 0,
        lockedUntil: null,
        recoveryAttempts: 0,
      },
    },
  });
  return {
    base: `http://127.0.0.1:${app.port}`,
    etcDir: join(dir, 'etc'),
    cleanup: async () => {
      await app.close();
      await cleanup();
    },
  };
}

const json = (r) => r.json().catch(() => null);

describe('2FA 绑定状态机', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await makeApp();
  });

  test('setup → confirm → 恢复码一次性返回 → status 反映绑定', async () => {
    const { base, cleanup } = ctx;
    try {
      // 未绑定时 status（不受保护，否则无法进入绑定流程）
      assert.equal((await json(await fetch(`${base}/api/2fa/status`))).enabled, false);

      // 未绑定 2FA 时禁止开启输出摘要记录（后端强制；关闭不受限）
      const onBlocked = await fetch(`${base}/api/audit-settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recordTerminalOutput: true }),
      });
      assert.equal(onBlocked.status, 422);
      assert.equal((await json(onBlocked)).error.code, 'twofa_not_enabled');
      const offOk = await fetch(`${base}/api/audit-settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recordTerminalOutput: false }),
      });
      assert.equal(offOk.status, 200);

      // setup：返回 secret 与 otpauth URI
      const setup = await json(await fetch(`${base}/api/2fa/setup`, { method: 'POST' }));
      assert.match(setup.secret, /^[A-Z2-7]{32}$/);
      assert.match(setup.uri, /^otpauth:\/\/totp\/WebSSH%3Alocal\?secret=/);

      // confirm：用服务端同源算法生成当前 step 的码
      const code = totpAt(setup.secret, currentStep());
      const confirm = await fetch(`${base}/api/2fa/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      assert.equal(confirm.status, 200);
      const { recoveryCodes, ticket } = await confirm.json();
      assert.equal(recoveryCodes.length, 8);
      // confirm 同步签发票据（面板免重弹）
      assert.match(ticket, /^[0-9a-f]{48}$/);

      // status：已绑定后本身受 2FA 保护
      const blocked = await fetch(`${base}/api/2fa/status`);
      assert.equal(blocked.status, 403);
      assert.equal((await json(blocked)).error.code, 'twofa_required');

      // 携带 confirm 签发的票据：已启用 + 8 个恢复码
      const status = await json(
        await fetch(`${base}/api/2fa/status`, { headers: { 'x-2fa-ticket': ticket } })
      );
      assert.equal(status.enabled, true);
      assert.equal(status.remainingRecoveryCodes, 8);

      // 已绑定后重复 setup → 409
      const again = await fetch(`${base}/api/2fa/setup`, { method: 'POST' });
      assert.equal(again.status, 409);
    } finally {
      await cleanup();
    }
  });

  test('confirm 错误码 → 422；setup 过期（无 pending）→ 409', async () => {
    const { base, cleanup } = ctx;
    try {
      // 无 pending 直接 confirm
      const noPending = await fetch(`${base}/api/2fa/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: '123456' }),
      });
      assert.equal(noPending.status, 409);
      assert.equal((await json(noPending)).error.code, 'setup_expired');

      // 错误码 confirm
      const setup = await json(await fetch(`${base}/api/2fa/setup`, { method: 'POST' }));
      const bad = await fetch(`${base}/api/2fa/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: '000000' }),
      });
      assert.equal(bad.status, 422);
      assert.equal((await json(bad)).error.code, 'invalid_code');
      assert.equal(setup.uri.length > 0, true);
    } finally {
      await cleanup();
    }
  });
});

describe('受保护路由拦截与票据', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await makeApp();
  });

  test('audit/tokens 路由：403 twofa_required → verify（恢复码）→ ticket → 放行', async () => {
    const { base, cleanup } = ctx;
    try {
      // 绑定
      const setup = await json(await fetch(`${base}/api/2fa/setup`, { method: 'POST' }));
      const confirm = await json(
        await fetch(`${base}/api/2fa/confirm`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: totpAt(setup.secret, currentStep()) }),
        })
      );
      const [recovery] = confirm.recoveryCodes;

      // 1) 未验证：受保护路由全部 403 twofa_required
      for (const [method, path] of [
        ['GET', '/api/audit'],
        ['GET', '/api/audit/sessions'],
        ['GET', '/api/audit/export'],
        ['PUT', '/api/audit-settings'],
        ['POST', '/api/tokens'],
      ]) {
        const res = await fetch(base + path, {
          method,
          headers: method === 'PUT' || method === 'POST' ? { 'content-type': 'application/json' } : {},
          body: method === 'PUT' ? '{}' : method === 'POST' ? '{"name":"t","level":"readonly","hostScope":[]}' : undefined,
        });
        assert.equal(res.status, 403, `${method} ${path} 应被 2FA 拦截`);
        assert.equal((await json(res)).error.code, 'twofa_required');
      }

      // 未受保护路由不受影响（令牌列表）
      assert.equal((await fetch(`${base}/api/tokens`)).status, 200);

      // 2) verify：用恢复码换票据
      const verify = await fetch(`${base}/api/2fa/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: recovery }),
      });
      assert.equal(verify.status, 200);
      const { ticket, ttlSeconds } = await verify.json();
      assert.match(ticket, /^[0-9a-f]{48}$/);
      assert.equal(ttlSeconds, 300);
      // 恢复码一次性：status 计数 -1（status 已绑定后需票据）
      assert.equal(
        (await json(await fetch(`${base}/api/2fa/status`, { headers: { 'x-2fa-ticket': ticket } })))
          .remainingRecoveryCodes,
        7
      );

      // 3) 携带票据：受保护路由放行
      const withTicket = await fetch(`${base}/api/audit?limit=1`, {
        headers: { 'x-2fa-ticket': ticket },
      });
      assert.equal(withTicket.status, 200);

      // 绑定 2FA + 有效票据：开启输出摘要记录放行（未绑定时被 422 拦截，见状态机测试）
      const enableOutput = await fetch(`${base}/api/audit-settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-2fa-ticket': ticket },
        body: JSON.stringify({ recordTerminalOutput: true }),
      });
      assert.equal(enableOutput.status, 200);

      // 票据期限内可复用（非一次性）
      assert.equal(
        (await fetch(`${base}/api/audit?limit=1`, { headers: { 'x-2fa-ticket': ticket } })).status,
        200
      );

      // 4) 无效票据仍拦截
      const badTicket = await fetch(`${base}/api/audit?limit=1`, {
        headers: { 'x-2fa-ticket': 'deadbeef'.repeat(6) },
      });
      assert.equal(badTicket.status, 403);
    } finally {
      await cleanup();
    }
  });

  test('动作开关：关闭 tokens 保护后令牌创建不再拦截', async () => {
    const { base, cleanup } = ctx;
    try {
      const setup = await json(await fetch(`${base}/api/2fa/setup`, { method: 'POST' }));
      const confirm = await json(
        await fetch(`${base}/api/2fa/confirm`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: totpAt(setup.secret, currentStep()) }),
        })
      );
      const { ticket } = await json(
        await fetch(`${base}/api/2fa/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: confirm.recoveryCodes[0] }),
        })
      );

      // 修改动作开关需票据
      const noTicket = await fetch(`${base}/api/2fa/actions`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tokens: false }),
      });
      assert.equal(noTicket.status, 403);

      const update = await fetch(`${base}/api/2fa/actions`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-2fa-ticket': ticket },
        body: JSON.stringify({ tokens: false }),
      });
      assert.equal(update.status, 200);
      assert.equal((await json(update)).protectedActions.tokens, false);

      // tokens 已不保护：创建令牌直接放行（主机范围校验 422 而非 403）
      const create = await fetch(`${base}/api/tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 't', level: 'readonly', hostScope: [] }),
      });
      assert.equal(create.status, 201);
    } finally {
      await cleanup();
    }
  });

  test('验证有效期：ticket-ttl 需票据 → 新 TTL 反映在 verify 与 status；越界值 422', async () => {
    const { base, cleanup } = ctx;
    try {
      // 绑定（confirm 同步签发票据）
      const setup = await json(await fetch(`${base}/api/2fa/setup`, { method: 'POST' }));
      const confirm = await json(
        await fetch(`${base}/api/2fa/confirm`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: totpAt(setup.secret, currentStep()) }),
        })
      );
      const ticket = confirm.ticket;
      assert.equal(confirm.ttlSeconds, 300, '默认有效期应为 5 分钟');

      // status 返回当前有效期
      const status = await json(
        await fetch(`${base}/api/2fa/status`, { headers: { 'x-2fa-ticket': ticket } })
      );
      assert.equal(status.ticketTtlMinutes, 5);

      // 无票据修改 → 403
      const noTicket = await fetch(`${base}/api/2fa/ticket-ttl`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticketTtlMinutes: 10 }),
      });
      assert.equal(noTicket.status, 403);

      // 越界值（0 / 61 / 非整数）→ 422
      for (const bad of [0, 61, 7.5]) {
        const res = await fetch(`${base}/api/2fa/ticket-ttl`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'x-2fa-ticket': ticket },
          body: JSON.stringify({ ticketTtlMinutes: bad }),
        });
        assert.equal(res.status, 422, `ticketTtlMinutes=${bad} 应 422`);
      }

      // 合法值 10 分钟 → 200；verify 新票据按新 TTL 签发
      const update = await fetch(`${base}/api/2fa/ticket-ttl`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-2fa-ticket': ticket },
        body: JSON.stringify({ ticketTtlMinutes: 10 }),
      });
      assert.equal(update.status, 200);
      assert.equal((await json(update)).ticketTtlMinutes, 10);

      const verify = await json(
        await fetch(`${base}/api/2fa/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: confirm.recoveryCodes[0] }),
        })
      );
      assert.equal(verify.ttlSeconds, 600, 'verify 应按新有效期签发票据');
    } finally {
      await cleanup();
    }
  });

  test('disable：需 TOTP/恢复码；关闭后拦截解除；输出摘要开着时拒绝关闭', async () => {
    const { base, cleanup } = ctx;
    try {
      const setup = await json(await fetch(`${base}/api/2fa/setup`, { method: 'POST' }));
      const confirm = await json(
        await fetch(`${base}/api/2fa/confirm`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: totpAt(setup.secret, currentStep()) }),
        })
      );
      const { ticket } = await json(
        await fetch(`${base}/api/2fa/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: confirm.recoveryCodes[2] }),
        })
      );

      // 开启输出摘要 → disable 被拒（422 audit_output_enabled），即使验证码正确
      const enableOut = await fetch(`${base}/api/audit-settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-2fa-ticket': ticket },
        body: JSON.stringify({ recordTerminalOutput: true }),
      });
      assert.equal(enableOut.status, 200);
      const disableBlocked = await fetch(`${base}/api/2fa/disable`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: confirm.recoveryCodes[3] }),
      });
      assert.equal(disableBlocked.status, 422);
      assert.equal((await json(disableBlocked)).error.code, 'audit_output_enabled');

      // 关闭输出摘要 → disable 放行
      const disableOut = await fetch(`${base}/api/audit-settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-2fa-ticket': ticket },
        body: JSON.stringify({ recordTerminalOutput: false }),
      });
      assert.equal(disableOut.status, 200);
      const disableOk = await fetch(`${base}/api/2fa/disable`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: confirm.recoveryCodes[3] }),
      });
      assert.equal(disableOk.status, 200);

      // 关闭后 audit 不再拦截
      assert.equal((await fetch(`${base}/api/audit?limit=1`)).status, 200);
      assert.equal((await json(await fetch(`${base}/api/2fa/status`))).enabled, false);
    } finally {
      await cleanup();
    }
  });

  test('防爆破：连续 5 次失败 → 423 锁定 → 恢复码也拒绝', async () => {
    const { base, cleanup } = ctx;
    try {
      const setup = await json(await fetch(`${base}/api/2fa/setup`, { method: 'POST' }));
      const confirm = await json(
        await fetch(`${base}/api/2fa/confirm`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: totpAt(setup.secret, currentStep()) }),
        })
      );

      // 连续 5 次错误 verify：前 4 次 401，第 5 次触发锁定
      for (let i = 1; i <= 5; i++) {
        const res = await fetch(`${base}/api/2fa/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: '000000' }),
        });
        if (i < 5) assert.equal(res.status, 401, `第 ${i} 次应 401`);
        else assert.equal(res.status, 401, '第 5 次失败仍 401（计数在响应后归零并锁定）');
      }

      // 锁定生效：正确恢复码也 423
      const locked = await fetch(`${base}/api/2fa/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: confirm.recoveryCodes[0] }),
      });
      assert.equal(locked.status, 423);
      assert.equal((await json(locked)).error.code, 'locked');

      // disable/setup 同样被锁
      assert.equal(
        (await fetch(`${base}/api/2fa/disable`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: confirm.recoveryCodes[1] }),
        })).status,
        423
      );
      // 锁定时 status 也拒绝（面板本身受保护；锁定信息经 423 响应传递）
      assert.equal((await fetch(`${base}/api/2fa/status`)).status, 403);
      const lockedStatus = await fetch(`${base}/api/2fa/status`, {
        headers: { 'x-2fa-ticket': 'invalid'.repeat(6) },
      });
      assert.equal(lockedStatus.status, 403);
    } finally {
      await cleanup();
    }
  });
});

describe('恢复入口（仅恢复码，3 次机会）', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await makeApp();
  });

  /** 绑定 2FA 并种入一台主机（用于清除验证），返回 { setup, confirm, hostsFile } */
  async function bindAndSeedHost() {
    const { base, etcDir } = ctx;
    const setup = await json(await fetch(`${base}/api/2fa/setup`, { method: 'POST' }));
    const confirm = await json(
      await fetch(`${base}/api/2fa/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: totpAt(setup.secret, currentStep()) }),
      })
    );
    // 种一台主机：凭据经正常 API 创建（AES-256-GCM 加密落盘）
    const hostRes = await fetch(`${base}/api/hosts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'seed', host: '192.168.1.10', port: 22,
        username: 'root', authType: 'password', password: 'pw123',
      }),
    });
    assert.equal(hostRes.status, 201, '种入主机应成功');
    assert.ok(existsSync(join(etcDir, 'hosts.json')), 'hosts.json 应已生成');
    return { setup, confirm };
  }

  const postRecovery = (code) =>
    fetch(`${ctx.base}/api/2fa/recovery`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });

  test('正确恢复码 → 关闭 2FA；剩余次数恢复为 3；输出摘要开着时恢复自动关闭', async () => {
    const { base, cleanup } = ctx;
    try {
      const { confirm } = await bindAndSeedHost();
      // GET 探测：可用 + 3 次
      const probe = await json(await fetch(`${base}/api/2fa/recovery`));
      assert.equal(probe.available, true);
      assert.equal(probe.attemptsRemaining, 3);

      // 预先开启输出摘要（恢复是紧急通道：不应被输出摘要阻塞，成功后自动关闭）
      const { ticket } = await json(
        await fetch(`${base}/api/2fa/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: confirm.recoveryCodes[2] }),
        })
      );
      const enableOut = await fetch(`${base}/api/audit-settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-2fa-ticket': ticket },
        body: JSON.stringify({ recordTerminalOutput: true }),
      });
      assert.equal(enableOut.status, 200);

      // TOTP 码在恢复入口不算数？——本实现仅恢复码；先错 1 次验证计数
      const bad = await postRecovery('AAAA-AAAA');
      assert.equal(bad.status, 401);
      assert.equal((await json(bad)).attemptsRemaining, 2);

      // 正确恢复码：关闭 2FA + 输出摘要自动关闭 + 新周期计数归零
      const ok = await postRecovery(confirm.recoveryCodes[0]);
      assert.equal(ok.status, 200);
      assert.equal((await json(ok)).message.includes('输出摘要'), true, '响应应告知输出摘要已一并关闭');
      assert.equal((await json(await fetch(`${base}/api/2fa/status`))).enabled, false);
      assert.equal((await json(await fetch(`${base}/api/audit-settings`))).recordTerminalOutput, false);
      const probe2 = await json(await fetch(`${base}/api/2fa/recovery`));
      assert.equal(probe2.attemptsRemaining, 3); // 未绑定时 available=false，但计数已归零

      // 主机不受影响
      const hosts = await json(await fetch(`${base}/api/hosts`));
      assert.equal(hosts.length, 1);
    } finally {
      await cleanup();
    }
  });

  test('3 次失败 → 不可逆清除全部主机连接（含 .bak），响应不泄露后果', async () => {
    const { base, etcDir, cleanup } = ctx;
    try {
      await bindAndSeedHost();
      // 错 1、2 次：401 + 剩余次数递减
      for (const expectLeft of [2, 1]) {
        const res = await postRecovery('ZZZZ-ZZZZ');
        assert.equal(res.status, 401);
        assert.equal((await json(res)).attemptsRemaining, expectLeft);
      }
      // 第 3 次：403 recovery_exhausted；文案绝不提及清除/主机/数据等后果
      const third = await postRecovery('ZZZZ-ZZZZ');
      assert.equal(third.status, 403);
      const thirdBody = await third.text();
      assert.equal(JSON.parse(thirdBody).error.code, 'recovery_exhausted');
      assert.ok(!/清除|主机|数据|删除|wipe|host/i.test(thirdBody), '响应不得泄露清除后果');

      // 不可逆清除：hosts.json/.bak/.tmp 全部不存在，API 列表为空
      for (const suffix of ['', '.bak', '.tmp']) {
        assert.ok(!existsSync(join(etcDir, `hosts.json${suffix}`)), `hosts.json${suffix} 应已被清除`);
      }
      assert.equal((await json(await fetch(`${base}/api/hosts`))).length, 0);

      // 耗尽后：正确恢复码也被拒（403）
      const evenCorrect = await postRecovery('whatever');
      assert.equal(evenCorrect.status, 403);
      assert.equal((await json(evenCorrect)).error.code, 'recovery_exhausted');

      // 2FA 仍开启（清除是惩罚，不是放行）
      const statusRes = await fetch(`${base}/api/2fa/status`);
      assert.equal(statusRes.status, 403); // 仍需票据 → enabled
    } finally {
      await cleanup();
    }
  });
});

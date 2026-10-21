// 2FA验证（TOTP，RFC 6238）前端：
// - 设置「2FA验证」面板：绑定（扫码/手动）→ 恢复码 → 动作开关 → 关闭
// - 验证码弹窗：独立 overlay（不复用 modal 单例——设置弹窗本身占用了它）
// - apiFetch：受保护请求统一封装，自动携带 X-2FA-Ticket，
//   收到 403 twofa_required 时自动弹码验证并重试一次（对调用方透明）
import { apiUrl } from './base.js';
import { icon } from './icons.js';

const TICKET_KEY = 'webssh:2fa-ticket';

let ticketCache = null;
try {
  ticketCache = sessionStorage.getItem(TICKET_KEY) || null;
} catch {
  /* 隐私模式等场景忽略 */
}

function saveTicket(t) {
  ticketCache = t || null;
  try {
    if (t) sessionStorage.setItem(TICKET_KEY, t);
    else sessionStorage.removeItem(TICKET_KEY);
  } catch {
    /* 忽略 */
  }
}

// —— 验证码弹窗（独立 overlay，z-index 200 与审计详情浮层同层） ——
let overlayBusy = false;

/**
 * 弹出验证码输入框并执行验证。
 * @param {{submit: (code: string) => Promise<{ok: boolean, message?: string}>,
 *          title?: string, hint?: string}} opts
 *   submit 校验成功返回 {ok:true}；失败返回 {ok:false, message}（弹窗内提示并允许重输）
 * @returns {Promise<boolean>} 验证是否成功
 */
function codePromptOverlay({ submit, title = '2FA验证', hint = '请输入认证器中的 6 位验证码' }) {
  return new Promise((resolve) => {
    if (overlayBusy) return resolve(false);
    overlayBusy = true;

    const overlay = document.createElement('div');
    overlay.className = 'audit-detail-overlay';
    overlay.innerHTML = `
      <div class="detail-mask"></div>
      <div class="detail-card twofa-card">
        <div class="detail-head">
          <span class="detail-badge">${icon('shield', 14)} ${title}</span>
        </div>
        <p class="twofa-hint">${hint}</p>
        <input class="pref-input twofa-code-input" inputmode="numeric" autocomplete="one-time-code"
               maxlength="6" placeholder="6 位验证码" autofocus />
        <p class="twofa-err" id="twofa-err"></p>
        <div class="form-actions">
          <button class="btn" id="twofa-cancel">取消</button>
          <button class="btn primary" id="twofa-ok">验证</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));

    const input = overlay.querySelector('.twofa-code-input');
    const err = overlay.querySelector('#twofa-err');
    const okBtn = overlay.querySelector('#twofa-ok');
    let settled = false;

    const escHandler = (e) => {
      if (e.key === 'Escape' && document.body.contains(overlay)) done(false);
    };
    const done = (v) => {
      if (settled) return;
      settled = true;
      overlayBusy = false;
      document.removeEventListener('keydown', escHandler);
      overlay.classList.remove('show');
      setTimeout(() => overlay.remove(), 180);
      resolve(v);
    };

    overlay.querySelector('.detail-mask').addEventListener('click', () => done(false));
    overlay.querySelector('#twofa-cancel').addEventListener('click', () => done(false));
    document.addEventListener('keydown', escHandler);

    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 6);
      err.textContent = '';
    });

    const attempt = async () => {
      const code = input.value.trim();
      if (!/^\d{6}$/.test(code)) {
        err.textContent = '请输入 6 位数字验证码';
        return;
      }
      okBtn.disabled = true;
      input.disabled = true;
      try {
        const r = await submit(code);
        if (r.ok) done(true);
        else {
          err.textContent = r.message || '验证失败，请重试';
          input.disabled = false;
          input.value = '';
          input.focus();
        }
      } catch {
        err.textContent = '网络异常，请重试';
        input.disabled = false;
        input.focus();
      } finally {
        okBtn.disabled = false;
      }
    };
    okBtn.addEventListener('click', attempt);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') attempt();
    });
    setTimeout(() => input.focus(), 60);
  });
}

/** 调 POST /api/2fa/verify（普通 fetch，防 apiFetch 递归） */
async function postVerify(code) {
  const res = await fetch(apiUrl('2fa/verify'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const body = await res.json().catch(() => null);
  if (res.ok && body?.ticket) {
    saveTicket(body.ticket);
    return { ok: true };
  }
  return { ok: false, message: body?.error?.message ?? `验证失败（HTTP ${res.status}）` };
}

/** 弹码 → verify → 拿票据。取消或失败返回 false */
export function promptTwofaVerify() {
  return codePromptOverlay({ submit: postVerify });
}

/** 当前 2FA 票据（未验证为 null）：供 WS 连接等非 REST 通道携带 */
export function getTwofaTicket() {
  return ticketCache;
}

/**
 * 受保护请求封装：自动携带 X-2FA-Ticket；403 twofa_required 时弹码验证并重试一次。
 * 参数与 fetch 相同（path 为相对 api 路径，不含 /api/ 前缀）。
 * @param {object} [opts.forcePrompt] 403 时是否无视「自动弹验证」偏好强制弹码——
 *   用户主动操作（创建令牌/改开关/导出等）传 true；面板加载类请求不传，
 *   偏好关闭时直接返回 403 由调用方渲染验证引导页（renderTwofaGate）。
 */
export async function apiFetch(path, opts = {}) {
  const { forcePrompt = false, ...fetchOpts } = opts;
  const headers = { ...(fetchOpts.headers ?? {}) };
  if (ticketCache) headers['x-2fa-ticket'] = ticketCache;
  let res = await fetch(apiUrl(path), { ...fetchOpts, headers });
  if (res.status === 403) {
    const body = await res.clone().json().catch(() => null);
    if (body?.error?.code === 'twofa_required' && (forcePrompt || getAutoPrompt())) {
      const ok = await promptTwofaVerify();
      if (ok) {
        headers['x-2fa-ticket'] = ticketCache;
        res = await fetch(apiUrl(path), { ...fetchOpts, headers });
      } else {
        // 用户取消验证：属正常放弃而非失败，打标记由调用方静默回滚（不弹“保存失败”）
        res._twofaCancelled = true;
      }
    }
  }
  return res;
}

// —— 进入面板自动弹验证偏好（localStorage，仅本浏览器） ——
// true（默认）：打开2FA验证页即弹验证码框；
// false：先进引导页（进入2FA验证 + 恢复入口），手动点「进入2FA验证」才弹码。
const AUTO_PROMPT_KEY = 'webssh:2fa-auto-prompt';

function getAutoPrompt() {
  try {
    return localStorage.getItem(AUTO_PROMPT_KEY) !== 'false';
  } catch {
    return true;
  }
}

function setAutoPrompt(v) {
  try {
    if (v) localStorage.removeItem(AUTO_PROMPT_KEY); // 默认值不留键
    else localStorage.setItem(AUTO_PROMPT_KEY, 'false');
  } catch {
    /* 忽略 */
  }
}

// —— 设置「2FA验证」面板 ——

function qrSvg(uri) {
  // vendor/qrcodegen.js（kazuhikoarase，MIT）：typeNumber 0 = 自动适配版本
  if (window.qrcode.stringToBytesFuncs?.['UTF-8']) {
    window.qrcode.stringToBytes = window.qrcode.stringToBytesFuncs['UTF-8'];
  }
  const qr = window.qrcode(0, 'M');
  qr.addData(uri);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2 });
}

/**
 * 未验证引导页（2FA验证/审计/命令审计页共用）：
 * 进入2FA验证入口 + 恢复入口 + 「进入面板自动弹出验证」开关。
 * @param {HTMLElement} el 容器
 * @param {{onDone?: ()=>void}} [opts] 验证/恢复成功后的回调（默认重载2FA验证面板）
 */
export function renderTwofaGate(el, { onDone } = {}) {
  // 未验证引导页：只含验证与恢复入口——「进入面板自动弹出验证」开关属于面板设置，
  // 需验证通过后（已绑定面板的「管理」区）才可见可改。
  el.innerHTML = `
    <div class="pref-section">
      <div class="pref-title">2FA验证</div>
      <div class="twofa-intro">
        <div class="twofa-intro-icon">${icon('shield', 30)}</div>
        <p class="twofa-intro-title">面板已受2FA验证保护</p>
        <button class="btn primary" id="twofa-retry">${icon('shield')} 进入2FA验证</button>
        <button class="btn" id="twofa-recover">恢复</button>
      </div>
    </div>`;
  const finish = onDone ?? (() => renderTwofaPane(el));
  // 「进入2FA验证」直接弹码（无视偏好——点按钮即表示愿意输码），成功后回调重载
  el.querySelector('#twofa-retry').addEventListener('click', async () => {
    const ok = await promptTwofaVerify();
    if (ok) finish();
  });
  el.querySelector('#twofa-recover').addEventListener('click', () => openRecovery(el, { onDone: finish }));
}

export async function renderTwofaPane(el) {
  el.innerHTML = '<div class="placeholder-box">加载中…</div>';
  let status = null;
  try {
    // 已绑定时 status 受 2FA 保护（面板本身是高危入口）。
    // apiFetch 遵循偏好：开启（默认）→ 403 自动弹码，进来即认证；
    // 关闭 → 返回 403，由下方渲染引导页（点「进入2FA验证」才弹码）。
    const res = await apiFetch('2fa/status');
    if (res.ok) status = await res.json();
    else if (res.status === 403) {
      renderTwofaGate(el);
      return;
    }
  } catch {
    /* 网络异常 */
  }
  if (!status) {
    el.innerHTML = '<div class="placeholder-box">2FA验证状态加载失败，请重试</div>';
    return;
  }
  if (status.enabled) renderBound(el, status);
  else renderIntro(el);
}

// 未绑定：引导页
function renderIntro(el) {
  el.innerHTML = `
    <div class="pref-section">
      <div class="pref-title">2FA验证</div>
      <div class="twofa-intro">
        <div class="twofa-intro-icon">${icon('shield', 30)}</div>
        <p class="twofa-intro-title">为高危险操作增加一层动态验证</p>
        <p class="twofa-intro-desc">
          绑定后，使用 <b>Google Authenticator</b>、<b>腾讯令牌</b> 等任意 TOTP 认证器扫码，
          在执行受保护操作时输入 6 位动态验证码。
        </p>
        <div class="twofa-scope">
          <div class="twofa-scope-item">${icon('list', 15)}<span>命令审计（查看与设置）</span></div>
          <div class="twofa-scope-item">${icon('key', 15)}<span>MCP 令牌（创建 / 撤销 / 删除）</span></div>
          <div class="twofa-scope-item">${icon('plug', 15)}<span>仅 MCP 会话连接（创建 / 编辑）</span></div>
        </div>
        <button class="btn primary" id="twofa-start">${icon('shield')} 启用2FA验证</button>
      </div>
    </div>`;
  el.querySelector('#twofa-start').addEventListener('click', () => startSetup(el));
}

// 绑定中：二维码 + 手动 secret + 输码确认
async function startSetup(el) {
  el.innerHTML = '<div class="placeholder-box">正在生成密钥…</div>';
  let data = null;
  try {
    const res = await fetch(apiUrl('2fa/setup'), { method: 'POST' });
    data = await res.json().catch(() => null);
    if (!res.ok) {
      el.innerHTML = `<div class="placeholder-box">${data?.error?.message ?? '生成失败，请重试'}</div>
        <div style="text-align:center"><button class="btn" id="twofa-back">返回</button></div>`;
      el.querySelector('#twofa-back').addEventListener('click', () => renderTwofaPane(el));
      return;
    }
  } catch {
    el.innerHTML = '<div class="placeholder-box">网络异常，请重试</div>';
    return;
  }

  el.innerHTML = `
    <div class="pref-section">
      <div class="pref-title">绑定认证器</div>
      <div class="twofa-bind">
        <div class="twofa-qr">${qrSvg(data.uri)}</div>
        <div class="twofa-bind-side">
          <p class="twofa-step">1. 打开认证器 App（Google Authenticator / 腾讯令牌等）</p>
          <p class="twofa-step">2. 扫描左侧二维码，或手动输入密钥：</p>
          <code class="twofa-secret" id="twofa-secret">${data.secret}</code>
          <button class="btn twofa-copy" id="twofa-copy">${icon('key')} 复制密钥</button>
          <p class="twofa-step">3. 输入认证器显示的 6 位验证码完成绑定：</p>
          <input class="pref-input twofa-code-input" id="twofa-confirm-code"
                 inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 位验证码" />
          <p class="twofa-err" id="twofa-bind-err"></p>
          <div class="form-actions">
            <button class="btn" id="twofa-cancel-setup">取消</button>
            <button class="btn primary" id="twofa-confirm">确认绑定</button>
          </div>
        </div>
      </div>
    </div>`;

  const codeInput = el.querySelector('#twofa-confirm-code');
  const err = el.querySelector('#twofa-bind-err');
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
    err.textContent = '';
  });
  el.querySelector('#twofa-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(data.secret);
      const btn = el.querySelector('#twofa-copy');
      btn.textContent = '已复制';
      setTimeout(() => (btn.innerHTML = `${icon('key')} 复制密钥`), 1500);
    } catch {
      err.textContent = '复制失败，请手动选择复制';
    }
  });
  el.querySelector('#twofa-cancel-setup').addEventListener('click', () => renderTwofaPane(el));

  const confirmBtn = el.querySelector('#twofa-confirm');
  const doConfirm = async () => {
    const code = codeInput.value.trim();
    if (!/^\d{6}$/.test(code)) {
      err.textContent = '请输入 6 位数字验证码';
      return;
    }
    confirmBtn.disabled = true;
    try {
      const res = await fetch(apiUrl('2fa/confirm'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok) {
        // confirm 已同步签发票据：面板后续操作（改开关/查状态）免重弹
        if (body?.ticket) saveTicket(body.ticket);
        renderRecoveryCodes(el, body.recoveryCodes ?? []);
      } else {
        err.textContent = body?.error?.message ?? '绑定失败，请重试';
        codeInput.value = '';
        codeInput.focus();
      }
    } catch {
      err.textContent = '网络异常，请重试';
    } finally {
      confirmBtn.disabled = false;
    }
  };
  confirmBtn.addEventListener('click', doConfirm);
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doConfirm();
  });
  codeInput.focus();
}

// 绑定成功：一次性展示恢复码
function renderRecoveryCodes(el, codes) {
  el.innerHTML = `
    <div class="pref-section">
      <div class="pref-title">绑定成功</div>
      <div class="twofa-recovery">
        <p class="twofa-intro-desc">
          2FA验证已启用。请将以下 <b>恢复码</b> 保存到安全位置——
          认证器丢失时，可用任一恢复码完成验证或关闭2FA验证。
          每个恢复码只能使用一次，<b>此页关闭后不再展示</b>。
        </p>
        <div class="twofa-code-grid">
          ${codes.map((c) => `<code>${c}</code>`).join('')}
        </div>
        <div class="form-actions">
          <button class="btn" id="twofa-copy-codes">复制全部</button>
          <button class="btn primary" id="twofa-done">我已保存，完成</button>
        </div>
      </div>
    </div>`;
  el.querySelector('#twofa-copy-codes').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      const btn = el.querySelector('#twofa-copy-codes');
      btn.textContent = '已复制';
      setTimeout(() => (btn.textContent = '复制全部'), 1500);
    } catch {
      /* 忽略 */
    }
  });
  el.querySelector('#twofa-done').addEventListener('click', () => renderTwofaPane(el));
}

// 已绑定：状态 + 动作开关 + 关闭入口
function renderBound(el, status) {
  const locked = status.locked;
  el.innerHTML = `
    <div class="pref-section">
      <div class="pref-title">2FA验证</div>
      <div class="pref-row">
        <div class="pref-label">状态
          <div class="pref-desc">
            ${locked
              ? '<span class="twofa-locked">已锁定：连续验证失败次数过多，请稍后重试</span>'
              : `已启用 · 验证一次后 ${status.ticketTtlMinutes} 分钟内免重复输入`}
          </div>
        </div>
        <span class="tag ${locked ? 'danger' : 'ok'}">${locked ? '已锁定' : '已启用'}</span>
      </div>
      <div class="pref-row">
        <div class="pref-label">剩余恢复码<div class="pref-desc">每个恢复码只能使用一次，用于认证器丢失时验证</div></div>
        <span class="tag">${status.remainingRecoveryCodes} 个</span>
      </div>
    </div>
    <div class="pref-section">
      <div class="pref-title">高危险操作保护</div>
      <div class="pref-row">
        <div class="pref-label">命令审计<div class="pref-desc">查看审计记录（命令历史/输出摘要/导出）与修改审计设置</div></div>
        <label class="switch"><input type="checkbox" id="twofa-act-audit"
          ${status.protectedActions.audit ? 'checked' : ''} ${locked ? 'disabled' : ''} /><span></span></label>
      </div>
      <div class="pref-row">
        <div class="pref-label">MCP 令牌<div class="pref-desc">创建、撤销与永久删除 MCP 令牌</div></div>
        <label class="switch"><input type="checkbox" id="twofa-act-tokens"
          ${status.protectedActions.tokens ? 'checked' : ''} ${locked ? 'disabled' : ''} /><span></span></label>
      </div>
      <div class="pref-row">
        <div class="pref-label">仅 MCP 会话连接<div class="pref-desc">范围为「仅 MCP」的会话连接：创建与编辑（网页终端对其关闭，编辑是唯一变更入口）</div></div>
        <label class="switch"><input type="checkbox" id="twofa-act-hosts"
          ${status.protectedActions.hosts !== false ? 'checked' : ''} ${locked ? 'disabled' : ''} /><span></span></label>
      </div>
    </div>
    <div class="pref-section">
      <div class="pref-title">管理</div>
      <div class="pref-row">
        <div class="pref-label">记录终端输出摘要<div class="pref-desc">默认关闭：命令审计只记命令原文与元数据。开启后每条命令附带其输出摘要（自动脱敏并截断，命令审计页「查看」可见）；依赖2FA验证保护，关闭2FA验证前需先关闭本开关</div></div>
        <label class="switch"><input type="checkbox" id="twofa-audit-output" ${locked ? 'disabled' : ''} /><span></span></label>
      </div>
      <div class="pref-row">
        <div class="pref-label">验证有效期<div class="pref-desc">验证通过后该时长内受保护操作免重复输码，过期后需重新输码。由服务端统一执行与计时，对所有终端生效</div></div>
        <select class="pref-select" id="twofa-ticket-ttl" ${locked ? 'disabled' : ''}>
          ${[1, 5, 10, 15, 30, 60].map((m) => `<option value="${m}"${m === status.ticketTtlMinutes ? ' selected' : ''}>${m} 分钟</option>`).join('')}
        </select>
      </div>
      <div class="pref-row">
        <div class="pref-label">进入面板自动弹出验证<div class="pref-desc">开启后打开2FA验证/审计等受保护页面即要求输码；关闭则先显示引导页，点「进入2FA验证」时才输码（仅本浏览器）</div></div>
        <label class="switch"><input type="checkbox" id="twofa-auto-prompt-bound" ${getAutoPrompt() ? 'checked' : ''} /><span></span></label>
      </div>
      <div class="pref-row">
        <div class="pref-label">清除本机验证缓存<div class="pref-desc">立即失效本页面的验证状态；之后访问本面板与受保护操作都需重新输入验证码</div></div>
        <button class="btn" id="twofa-clear-cache">清除</button>
      </div>
      <div class="pref-row">
        <div class="pref-label">关闭2FA验证<div class="pref-desc">关闭后受保护操作不再要求动态验证码；需先关闭「记录终端输出摘要」</div></div>
        <button class="btn danger-text" id="twofa-disable" ${locked ? 'disabled' : ''}>关闭</button>
      </div>
    </div>`;

  // 输出摘要开关（从通用设置迁入）：本面板已验证即 2FA 已绑定，后端校验天然满足；
  // 修改属受保护操作，forcePrompt 直接弹码
  const auditOutputEl = el.querySelector('#twofa-audit-output');
  auditOutputEl.disabled = true;
  fetch(apiUrl('audit-settings'))
    .then((r) => r.json())
    .then((s) => {
      auditOutputEl.checked = s.recordTerminalOutput === true;
      auditOutputEl.disabled = locked;
    })
    .catch(() => {
      auditOutputEl.disabled = locked;
    });
  auditOutputEl.addEventListener('change', async (e) => {
    const on = e.target.checked;
    auditOutputEl.disabled = true;
    try {
      const r = await apiFetch('audit-settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recordTerminalOutput: on }),
        forcePrompt: true,
      });
      if (r._twofaCancelled) {
        auditOutputEl.checked = !on; // 用户取消验证：静默回滚
        return;
      }
      if (!r.ok) {
        const err = await r.json().catch(() => null);
        throw new Error(err?.error?.message ?? `保存失败（HTTP ${r.status}）`);
      }
    } catch (err) {
      alert(`输出摘要设置保存失败：${err.message}`);
      auditOutputEl.checked = !on; // 回滚 UI
    } finally {
      auditOutputEl.disabled = locked;
    }
  });

  el.querySelector('#twofa-auto-prompt-bound').addEventListener('change', (e) => {
    setAutoPrompt(e.target.checked);
  });

  // 验证有效期：修改安全参数是用户主动操作，forcePrompt 无视偏好直接弹码。
  // TTL 存于服务端内存票据表，浏览器无法延长；已签发票据按原过期时间自然失效。
  const ttlEl = el.querySelector('#twofa-ticket-ttl');
  ttlEl.addEventListener('change', async (e) => {
    const minutes = Number(e.target.value);
    ttlEl.disabled = true;
    try {
      const res = await apiFetch('2fa/ticket-ttl', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticketTtlMinutes: minutes }),
        forcePrompt: true,
      });
      if (res._twofaCancelled) {
        ttlEl.value = String(status.ticketTtlMinutes); // 用户取消验证：静默回滚
        return;
      }
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? `保存失败（HTTP ${res.status}）`);
      status.ticketTtlMinutes = minutes;
    } catch (err) {
      alert(`验证有效期保存失败：${err.message}`);
      ttlEl.value = String(status.ticketTtlMinutes);
    } finally {
      ttlEl.disabled = locked;
    }
  });

  // 清除本机验证缓存：丢弃 sessionStorage 中的 2FA 票据（免输凭证），
  // 仅影响本浏览器，服务端与其他终端不受影响。清除后当前面板保留，
  // 但下一次进入面板或任何受保护操作都会重新要求输码。
  el.querySelector('#twofa-clear-cache').addEventListener('click', () => {
    saveTicket(null);
    const btn = el.querySelector('#twofa-clear-cache');
    btn.disabled = true;
    btn.textContent = '已清除';
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = '清除';
    }, 1500);
  });

  el.querySelectorAll('#twofa-act-audit, #twofa-act-tokens, #twofa-act-hosts').forEach((cb) => {
    cb.addEventListener('change', async (e) => {
      const key =
        cb.id === 'twofa-act-audit' ? 'audit' : cb.id === 'twofa-act-tokens' ? 'tokens' : 'hosts';
      const on = e.target.checked;
      cb.disabled = true;
      try {
        // 修改保护范围是用户主动操作：forcePrompt 无视偏好直接弹码
        const res = await apiFetch('2fa/actions', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ [key]: on }),
          forcePrompt: true,
        });
        if (res._twofaCancelled) {
          cb.checked = !on; // 用户取消验证：静默回滚
          return;
        }
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error?.message ?? `保存失败（HTTP ${res.status}）`);
      } catch (err) {
        alert(`保护范围保存失败：${err.message}`);
        cb.checked = !on;
      } finally {
        cb.disabled = locked;
      }
    });
  });

  el.querySelector('#twofa-disable').addEventListener('click', async () => {
    // 预检：输出摘要开着时禁止关闭（后端同样强制），直接提示免走弹码
    if (auditOutputEl.checked) {
      alert('请先关闭「记录终端输出摘要」，再关闭2FA验证。');
      return;
    }
    // 原生 confirm（与令牌页一致）：confirmModal 复用全局 modal 单例，会顶掉设置弹窗
    if (!confirm('确定关闭2FA验证？关闭后受保护操作将不再要求动态验证码。')) return;
    // 关闭必须验证（防降级）：弹码并提交到 disable 接口
    const verified = await codePromptOverlay({
      title: '关闭2FA验证',
      hint: '关闭前请输入认证器 6 位验证码或恢复码确认本人操作',
      submit: async (code) => {
        const res = await fetch(apiUrl('2fa/disable'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        if (res.ok) {
          saveTicket(null);
          return { ok: true };
        }
        const body = await res.json().catch(() => null);
        return { ok: false, message: body?.error?.message ?? `验证失败（HTTP ${res.status}）` };
      },
    });
    if (verified) renderTwofaPane(el);
  });
}

// —— 恢复入口（认证器丢失）：仅恢复码，累计 3 次机会 ——
// UI 文案约定：只告知「有 3 次机会，错误无法恢复」，不提示错误后果。
// onDone：恢复成功后的回调（默认重载2FA验证面板；审计页等外部入口传入自己的重载）
async function openRecovery(el, { onDone } = {}) {
  // 探测剩余次数（耗尽则直接显示无法恢复）
  let remaining = 3;
  let available = true;
  try {
    const res = await fetch(apiUrl('2fa/recovery'));
    if (res.ok) {
      const s = await res.json();
      remaining = s.attemptsRemaining ?? 3;
      available = s.available !== false;
    }
  } catch {
    /* 网络异常按默认处理 */
  }

  const overlay = document.createElement('div');
  overlay.className = 'audit-detail-overlay';
  const warning = available
    ? `请输入任一未使用的恢复码（xxxx-xxxx 格式）。恢复成功后将关闭2FA验证。<br><b>仅有 3 次机会，错误无法恢复。</b>${remaining < 3 ? `（剩余 ${remaining} 次）` : ''}`
    : '错误次数已达上限，<b>已无法恢复</b>。';
  overlay.innerHTML = `
    <div class="detail-mask"></div>
    <div class="detail-card twofa-card">
      <div class="detail-head">
        <span class="detail-badge">${icon('shield', 14)} 恢复访问</span>
      </div>
      <p class="twofa-hint">${warning}</p>
      ${available ? `
        <input class="pref-input twofa-recovery-input" placeholder="恢复码（xxxx-xxxx）"
               autocomplete="off" spellcheck="false" autofocus />
        <p class="twofa-err" id="recovery-err"></p>
        <div class="form-actions">
          <button class="btn" id="recovery-cancel">取消</button>
          <button class="btn primary" id="recovery-ok">恢复</button>
        </div>` : `
        <div class="form-actions">
          <button class="btn primary" id="recovery-close">关闭</button>
        </div>`}
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));

  const escHandler = (e) => {
    if (e.key === 'Escape' && document.body.contains(overlay)) done();
  };
  const done = () => {
    document.removeEventListener('keydown', escHandler);
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 180);
  };
  document.addEventListener('keydown', escHandler);
  overlay.querySelector('.detail-mask').addEventListener('click', done);
  overlay.querySelector(available ? '#recovery-cancel' : '#recovery-close')
    .addEventListener('click', done);
  if (!available) return;

  const input = overlay.querySelector('.twofa-recovery-input');
  const err = overlay.querySelector('#recovery-err');
  const okBtn = overlay.querySelector('#recovery-ok');
  let left = remaining;

  input.addEventListener('input', () => {
    // 只保留合法字符并自动大写：字母数字 + 单个连字符
    input.value = input.value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
    err.textContent = '';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') okBtn.click();
  });

  okBtn.addEventListener('click', async () => {
    const code = input.value.trim();
    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
      err.textContent = '请输入恢复码（xxxx-xxxx 格式）';
      return;
    }
    okBtn.disabled = true;
    input.disabled = true;
    try {
      const res = await fetch(apiUrl('2fa/recovery'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok) {
        saveTicket(null);
        done();
        alert('恢复成功，2FA验证已关闭，请重新绑定。');
        (onDone ?? (() => renderTwofaPane(el)))();
        return;
      }
      // 失败：剩余次数递减；耗尽（403）后显示无法恢复
      if (body?.attemptsRemaining != null) left = body.attemptsRemaining;
      if (res.status === 403 || body?.error?.code === 'recovery_exhausted') {
        err.textContent = '错误次数已达上限，已无法恢复。';
        okBtn.textContent = '关闭';
        okBtn.disabled = false;
        okBtn.onclick = done;
        return;
      }
      err.textContent = `${body?.error?.message ?? '恢复码错误'}${left > 0 ? `（剩余 ${left} 次机会）` : ''}`;
      input.disabled = false;
      input.value = '';
      input.focus();
    } catch {
      err.textContent = '网络异常，请重试';
      input.disabled = false;
      input.focus();
    } finally {
      okBtn.disabled = false;
    }
  });
  setTimeout(() => input.focus(), 60);
}

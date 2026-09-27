// 令牌管理页（US6 / FR-022~026）：渲染在「设置 → 令牌」页签
// 明文仅创建时展示一次（FR-023）
import { apiUrl } from './base.js';

const LEVEL_LABEL = { readonly: '只读', writable: '可变更' };
const STATUS_LABEL = { active: '启用', revoked: '已撤销', expired: '已过期' };

export async function renderTokens(el) {
  el.innerHTML = `
    <div class="audit-toolbar">
      <button class="btn primary" id="token-create">＋ 创建令牌</button>
      <button class="btn" id="token-refresh">刷新</button>
    </div>
    <div id="token-onetime"></div>
    <div id="token-list" class="audit-list"><div class="placeholder-box">加载中…</div></div>`;
  el.querySelector('#token-create').addEventListener('click', () => openTokenForm(el));
  el.querySelector('#token-refresh').addEventListener('click', () => loadTokens(el));
  await loadTokens(el);
}

async function loadTokens(el) {
  const list = el.querySelector('#token-list');
  let tokens = [];
  try {
    const res = await fetch(apiUrl('tokens'));
    if (res.ok) tokens = await res.json();
  } catch {
    /* 网络异常 */
  }
  if (!tokens.length) {
    list.innerHTML = '<div class="placeholder-box">暂无令牌。创建后可将 WebSSH 接入支持 MCP 的 AI 工具。</div>';
    return;
  }
  list.innerHTML = tokens
    .map(
      (t) => `<div class="audit-row">
        <span class="audit-event">${escapeHtml(t.name)}</span>
        <span class="tag ${t.level === 'writable' ? 'warn' : 'ok'}">${LEVEL_LABEL[t.level] ?? t.level}</span>
        <span class="tag ${t.status === 'active' ? 'ok' : ''}">${STATUS_LABEL[t.status] ?? t.status}</span>
        <span class="audit-detail">范围 ${t.hostScope.length} 台 · 提示 …${escapeHtml(t.tokenHint ?? '')} · 创建于 ${formatTime(t.createdAt)}</span>
        ${t.status === 'active' ? `<button class="btn danger-text token-revoke" data-id="${escapeHtml(t.id)}" data-name="${escapeHtml(t.name)}">撤销</button>` : ''}
      </div>`
    )
    .join('');
  list.querySelectorAll('.token-revoke').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm(`确定撤销令牌「${b.dataset.name}」？撤销立即生效且不可恢复。`)) return;
      await fetch(apiUrl(`tokens/${b.dataset.id}`), { method: 'DELETE' });
      loadTokens(el);
    })
  );
}

async function openTokenForm(el) {
  // 主机清单（勾选授权范围）
  let hosts = [];
  try {
    const res = await fetch(apiUrl('hosts'));
    if (res.ok) hosts = await res.json();
  } catch {
    /* 忽略 */
  }
  if (!hosts.length) {
    alert('请先在左侧创建会话连接，再创建令牌。');
    return;
  }
  // 在设置页签内内联渲染表单（复用全局 modal 会顶掉设置弹窗）
  el.innerHTML = `
    <form id="token-form" class="host-form">
      <label>名称 <input name="name" required maxlength="64" placeholder="例如：AI 助手巡检" /></label>
      <label>操作级别
        <div class="seg">
          <button type="button" class="seg-btn selected" data-value="readonly">只读（默认最小权限）</button>
          <button type="button" class="seg-btn" data-value="writable">可变更（含执行命令）</button>
        </div>
        <input type="hidden" name="level" value="readonly" />
      </label>
      <label>授权主机（至少一台）
        <div class="picker-list" style="margin-top:6px">
          ${hosts
            .map(
              (h) => `<label style="display:flex;align-items:center;gap:8px;margin:0;padding:8px 10px;border:1px solid var(--border);border-radius:6px">
                <input type="checkbox" name="host" value="${escapeHtml(h.id)}" style="width:auto;margin:0" />
                <span>${escapeHtml(h.name)} <span style="color:var(--text-dim);font-size:11px">${escapeHtml(h.username)}@${escapeHtml(h.host)}</span></span>
              </label>`
            )
            .join('')}
        </div>
      </label>
      <label>有效期（可选，留空不自动过期） <input name="expiresAt" type="datetime-local" /></label>
      <p class="form-note">令牌明文仅创建后展示一次；目录权限继承全局默认矩阵（只能收紧）。系统敏感路径恒定拒绝。</p>
      <div class="form-actions">
        <button type="submit" class="btn primary">创建</button>
        <button type="button" class="btn" id="token-cancel">取消</button>
      </div>
    </form>`;

  const form = el.querySelector('#token-form');
  const levelInput = form.querySelector('[name=level]');
  form.querySelectorAll('.seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      levelInput.value = b.dataset.value;
      form.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('selected', x === b));
    })
  );
  form.querySelector('#token-cancel').addEventListener('click', () => renderTokens(el));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const hostScope = fd.getAll('host');
    if (!hostScope.length) return alert('请至少勾选一台授权主机');
    const body = { name: fd.get('name').trim(), level: levelInput.value, hostScope };
    if (fd.get('expiresAt')) body.expiresAt = new Date(fd.get('expiresAt')).toISOString();
    const res = await fetch(apiUrl('tokens'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return alert(`创建失败：${err.error?.message ?? res.statusText}`);
    }
    const created = await res.json();
    // 明文仅此一次展示（FR-023）：恢复列表 + 顶部一次性明文块
    el.innerHTML = `
      <div class="audit-toolbar">
        <button class="btn primary" id="token-create">＋ 创建令牌</button>
        <button class="btn" id="token-refresh">刷新</button>
      </div>
      <div id="token-onetime"></div>
      <div id="token-list" class="audit-list"></div>`;
    el.querySelector('#token-create').addEventListener('click', () => openTokenForm(el));
    el.querySelector('#token-refresh').addEventListener('click', () => loadTokens(el));
    const onetime = el.querySelector('#token-onetime');
    onetime.innerHTML = `
      <div class="onetime-token">
        <div>✅ 令牌「${escapeHtml(created.name)}」已创建。<b>明文仅此一次展示，请立即复制保存：</b></div>
        <div class="onetime-value">${escapeHtml(created.token)}</div>
        <button class="btn" id="token-copy">复制</button>
      </div>`;
    onetime.querySelector('#token-copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(created.token);
        onetime.querySelector('#token-copy').textContent = '已复制';
      } catch {
        const r = document.createRange();
        r.selectNode(onetime.querySelector('.onetime-value'));
        getSelection().removeAllRanges();
        getSelection().addRange(r);
      }
    });
    loadTokens(el);
  });
}

function formatTime(ts) {
  return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '-';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

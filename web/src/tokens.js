// 令牌管理页（US6 / FR-022~026）：渲染在「设置 → 令牌」页签
// 明文仅创建时展示一次（FR-023）
// 快速提示词：按表单参数 + MCP 接入地址生成 AI 客户端提示词（不创建令牌）
import { apiUrl } from './base.js';
import { icon } from './icons.js';

const LEVEL_LABEL = { readonly: '只读', writable: '可变更' };
const STATUS_LABEL = { active: '启用', revoked: '已撤销', expired: '已过期' };

/** 解析当前 MCP 接入地址：自定义地址（反代）> 直连端口 > 页面 origin（与令牌配置页一致） */
async function resolveMcpEndpoint() {
  let direct = null;
  try {
    const res = await fetch(apiUrl('mcp-direct'));
    if (res.ok) direct = await res.json();
  } catch {
    /* 网络异常走 origin */
  }
  if (direct?.customEndpoint) return direct.customEndpoint;
  if (direct?.enabled) {
    const ip = direct.mode === 'fnos' ? 'NAS IP' : '主机 IP';
    return `http://<${ip}>:${direct.port ?? 8422}/mcp`;
  }
  return `${location.origin}/mcp`;
}

/** 生成 AI 客户端接入提示词：含接入地址、可用工具（按级别）、授权范围与安全约束 */
function buildPrompt({ name, level, hosts, endpoint }) {
  const writable = level === 'writable';
  const hostList = hosts.map((h) => `- ${h.name}（${h.username}@${h.host}:${h.port}）`).join('\n');
  const tools = writable
    ? [
        '- list_hosts：列出授权主机',
        '- read_file：读取授权主机上矩阵允许路径的文件内容',
        '- run_command：在授权主机上执行一条命令（拼接/重定向语法与危险命令将被拒绝）',
      ].join('\n')
    : ['- list_hosts：列出授权主机', '- read_file：读取授权主机上矩阵允许路径的文件内容'].join('\n');
  return `你已接入 WebSSH 终端服务的 MCP 服务器，可通过以下工具管理远程主机。

## 接入信息
- MCP 端点：${endpoint}
- 认证方式：Authorization: Bearer <令牌明文>
- 令牌名称：${name}（明文需在 WebSSH「设置 → 令牌管理」创建后一次性获取）

## 授权主机（仅限以下范围）
${hostList}

## 可用工具
${tools}

## 使用约束
- 所有操作将被审计留痕（命令原文 + 输出摘要）
- 系统敏感路径（如 /etc/shadow、.ssh 目录）恒定拒绝
- 文件访问受目录权限矩阵限制，只能访问授权路径
${writable ? '- 命令中的拼接、重定向语法与危险命令（rm/dd/shutdown 等）会被拒绝\n' : ''}请优先使用工具完成任务，不要假设未列出的主机可访问。`;
}

export async function renderTokens(el) {
  el.innerHTML = `
    <div class="audit-toolbar">
      <button class="btn primary" id="token-create">${icon('plus')} 创建令牌</button>
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
        ${
          t.status === 'active'
            ? `<button class="icon-btn danger-text token-revoke" data-id="${escapeHtml(t.id)}" data-name="${escapeHtml(t.name)}" title="撤销令牌「${escapeHtml(t.name)}」（立即生效，记录保留）">${icon('ban', 13)}</button>`
            : `<button class="icon-btn danger-text token-purge" data-id="${escapeHtml(t.id)}" data-name="${escapeHtml(t.name)}" title="永久删除令牌记录「${escapeHtml(t.name)}」（不可恢复）">${icon('trash', 13)}</button>`
        }
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
  list.querySelectorAll('.token-purge').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm(`永久删除令牌「${b.dataset.name}」的记录？\n删除后列表不再显示该令牌（撤销状态已使其无法使用），此操作不可恢复。`)) return;
      const res = await fetch(apiUrl(`tokens/${b.dataset.id}/purge`), { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`删除失败：${err.error?.message ?? res.statusText}`);
      }
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
        <button type="button" class="btn" id="token-gen-prompt">生成提示词</button>
        <button type="button" class="btn" id="token-cancel">取消</button>
      </div>
      <div id="token-prompt-out"></div>
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

  // 快速提示词：按当前表单参数生成（不创建令牌），含 MCP 接入地址，可复制
  form.querySelector('#token-gen-prompt').addEventListener('click', async () => {
    const fd = new FormData(form);
    const name = String(fd.get('name') ?? '').trim() || 'AI 助手';
    const hostScope = fd.getAll('host');
    if (!hostScope.length) return alert('请先勾选至少一台授权主机，提示词会列出主机范围');
    const selected = hosts.filter((h) => hostScope.includes(h.id));
    const endpoint = await resolveMcpEndpoint();
    const prompt = buildPrompt({ name, level: levelInput.value, hosts: selected, endpoint });
    const out = el.querySelector('#token-prompt-out');
    out.innerHTML = `
      <div class="prompt-gen">
        <div class="prompt-gen-head">
          <span class="pref-desc" style="flex:1">已按当前表单参数生成提示词（未创建令牌）。粘贴给 AI 客户端前，请先在 WebSSH 创建同名令牌并把明文填入 Bearer 处。</span>
          <button class="btn" id="prompt-copy">复制提示词</button>
        </div>
        <pre class="mcp-conf">${escapeHtml(prompt)}</pre>
      </div>`;
    out.querySelector('#prompt-copy').addEventListener('click', () => {
      navigator.clipboard?.writeText(prompt).then(() => {
        const b = out.querySelector('#prompt-copy');
        b.textContent = '已复制';
        setTimeout(() => (b.textContent = '复制提示词'), 1200);
      });
    });
    out.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
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
    // 明文仅此一次展示（FR-023）：恢复列表 + 顶部一次性明文块 + 同参数提示词快捷复制
    const promptEndpoint = await resolveMcpEndpoint();
    const promptText = buildPrompt({
      name: body.name,
      level: body.level,
      hosts: hosts.filter((h) => body.hostScope.includes(h.id)),
      endpoint: promptEndpoint,
    });
    el.innerHTML = `
      <div class="audit-toolbar">
        <button class="btn primary" id="token-create">${icon('plus')} 创建令牌</button>
        <button class="btn" id="token-refresh">刷新</button>
      </div>
      <div id="token-onetime"></div>
      <div id="token-list" class="audit-list"></div>`;
    el.querySelector('#token-create').addEventListener('click', () => openTokenForm(el));
    el.querySelector('#token-refresh').addEventListener('click', () => loadTokens(el));
    const onetime = el.querySelector('#token-onetime');
    onetime.innerHTML = `
      <div class="onetime-token">
        <div>令牌「${escapeHtml(created.name)}」已创建。<b>明文仅此一次展示，请立即复制保存：</b></div>
        <div class="onetime-value">${escapeHtml(created.token)}</div>
        <div style="display:flex;gap:8px">
          <button class="btn" id="token-copy">复制</button>
          <button class="btn" id="token-copy-prompt" title="复制按本令牌参数（含接入地址）生成的 AI 客户端提示词">复制提示词</button>
        </div>
      </div>`;
    onetime.querySelector('#token-copy-prompt').addEventListener('click', () => {
      navigator.clipboard?.writeText(promptText).then(() => {
        const b = onetime.querySelector('#token-copy-prompt');
        b.textContent = '已复制';
        setTimeout(() => (b.textContent = '复制提示词'), 1200);
      });
    });
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

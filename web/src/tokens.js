// MCP 令牌页（US6 / FR-022~026）：渲染在「个人设置 → MCP 令牌」页签
// 明文仅创建时展示一次（FR-023）
// 快速提示词：按表单参数 + MCP 接入地址生成 AI 客户端提示词（不创建令牌）
import { apiUrl } from './base.js';
import { icon } from './icons.js';
import { apiFetch } from './twofa.js';
import { buildMcpJson, highlightJson } from './token-config.js';

const LEVEL_LABEL = { readonly: '只读', writable: '可变更' };
const STATUS_LABEL = { active: '启用', revoked: '已撤销', expired: '已过期' };

/** 解析当前 MCP 接入地址：自定义地址（反代）> 直连端口（用浏览器当前访问的主机名拼真实地址）> 页面 origin */
async function resolveMcpEndpoint() {
  let direct = null;
  try {
    const res = await fetch(apiUrl('mcp-direct'));
    if (res.ok) direct = await res.json();
  } catch {
    /* 网络异常走 origin */
  }
  if (direct?.customEndpoint) return direct.customEndpoint;
  if (direct?.enabled) return `http://${location.hostname}:${direct.port ?? 8422}/mcp`;
  return `${location.origin}/mcp`;
}

/** 生成 AI 客户端接入提示词：自包含接入地址、令牌明文、可用工具与安全约束，AI 可直接据此接入 */
function buildPrompt({ name, level, hosts, allHosts, hostGroups, endpoint, token }) {
  const writable = level === 'writable';
  const hostList = allHosts
    ? '- 全部主机（含后续新增，动态授权）'
    : hostGroups?.length
      ? `- 按分组授权：${hostGroups.join('、')}（分组下新增主机自动附带权限）`
      : hosts.map((h) => `- ${h.name}（${h.username}@${h.host}:${h.port}）`).join('\n');
  const tools = writable
    ? [
        '- list_hosts：列出授权主机',
        '- read_file：读取授权主机上矩阵允许路径的文件内容',
        '- run_command：在授权主机上执行一条命令（拼接/重定向语法与危险命令将被拒绝）',
      ].join('\n')
    : ['- list_hosts：列出授权主机', '- read_file：读取授权主机上矩阵允许路径的文件内容'].join('\n');
  return `你已接入 WebSSH 终端服务的 MCP 服务器，可通过以下工具管理远程主机。以下信息可直接使用，无需再申请令牌。

## 接入信息
- MCP 端点：${endpoint}
- 认证方式：Authorization: Bearer ${token}
- 令牌名称：${name}（服务端仅存 SHA-256 摘要，明文只此一次下发，请妥善保管）

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
  // 布局参考分组管理：列表 + 底部「创建令牌」横条（qc-add-box 同款），点击进入创建页面
  el.innerHTML = `
    <div id="token-onetime"></div>
    <div id="token-list" class="audit-list group-list"><div class="placeholder-box">加载中…</div></div>
    <div class="qc-add-box" id="token-create" title="点击进入创建令牌页面">${icon('plus', 12)} 创建令牌</div>`;
  el.querySelector('#token-create').addEventListener('click', () => openTokenForm(el));
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
  // 列表表头（风格同分组管理 .group-head）：列说明与行内容一一对应
  const head = `
    <div class="token-head">
      <span>名称</span>
      <span class="token-head-level">级别</span>
      <span class="token-head-status">状态</span>
      <span>主机数</span>
      <span>令牌提示</span>
      <span>创建时间</span>
      <span class="token-head-last" title="AI 客户端最近一次经 MCP 连接使用该令牌的时间">活跃时间</span>
      <span class="token-head-op" title="启用中可撤销；已撤销/过期可永久删除">操作</span>
    </div>`;
  list.innerHTML = head + tokens
    .map(
      (t, i) => `<div class="audit-row" data-id="${escapeHtml(t.id)}">
        <span class="token-name-cell">
          <span class="audit-event token-name" title="双击重命名">${escapeHtml(t.name)}</span>
          <button class="icon-btn token-rename" data-id="${escapeHtml(t.id)}" data-name="${escapeHtml(t.name)}" title="重命名（也可双击名称）">${icon('pencil', 13)}</button>
        </span>
        <span class="tag ${t.level === 'writable' ? 'warn' : 'ok'}">${LEVEL_LABEL[t.level] ?? t.level}</span>
        <span class="tag ${t.status === 'active' ? 'ok' : ''}">${STATUS_LABEL[t.status] ?? t.status}</span>
        <span class="audit-detail">${t.allHosts ? '全部主机' : (t.hostGroups?.length ? `${t.hostGroups.length} 组` : `${t.hostScope.length} 台`)}</span>
        <span class="audit-detail" title="令牌明文仅创建时展示一次，此处为 mcp_ 前缀 + 前两位 + * + 后四位提示">${escapeHtml(t.tokenHint ?? '')}</span>
        <span class="audit-time" data-tip="${escapeHtml(formatTime(t.createdAt))}">${formatDate(t.createdAt)}</span>
        <span class="audit-time" data-tip="${t.lastUsedAt ? escapeHtml(formatTime(t.lastUsedAt)) : ''}">${t.lastUsedAt ? formatDate(t.lastUsedAt) : '—'}</span>
        <span class="token-ops">
          ${t.status === 'revoked'
            ? `<button class="icon-btn token-restore" data-id="${escapeHtml(t.id)}" data-name="${escapeHtml(t.name)}" title="恢复令牌「${escapeHtml(t.name)}」（重新启用，可再次接入 AI 客户端）">${icon('refresh', 13)}</button>`
            : '<span class="ops-slot"></span>'}
          ${t.status === 'active'
            ? `<button class="icon-btn danger-text token-revoke" data-id="${escapeHtml(t.id)}" data-name="${escapeHtml(t.name)}" title="撤销令牌「${escapeHtml(t.name)}」（立即生效，记录保留）">${icon('ban', 13)}</button>`
            : `<button class="icon-btn danger-text token-purge" data-id="${escapeHtml(t.id)}" data-name="${escapeHtml(t.name)}" title="永久删除令牌记录「${escapeHtml(t.name)}」（不可恢复）">${icon('trash', 13)}</button>`}
          <button class="icon-btn token-eye" data-idx="${i}" title="查看令牌信息">${icon('eye', 13)}</button>
        </span>
      </div>`
    )
    .join('');
  list.querySelectorAll('.token-rename').forEach((b) =>
    b.addEventListener('click', () => {
      const row = b.closest('.audit-row');
      startTokenRename(el, row, b.dataset.id, b.dataset.name, () => loadTokens(el));
    })
  );
  list.querySelectorAll('.token-name').forEach((n) =>
    n.addEventListener('dblclick', () => {
      const row = n.closest('.audit-row');
      startTokenRename(el, row, row.dataset.id, n.textContent, () => loadTokens(el));
    })
  );
  // 恢复已撤销令牌（2FA 保护，forcePrompt 直接弹码）：恢复后重新可用
  list.querySelectorAll('.token-restore').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm(`恢复令牌「${b.dataset.name}」？恢复后该令牌可再次用于 AI 客户端接入。`)) return;
      const res = await apiFetch(`tokens/${b.dataset.id}/restore`, { method: 'PUT', forcePrompt: true });
      if (res._twofaCancelled) return loadTokens(el); // 用户取消验证：静默放弃
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`恢复失败：${err.error?.message ?? res.statusText}`);
      }
      loadTokens(el);
    })
  );
  // 眼睛：浮层查看令牌信息（创建时间/活跃时间等）
  list.querySelectorAll('.token-eye').forEach((b) =>
    b.addEventListener('click', () => showTokenDetail(tokens[Number(b.dataset.idx)]))
  );
  list.querySelectorAll('.token-revoke').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm(`确定撤销令牌「${b.dataset.name}」？撤销立即生效且不可恢复。`)) return;
      // 令牌撤销受 2FA 保护：用户主动操作，forcePrompt 直接弹码
      const res = await apiFetch(`tokens/${b.dataset.id}`, { method: 'DELETE', forcePrompt: true });
      if (res._twofaCancelled) return loadTokens(el); // 用户取消验证：静默放弃
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`撤销失败：${err.error?.message ?? res.statusText}`);
      }
      loadTokens(el);
    })
  );
  list.querySelectorAll('.token-purge').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm(`永久删除令牌「${b.dataset.name}」的记录？\n删除后列表不再显示该令牌（撤销状态已使其无法使用），此操作不可恢复。`)) return;
      const res = await apiFetch(`tokens/${b.dataset.id}/purge`, { method: 'DELETE', forcePrompt: true });
      if (res._twofaCancelled) return loadTokens(el); // 用户取消验证：静默放弃
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`删除失败：${err.error?.message ?? res.statusText}`);
      }
      loadTokens(el);
    })
  );
  bindFastTips(list);
}

// 令牌详情浮层（独立 overlay，不占用全局 modal 单例）：名称/级别/状态/授权主机数/创建时间/活跃时间
function showTokenDetail(t) {
  if (!t) return;
  const meta = [
    ['名称', t.name],
    ['级别', LEVEL_LABEL[t.level] ?? t.level],
    ['状态', STATUS_LABEL[t.status] ?? t.status],
    ['授权主机', t.allHosts ? '全部主机（含后续新增）' : (t.hostGroups?.length ? `分组：${t.hostGroups.join('、')}（新增主机自动授权）` : `${t.hostScope.length} 台`)],
    ['创建时间', formatTime(t.createdAt)],
    ['活跃时间', t.lastUsedAt ? formatTime(t.lastUsedAt) : '尚未被 AI 客户端使用'],
  ];
  const overlay = document.createElement('div');
  overlay.className = 'audit-detail-overlay';
  overlay.innerHTML = `
    <div class="detail-mask"></div>
    <div class="detail-card">
      <div class="detail-head">
        <span class="detail-badge">${icon('key', 14)} 令牌信息</span>
        <span class="tag ${t.status === 'active' ? 'ok' : ''}">${STATUS_LABEL[t.status] ?? t.status}</span>
        <button class="icon-btn detail-close" title="关闭">${icon('x', 13)}</button>
      </div>
      <div class="detail-meta">
        ${meta
          .map(
            ([k, v]) =>
              `<div class="meta-item"><span class="meta-key">${escapeHtml(k)}</span><span class="meta-val">${escapeHtml(String(v))}</span></div>`
          )
          .join('')}
      </div>
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
  const close = () => {
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 150);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  overlay.querySelector('.detail-mask').addEventListener('click', close);
  overlay.querySelector('.detail-close').addEventListener('click', close);
}

// 行内重命名：名称 span 换成输入框，Enter/失焦保存，Esc 取消（与分组管理重命名同款交互）
// 重命名与撤销/删除同为令牌类 2FA 保护操作：forcePrompt 直接弹码；未启用 2FA 时后端直接放行
function startTokenRename(el, row, id, currentName, onFinished) {
  const nameEl = row.querySelector('.token-name');
  if (!nameEl || row.querySelector('.token-name-input')) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'token-name-input group-name-input'; // 复用行内编辑输入样式
  input.maxLength = 64;
  input.value = currentName;
  input.title = '回车或点击空白保存，Esc 取消';
  row.querySelector('.token-rename')?.style.setProperty('visibility', 'hidden'); // 编辑态让位给输入框
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    const next = input.value.trim();
    // 未改/清空：直接还原，不发请求
    if (!save || !next || next === currentName) {
      done = true;
      return onFinished();
    }
    done = true;
    const res = await apiFetch(`tokens/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: next }),
      forcePrompt: true,
    });
    if (res._twofaCancelled) return onFinished(); // 用户取消验证：静默还原
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`重命名失败：${err.error?.message ?? res.statusText}`);
    }
    onFinished();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // 避免冒泡到全局快捷键
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
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
  // 分组清单（按分组授权；接口恒定前置内置 default 分组）
  let groups = [];
  try {
    const res = await fetch(apiUrl('groups'));
    if (res.ok) groups = (await res.json()).groups ?? [];
  } catch {
    /* 分组不可用时仍可按主机授权 */
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
      <label>授权方式
        <div class="seg" style="margin-top:6px">
          <button type="button" class="seg-btn selected" data-mode="groups">根据分组授权</button>
          <button type="button" class="seg-btn" data-mode="hosts">根据主机授权</button>
        </div>
      </label>
      <div id="scope-hosts" hidden>
        <label>
          <div style="display:flex;align-items:center;gap:8px;white-space:nowrap">
            <span>授权主机</span>
            <span style="font-weight:400">
              <input type="checkbox" id="token-hosts-all" style="display:inline-block;width:auto;margin:0;vertical-align:-2px" /> 全选
            </span>
          </div>
          <div class="picker-list" style="margin-top:6px">
            ${hosts
              .map(
                (h) => `<label style="display:flex;align-items:center;gap:8px;margin:0;padding:8px 10px;border:1px solid var(--border);border-radius:6px">
                  <input type="checkbox" name="host" value="${escapeHtml(h.id)}" style="display:inline-block;width:auto;margin:0" />
                  <span>${escapeHtml(h.name)} <span style="color:var(--text-dim);font-size:11px">${escapeHtml(h.username)}@${escapeHtml(h.host)}</span></span>
                </label>`
              )
              .join('')}
          </div>
        </label>
      </div>
      <div id="scope-groups">
        <label>授权分组（至少一个）
          <div class="picker-list" style="margin-top:6px">
            ${groups
              .map(
                (g) => `<label style="display:flex;align-items:center;gap:8px;margin:0;padding:8px 10px;border:1px solid var(--border);border-radius:6px">
                  <input type="checkbox" name="group" value="${escapeHtml(g.name)}" style="display:inline-block;width:auto;margin:0" />
                  <span>${escapeHtml(g.name)} <span style="color:var(--text-dim);font-size:11px">${g.count} 台主机</span></span>
                </label>`
              )
              .join('')}
          </div>
        </label>
        <p class="pref-desc">按分组授权后，该分组下新增的主机会自动附带本令牌权限</p>
      </div>
      <label>有效期
        <select name="expiresDays" class="pref-input" style="margin-top:6px;width:200px">
          <option value="7">7 天</option>
          <option value="15">15 天</option>
          <option value="30" selected>30 天</option>
          <option value="60">60 天</option>
          <option value="90">90 天</option>
          <option value="180">180 天</option>
          <option value="365">1 年</option>
          <option value="">永久有效</option>
        </select>
      </label>
      <p class="form-note">令牌明文仅创建后展示一次；目录权限继承全局默认矩阵（只能收紧）。系统敏感路径恒定拒绝。创建成功后可一键复制含接入地址与令牌明文的自包含提示词。</p>
      <div class="form-actions">
        <button type="submit" class="btn primary">创建</button>
        <button type="button" class="btn" id="token-cancel">取消</button>
      </div>
      <div id="token-prompt-out"></div>
    </form>`;

  const form = el.querySelector('#token-form');
  const levelInput = form.querySelector('[name=level]');
  // 操作级别 seg：仅匹配本组按钮（data-value），避免误伤同表单的授权方式 seg（data-mode）
  form.querySelectorAll('.seg-btn[data-value]').forEach((b) =>
    b.addEventListener('click', () => {
      levelInput.value = b.dataset.value;
      form.querySelectorAll('.seg-btn[data-value]').forEach((x) => x.classList.toggle('selected', x === b));
    })
  );
  form.querySelector('#token-cancel').addEventListener('click', () => renderTokens(el));

  // 全选：控制主机清单整体勾选/取消
  const allToggle = form.querySelector('#token-hosts-all');
  const hostChecks = () => [...form.querySelectorAll('input[name=host]')];
  allToggle.addEventListener('change', () => {
    hostChecks().forEach((c) => (c.checked = allToggle.checked));
  });

  // 授权方式切换：分组（默认）↔ 主机；互斥展示，提交时按当前模式组装
  form.dataset.scopeMode = 'groups';
  const scopeHostsBox = form.querySelector('#scope-hosts');
  const scopeGroupsBox = form.querySelector('#scope-groups');
  form.querySelectorAll('.seg [data-mode]').forEach((b) =>
    b.addEventListener('click', () => {
      form.dataset.scopeMode = b.dataset.mode;
      form.querySelectorAll('.seg [data-mode]').forEach((x) =>
        x.classList.toggle('selected', x === b)
      );
      scopeHostsBox.hidden = b.dataset.mode !== 'hosts';
      scopeGroupsBox.hidden = b.dataset.mode !== 'groups';
    })
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const result = await createTokenFromForm(form, levelInput, hosts);
    if (result.err) return alert(result.err);
    if (result.cancelled) return; // 用户取消验证：静默放弃创建
    const endpoint = await resolveMcpEndpoint();
    const promptText = buildPrompt({
      name: result.body.name,
      level: result.body.level,
      hosts: hosts.filter((h) => result.body.hostScope.includes(h.id)),
      hostGroups: result.body.hostGroups,
      endpoint,
      token: result.created.token,
    });
    showCreated(el, result.created, promptText, buildMcpJson(endpoint, result.created.token));
  });
}

/**
 * 按表单参数创建令牌（2FA 保护，forcePrompt 直接弹码）。
 * @returns {Promise<{err: string} | {cancelled: true} | {ok: true, created: object, body: object}>}
 */
async function createTokenFromForm(form, levelInput, hosts) {
  const fd = new FormData(form);
  const name = String(fd.get('name') ?? '').trim() || 'AI 助手';
  // 授权方式：分组（默认，分组下新增主机自动授权）或主机（固定清单）
  const mode = form.dataset.scopeMode ?? 'groups';
  const hostScope = mode === 'hosts' ? fd.getAll('host') : [];
  const hostGroups = mode === 'groups' ? fd.getAll('group') : [];
  if (mode === 'hosts' && !hostScope.length) {
    return { err: '请先勾选至少一台授权主机（或改用分组授权）' };
  }
  if (mode === 'groups' && !hostGroups.length) {
    return { err: '请至少勾选一个授权分组' };
  }
  const body = { name, level: levelInput.value, hostScope, hostGroups };
  // 有效期下拉：天 → 到期时刻；空 = 永久
  const days = Number(fd.get('expiresDays'));
  if (days > 0) body.expiresAt = new Date(Date.now() + days * 86400000).toISOString();
  const res = await apiFetch('tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    forcePrompt: true,
  });
  if (res._twofaCancelled) return { cancelled: true };
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { err: `创建失败：${err.error?.message ?? res.statusText}` };
  }
  return { ok: true, created: await res.json(), body };
}

/**
 * 创建成功视图（明文仅此一次展示 FR-023）：独立成功页——仅展示一次性明文块与
 * 含真实令牌的 mcp.json / 提示词复制入口；点「完成」后才进入令牌管理列表页。
 */
function showCreated(el, created, promptText, mcpJson) {
  el.innerHTML = `
    <div id="token-onetime"></div>`;
  const onetime = el.querySelector('#token-onetime');
  onetime.innerHTML = `
    <div class="onetime-token">
      <div>令牌「${escapeHtml(created.name)}」已创建。<b>明文仅此一次展示</b>，确认已复制保存后点「完成」进入令牌管理：</div>
      <div class="onetime-actions">
        <button class="btn" id="token-copy">仅复制令牌</button>
        <button class="btn" id="token-copy-mcp" title="复制含真实令牌的 mcp.json，粘贴到 AI 客户端配置即可用">复制 MCP 配置</button>
        <button class="btn" id="token-copy-prompt" title="复制含接入地址与令牌明文的自包含提示词，AI 可直接据此接入">复制提示词</button>
      </div>
      <div class="tc-code-win">
        <div class="tc-code-bar">
          <span class="tc-dots"><i class="red"></i><i class="yellow"></i><i class="green"></i></span>
          <span class="tc-code-title">mcp.json</span>
          <span class="tc-flex-gap"></span>
          <button class="tc-bar-btn" id="token-copy-mcpjson" title="复制含真实令牌的 mcp.json，粘贴到 AI 客户端配置即可用">复制</button>
        </div>
        <pre class="tc-conf">${highlightJson(escapeHtml(mcpJson))}</pre>
      </div>
      <div class="onetime-plain">
        <span>令牌明文：</span>
        <span class="onetime-value">${escapeHtml(created.token)}</span>
      </div>
      <div class="form-actions">
        <button class="btn primary" id="token-done">完成</button>
      </div>
    </div>`;
  // 完成：确认已复制保存后进入令牌管理列表（此前为成功块叠在列表顶部，易忽略一次性明文）
  onetime.querySelector('#token-done').addEventListener('click', () => renderTokens(el));
  onetime.querySelector('#token-copy-mcpjson').addEventListener('click', () => {
    navigator.clipboard?.writeText(mcpJson).then(() => {
      const b = onetime.querySelector('#token-copy-mcpjson');
      b.textContent = '已复制';
      setTimeout(() => (b.textContent = '复制'), 1200);
    });
  });
  onetime.querySelector('#token-copy-mcp').addEventListener('click', () => {
    navigator.clipboard?.writeText(mcpJson).then(() => {
      const b = onetime.querySelector('#token-copy-mcp');
      b.textContent = '已复制';
      setTimeout(() => (b.textContent = '复制 MCP 配置'), 1200);
    });
  });
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
}

function formatTime(ts) {
  return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '-';
}

/** 仅年月日（列表默认展示）；悬停 tooltip 里仍保留完整时分秒 */
function formatDate(ts) {
  return ts ? new Date(ts).toLocaleDateString('zh-CN') : '-';
}

/** 快速悬停提示：原生 title 有约 1s 延迟，改为自定义 tooltip 立即显示（data-tip 驱动） */
let fastTip = null;
function bindFastTips(list) {
  list.querySelectorAll('[data-tip]').forEach((el) => {
    if (!el.dataset.tip) return;
    el.addEventListener('mouseenter', () => {
      if (!fastTip) {
        fastTip = document.createElement('div');
        fastTip.className = 'fast-tip';
        document.body.appendChild(fastTip);
      }
      fastTip.textContent = el.dataset.tip;
      const r = el.getBoundingClientRect();
      fastTip.style.left = `${r.left + r.width / 2}px`;
      fastTip.style.top = `${r.bottom + 6}px`;
      fastTip.classList.add('show');
    });
    el.addEventListener('mouseleave', () => fastTip?.classList.remove('show'));
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

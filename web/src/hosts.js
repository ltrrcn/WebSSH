// 左侧会话连接列表 + 表单弹窗（FR-044/055：左栏展示已保存的会话连接；表单走弹窗）
import { openModal } from './modal.js';
import { showContextMenu } from './contextmenu.js';
import { apiUrl, getRuntime } from './base.js';
import { icon } from './icons.js';
import { apiFetch } from './twofa.js';

// —— 会话连接授权范围（连接内「范围」选项）——
// all：全选（默认，终端 + MCP）；terminal：仅终端（对 MCP 不可见）；mcp：仅 MCP（网页终端不可连接）
const SCOPE_LABEL = { all: '全选', terminal: '终端', mcp: 'MCP' };
const SCOPE_NOTE = {
  all: '全选：网页终端与 MCP 均可使用该会话连接。',
  terminal: '终端：仅用于网页终端，该连接对 MCP 不可见（AI 侧列不出、也调不动）。',
  mcp: 'MCP：仅授权 MCP，网页终端不可连接；只能编辑，且编辑需 2FA 二次验证。',
};
/** MCP 使用顺序基准：未指定「优先使用」时为 1 */
const MCP_ORDER_BASE = 1;

function normalizeScope(v) {
  return SCOPE_LABEL[v] ? v : 'all';
}
/** 分组归一化：历史别名（null/default/默认）与内置 Default 同义 */
function normalizeGroup(v) {
  return v == null || v === 'default' || v === '默认' ? 'Default' : v;
}
/**
 * 计算各连接在 MCP 中的使用顺序（与后端 computeMcpOrders 同口径）：
 * 默认 1；指定「优先使用」后本连接 = 被指向连接的顺序 + 1（前面已是 2 则本连接为 3）。
 * @param {Array<object>} hosts
 * @returns {Map<string, number>}
 */
function computeMcpOrders(hosts) {
  const byId = new Map((hosts ?? []).map((h) => [h.id, h]));
  const orders = new Map();
  const onPath = new Set();
  const resolve = (id) => {
    if (orders.has(id)) return orders.get(id);
    if (onPath.has(id)) return MCP_ORDER_BASE; // 环：截断
    onPath.add(id);
    const h = byId.get(id);
    const pid = h && normalizeScope(h.scope) !== 'terminal' ? h.mcpPrompt?.preferHostId ?? null : null;
    // 目标必须存在且对 MCP 可见（终端范围的连接不在 MCP 视野内，不能排在它后面）
    const target = pid ? byId.get(pid) : null;
    const n = target && pid !== id && normalizeScope(target.scope) !== 'terminal' ? resolve(pid) + 1 : MCP_ORDER_BASE;
    onPath.delete(id);
    orders.set(id, n);
    return n;
  };
  for (const id of byId.keys()) resolve(id);
  return orders;
}
/** 沿「优先使用」链判断是否会回到 targetId（用于排除会形成循环的可选项） */
function preferChainReaches(hosts, fromId, targetId) {
  if (!targetId) return false;
  const byId = new Map((hosts ?? []).map((h) => [h.id, h]));
  let cursor = byId.get(fromId)?.mcpPrompt?.preferHostId ?? null;
  for (let hop = 0; cursor && hop <= byId.size; hop += 1) {
    if (cursor === targetId) return true;
    cursor = byId.get(cursor)?.mcpPrompt?.preferHostId ?? null;
  }
  return false;
}
/** 仅 MCP 授权：网页终端入口关闭（不可连接） */
function isMcpOnly(h) {
  return normalizeScope(h?.scope) === 'mcp';
}
/** 已落盘的 MCP 终端提示词（终端范围恒为 null） */
function mcpPromptOf(h) {
  return normalizeScope(h?.scope) === 'terminal' ? null : h?.mcpPrompt ?? null;
}

export async function fetchHosts() {
  try {
    const res = await fetch(apiUrl('hosts'));
    if (res.ok) return await res.json();
  } catch {
    /* 网络异常 */
  }
  return [];
}

/**
 * 渲染左侧主机列表。
 * @param {HTMLElement} container #host-list
 * @param {{onConnect: (host)=>void, connectedIds: string[], onChanged: ()=>void}} opts
 */
export async function renderHostList(container, { onConnect, connectedIds = [], onChanged }) {
  const hosts = await fetchHosts();
  const countEl = document.getElementById('host-count');
  if (countEl) countEl.textContent = hosts.length ? `${hosts.length} 台` : '';

  const connected = new Set(connectedIds);
  const groups = new Map();
  for (const h of hosts) {
    // 内置 Default 分组：null 与历史别名（default/默认）均归入
    const g = h.group == null || h.group === '默认' || h.group === 'default' ? 'Default' : h.group;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(h);
  }
  const expanded = loadExpandedGroups();
  // 分组顺序 = 分组管理中的排序（Default 恒为第一）；无实体的历史分组按名称排在最后
  let groupOrder = ['Default'];
  try {
    const gr = await fetch(apiUrl('groups'));
    if (gr.ok) groupOrder = (await gr.json()).groups.map((g) => g.name);
  } catch {
    /* 网络异常时仅 Default 优先 */
  }
  const rank = new Map(groupOrder.map((n, i) => [n, i]));
  const sortedGroups = [...groups.entries()].sort((a, b) => {
    const ra = rank.get(a[0]) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b[0]) ?? Number.MAX_SAFE_INTEGER;
    return ra !== rb ? ra - rb : a[0].localeCompare(b[0], 'zh');
  });
  for (const [, list] of sortedGroups) list.sort((a, b) => a.name.localeCompare(b.name, 'zh'));

  const groupsHtml = sortedGroups
    .map(
      ([g, list]) => `
      <div class="side-group ${expanded.has(g) ? '' : 'collapsed'}" data-group="${escapeHtml(g)}">
        <button class="side-group-head" title="点击展开/折叠">
          <span class="group-chevron">${icon('chevron', 12)}</span>
          <span class="group-name">${escapeHtml(g)}</span>
          <span class="group-count">${list.length}</span>
        </button>
        <div class="group-items">
          <div class="group-items-inner">
            ${list
              .map(
                (h) => `<div class="host-item ${connected.has(h.id) ? 'connected' : ''} ${isMcpOnly(h) ? 'mcp-only' : ''}" data-id="${escapeHtml(h.id)}">
                <div class="host-main">
                  <span class="host-name">${escapeHtml(h.name)}</span>
                  <span class="host-meta">${escapeHtml(h.username)}@${escapeHtml(h.host)}:${h.port} · ${isMcpOnly(h) ? 'MCP' : ({ password: '密码', privateKey: '密钥', none: '每次输入' }[h.authType] ?? h.authType)}</span>
                </div>
                <span class="host-actions">${hostBadge(h)}${scopeBadge(h)}</span>
              </div>`
              )
              .join('')}
          </div>
        </div>
      </div>`
    )
    .join('');
  // 新增入口放在列表底部：分组管理同款虚线新增框（qc-add-box）
  const addBoxHtml = `<div class="qc-add-box sidebar-add" id="sidebar-add-host" title="新建会话连接">${icon('plus', 12)} 新建会话连接</div>`;
  const emptyHtml = hosts.length
    ? ''
    : '<div class="sidebar-empty">暂无会话连接<br/>点击下方「新建会话连接」或右键新建</div>';
  container.innerHTML = emptyHtml + groupsHtml + addBoxHtml;
  container
    .querySelector('#sidebar-add-host')
    .addEventListener('click', () => openHostFormModal(null, onChanged));

  // FR-054：分组展开/折叠（竖状树形），状态持久化到 localStorage
  container.querySelectorAll('.side-group-head').forEach((head) => {
    head.addEventListener('click', () => {
      const groupEl = head.closest('.side-group');
      const g = groupEl.dataset.group;
      if (expanded.has(g)) expanded.delete(g);
      else expanded.add(g);
      saveExpandedGroups(expanded);
      groupEl.classList.toggle('collapsed');
    });
  });

  container.querySelectorAll('.host-item').forEach((item) => {
    const host = hosts.find((h) => h.id === item.dataset.id);
    if (!host) return;
    // 主条目单击 = 连接（每次新建一个会话卡）；仅 MCP 授权的连接无终端可连，单击不响应（编辑/删除走右键菜单）
    item.addEventListener('click', () => {
      if (isMcpOnly(host)) return;
      onConnect(host);
    });
    // FR-055：会话连接右键菜单
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showHostMenu(host, e.clientX, e.clientY, { onConnect, onChanged });
    });
  });

  // FR-055：列表空白处右键 → 新建会话连接
  container.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.host-item')) return;
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, {
      items: [
        { label: '新建会话连接', onClick: () => openHostFormModal(null, onChanged) },
      ],
    });
  });
}

/** FR-055：会话连接右键菜单（侧栏列表与空态「快速连接」卡片共用） */
export function showHostMenu(host, x, y, { onConnect, onChanged }) {
  showContextMenu(x, y, {
    meta: `${host.name}`,
    items: [
      { label: '连接', disabled: isMcpOnly(host), onClick: () => onConnect(host) },
      {
        label: '复制会话',
        onClick: async () => {
          // FR-056：服务端复制完整记录（含凭据密文）
          await fetch(apiUrl(`hosts/${encodeURIComponent(host.id)}/duplicate`), { method: 'POST' });
          onChanged();
        },
      },
      { label: '编辑', onClick: () => openHostFormModal(host, onChanged) },
      'sep',
      {
        label: '删除',
        danger: true,
        onClick: async () => {
          if (!confirm(`确定删除「${host.name}」？其凭据将一并删除。`)) return;
          await fetch(apiUrl(`hosts/${encodeURIComponent(host.id)}`), { method: 'DELETE' });
          onChanged();
        },
      },
    ],
  });
}

/** 分组展开状态（FR-054）：localStorage 持久化；默认全部折叠，仅 Default 默认展开。设置→分组管理也读写此状态 */
const EXPANDED_KEY = 'webssh-expanded-groups';
export function loadExpandedGroups() {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    if (raw == null) return new Set(['Default']); // 首次使用：Default 展开，其余折叠
    return new Set(JSON.parse(raw));
  } catch {
    return new Set(['Default']);
  }
}
export function saveExpandedGroups(set) {
  localStorage.setItem(EXPANDED_KEY, JSON.stringify([...set]));
}

/** 范围标记：全选（默认）不占位，终端/MCP 各一个语义色标签 */
function scopeBadge(h) {
  const s = normalizeScope(h?.scope);
  if (s === 'all') return '';
  return s === 'mcp'
    ? `<span class="tag warn" title="仅授权 MCP：网页终端不可连接，只能编辑">仅 MCP</span>`
    : `<span class="tag" title="仅终端：该连接对 MCP 不可见">仅终端</span>`;
}

function hostBadge(h) {
  if (h.fingerprintConfirmed) return '';
  if (h.pendingFingerprint) {
    // 指纹已捕获待确认：仅作状态提示，确认动作在右键「连接」流程中弹出（connectHost 前置拦截）
    return `<span class="tag warn" title="指纹待确认：${escapeHtml(h.pendingFingerprint)}（右键→连接时将提示确认）">待确认</span>`;
  }
  return '<span class="tag" title="首次连接需确认指纹">待确认</span>';
}

/** R003 指纹确认弹窗（居中 modal）：确认返回 true（已 verify），取消/失败返回 false */
export async function confirmFingerprintModal(host) {
  const fp = host.pendingFingerprint;
  if (!fp) return false;
  return new Promise((resolve) => {
    const m = openModal(`
      <div class="fp-confirm">
        <p class="fp-desc">首次连接 <strong>${escapeHtml(host.name)}</strong>，请核对目标主机指纹：</p>
        <div class="fp-meta">
          <span class="fp-meta-label">主机</span><code>${escapeHtml(host.username)}@${escapeHtml(host.host)}:${host.port}</code>
        </div>
        <div class="fp-meta">
          <span class="fp-meta-label">指纹</span><code class="fp-value">${escapeHtml(fp)}</code>
        </div>
        <p class="fp-note">请与目标主机管理员核对无误后信任（可在远端执行 <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> 查看）。指纹不匹配说明连接可能被劫持。</p>
        <div class="qc-edit-actions" style="margin-top:14px">
          <button class="btn" id="fp-cancel">取消</button>
          <button class="btn primary" id="fp-trust">信任并连接</button>
        </div>
      </div>`);
    m.setTitle('首次连接指纹确认');
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      m.close();
      resolve(v);
    };
    m.root.querySelector('#fp-cancel').addEventListener('click', () => done(false));
    m.root.querySelector('#fp-trust').addEventListener('click', async () => {
      const btn = m.root.querySelector('#fp-trust');
      btn.disabled = true;
      btn.textContent = '确认中…';
      const res = await fetch(apiUrl(`hosts/${encodeURIComponent(host.id)}/verify-hostkey`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fingerprint: fp }),
      });
      if (res.ok) done(true);
      else {
        alert('指纹确认失败，请重试');
        btn.disabled = false;
        btn.textContent = '信任并连接';
      }
    });
  });
}

/**
 * 新增/编辑主机弹窗（凭据留空 = 保持不变，FR-005）
 * 分组为下拉选择：默认选中内置 default 分组
 */
export async function openHostFormModal(host, onSaved) {
  const isEdit = Boolean(host);
  // 分组选项来自实体分组列表（Default 恒为第一项）
  let groupOptions = ['Default'];
  try {
    const gr = await fetch(apiUrl('groups'));
    if (gr.ok) groupOptions = (await gr.json()).groups.map((g) => g.name);
  } catch {
    /* 网络异常时仅有 Default */
  }
  // 编辑态：历史别名（null/default/默认）归一为 Default
  const rawGroup = isEdit ? host.group : null;
  const currentGroup = rawGroup == null || rawGroup === '默认' || rawGroup === 'default' ? 'Default' : rawGroup;
  if (currentGroup !== 'Default' && !groupOptions.includes(currentGroup)) {
    groupOptions.push(currentGroup); // 历史无实体分组也保留可选
  }
  // 编辑态：历史记录无 scope 字段时按全选处理
  const currentScope = normalizeScope(host?.scope);
  const mp = mcpPromptOf(host) ?? {};
  // 「优先使用」候选：同一分组下的其他会话连接（对 MCP 可见者）
  const allHosts = await fetchHosts();
  // 左侧菜单：连接承载表单；MCP 授权为连接级授权与终端提示词；脚本/隧道/高级为规划中的占位面板
  const NAV = [
    { key: 'connect', label: '连接', icon: 'terminal' },
    { key: 'mcp', label: 'MCP 授权', icon: 'plug' },
    { key: 'scripts', label: '脚本', icon: 'code' },
    { key: 'advanced', label: '高级', icon: 'sliders' },
  ];
  const m = openModal(
    `<nav class="sp-nav">${NAV.map(
      (n, i) => `<button type="button" class="sp-nav-item${i === 0 ? ' active' : ''}" data-pane="${n.key}">${icon(n.icon, 15)}<span>${n.label}</span></button>`
    ).join('')}</nav>
    <div class="sp-panes">
      <section class="sp-pane active" data-pane="connect">
        <form id="host-form" class="host-form" novalidate>
      <div class="hf-row">
        <label>名称 <input name="name" required maxlength="64" placeholder="例如：生产服务器" value="${isEdit ? escapeHtml(host.name) : ''}" /></label>
        <label>用户名 <input name="username" required placeholder="root" value="${isEdit ? escapeHtml(host.username) : ''}" /></label>
      </div>
      <div class="hf-row">
        <label class="hf-via">连接方式
          <select name="connectVia">
            <option value="direct" ${!isEdit || (host.connectVia ?? 'direct') === 'direct' ? 'selected' : ''}>直连（默认）</option>
            <option value="jump" ${isEdit && host.connectVia === 'jump' ? 'selected' : ''}>跳板机</option>
            <option value="socks" disabled>SOCKS（后续加入）</option>
            <option value="http" disabled>HTTP 代理（后续加入）</option>
          </select>
        </label>
        <label class="hf-grow">地址 <input name="host" required placeholder="域名或 IP" value="${isEdit ? escapeHtml(host.host) : ''}" /></label>
        <label class="hf-port">端口 <input name="port" type="number" min="1" max="65535" value="${isEdit ? host.port : 22}" /></label>
      </div>
      <div data-via="jump" hidden>
        <label>跳板机
          <select name="jumpHostId"></select>
        </label>
        <p class="form-note" style="margin-top:-6px">以选中的已有主机作为 SSH 跳板（ProxyJump，单级）；跳板机需已保存凭据并完成指纹确认。</p>
      </div>
      <div class="hf-row">
        <label style="flex:1">分组
          <select name="group">
            ${groupOptions
              .map((g) => `<option value="${escapeHtml(g)}" ${g === currentGroup ? 'selected' : ''}>${escapeHtml(g)}</option>`)
              .join('')}
          </select>
        </label>
        <div class="hf-twofa-toggle" id="hf-twofa-toggle"
             title="开启后：终端与 MCP 首次使用该连接需完成一次 2FA 验证，验证一次永久有效">
          <span class="hf-twofa-toggle-label">二次认证</span>
          <label class="switch">
            <input type="checkbox" id="hf-require-twofa" ${host?.requireTwofa === true ? 'checked' : ''} disabled />
            <span></span>
          </label>
          <span class="hf-twofa-toggle-note" id="hf-twofa-note" hidden>需先在设置中启用 2FA验证</span>
        </div>
      </div>
      <label>范围
        <div class="seg" role="radiogroup">
          <button type="button" class="seg-btn" data-scope="all">${icon('check', 13)} 全选</button>
          <button type="button" class="seg-btn" data-scope="terminal">${icon('terminal', 13)} 终端</button>
          <button type="button" class="seg-btn" data-scope="mcp">${icon('plug', 13)} MCP</button>
        </div>
        <input type="hidden" name="scope" value="${currentScope}" />
        <p class="form-note" id="hf-scope-note"></p>
      </label>
      <label>认证方式
        <div class="seg" role="radiogroup">
          <button type="button" class="seg-btn ${isEdit && host.authType === 'none' ? 'selected' : ''}" data-value="none">${icon('ban', 13)} 无</button>
          <button type="button" class="seg-btn ${!isEdit || host.authType === 'password' ? 'selected' : ''}" data-value="password">${icon('key', 13)} 密码</button>
          <button type="button" class="seg-btn ${isEdit && host.authType === 'privateKey' ? 'selected' : ''}" data-value="privateKey">${icon('file', 13)} 密钥</button>
        </div>
        <input type="hidden" name="authType" value="${isEdit ? host.authType : 'password'}" />
      </label>
      <label data-cred="password">密码 <input name="password" type="password" autocomplete="new-password" placeholder="${isEdit ? '留空保持不变' : ''}" /></label>
      <div class="hf-key-field" data-cred="privateKey" hidden>
        <span class="hf-key-label">私钥文件</span>
        <div class="key-drop" id="key-drop">
          <span class="key-drop-hint">${isEdit ? '已保存私钥，重新导入以更换' : '拖入私钥文件到此处，或'}</span>
          <span class="key-drop-btns">
            <button type="button" class="btn key-btn" id="key-local">${icon('upload', 13)} 本地导入</button>
            <button type="button" class="btn key-btn" id="key-fnos" hidden>${icon('nas', 13)} 从飞牛导入</button>
          </span>
        </div>
        <div class="key-selected" id="key-selected" hidden>
          ${icon('file', 14)}
          <span class="key-name" id="key-name"></span>
          <span class="key-size" id="key-size"></span>
          <button type="button" class="icon-btn danger" id="key-remove" title="移除">${icon('trash', 13)}</button>
        </div>
        <input type="file" id="key-file" hidden />
        <p class="form-note" style="margin-top:4px">私钥有口令时无需在此填写，连接时会提示输入。</p>
      </div>
      <p class="form-note" data-cred="none" hidden>不记录密码：每次连接时都会弹出密码输入框，凭据不落地保存。</p>
      <p class="form-note" id="hf-cred-note">${isEdit ? '凭据留空表示保持原凭据不变。' : '凭据将以 AES-256-GCM 加密保存，不会明文显示。'}</p>
      <div class="form-actions">
        <span class="hf-error" role="alert"></span>
        <button type="button" class="btn" id="host-form-cancel">取消</button>
        <button type="submit" class="btn primary">${isEdit ? '保存' : '创建'}</button>
      </div>
        </form>
      </section>
      <section class="sp-pane" data-pane="mcp">
        <form class="host-form" id="mcp-form">
          <div class="mcp-hero">
            <span class="mcp-hero-icon">${icon('plug', 20)}</span>
            <div class="mcp-hero-text">
              <div class="mcp-hero-title">MCP 授权</div>
              <div class="mcp-hero-sub" id="mcp-pane-note"></div>
            </div>
            <span class="tag" id="mcp-scope-tag">全选</span>
          </div>
          <div class="mcp-prompt" id="mcp-prompt-box">
            <div class="mcp-prompt-title">终端提示词<span class="mcp-prompt-sub">仅「全选 / MCP」范围可配置</span></div>
            <label>优先使用
              <select id="mcp-prefer"></select>
            </label>
            <div class="mcp-chain" id="mcp-chain"></div>
            <div class="mcp-scene-box">
              <div class="mcp-scene-head">
                <div class="mcp-scene-tabs" role="tablist">
                  <button type="button" class="mcp-tab active" data-view="edit">什么场景下使用</button>
                  <button type="button" class="mcp-tab" data-view="preview">提示词预览</button>
                </div>
                <button type="button" class="btn" id="mcp-copy" hidden>${icon('file', 12)} 复制</button>
              </div>
              <textarea id="mcp-scenario" rows="6" maxlength="500" placeholder="例如：仅在排查磁盘占用与日志时使用，勿用于批量变更">${escapeHtml(mp.scenario ?? '')}</textarea>
              <textarea id="mcp-preview" rows="6" readonly hidden></textarea>
            </div>
            <div class="mcp-consent">
              <label class="switch"><input type="checkbox" id="mcp-consent" ${mp.requireConsent === true ? 'checked' : ''} /><span></span></label>
              <div class="mcp-consent-text">
                <div class="mcp-consent-label">使用当前会话连接需 Agent 经用户同意后执行</div>
                <div class="pref-desc">默认关闭：开启后，Agent 每次经 MCP 使用本连接执行命令前，必须先取得你的确认。</div>
              </div>
            </div>
          </div>
          <div class="form-actions">
            <button type="button" class="btn" id="mcp-form-cancel">取消</button>
            <button type="button" class="btn primary" id="mcp-form-submit">${isEdit ? '保存' : '创建'}</button>
          </div>
        </form>
      </section>
      <section class="sp-pane" data-pane="scripts">
        <form class="host-form" id="scripts-form">
          <p class="form-note" style="margin-top:0">登录成功后按顺序自动执行以下命令（最多 20 条，单条 500 字符以内）。命令在你的终端会话中执行，过程与输出直接可见并照常审计；每次连接（含断线重连）都会执行。</p>
          <div id="hf-scripts-list"></div>
          <div class="qc-add-box" id="hf-script-add" title="添加一条命令">${icon('plus', 12)} 添加命令</div>
          <div class="form-actions">
            <button type="button" class="btn" id="scripts-form-cancel">取消</button>
            <button type="button" class="btn primary" id="scripts-form-submit">${isEdit ? '保存' : '创建'}</button>
          </div>
        </form>
      </section>
      <section class="sp-pane" data-pane="advanced">
        <form class="host-form" id="advanced-form">
          <p class="form-note" style="margin-top:0">仅对当前连接生效的会话参数；「跟随全局」使用通用设置中的默认值。</p>
          <div class="hf-row">
            <label>空闲断开
              <select id="hf-idle-timeout">
                <option value="">跟随全局</option>
                <option value="300000">5 分钟</option>
                <option value="600000">10 分钟</option>
                <option value="1800000">30 分钟</option>
                <option value="3600000">1 小时</option>
                <option value="14400000">4 小时</option>
                <option value="0">永不断开</option>
              </select>
            </label>
            <label>连接超时
              <select id="hf-conn-timeout">
                <option value="">跟随全局</option>
                <option value="5000">5 秒</option>
                <option value="15000">15 秒</option>
                <option value="30000">30 秒</option>
                <option value="60000">60 秒</option>
              </select>
            </label>
          </div>
          <div class="hf-row">
            <label>会话保活
              <select id="hf-detach-ttl">
                <option value="">跟随全局</option>
                <option value="300000">5 分钟</option>
                <option value="1800000">30 分钟</option>
                <option value="3600000">1 小时</option>
                <option value="14400000">4 小时</option>
              </select>
            </label>
            <label>终端类型
              <select id="hf-term-type">
                <option value="">默认（xterm-256color）</option>
                <option value="xterm-256color">xterm-256color</option>
                <option value="xterm">xterm</option>
                <option value="xterm-color">xterm-color</option>
                <option value="vt220">vt220</option>
                <option value="vt100">vt100</option>
                <option value="linux">linux</option>
              </select>
            </label>
          </div>
          <p class="form-note" style="margin-top:-8px">空闲断开：终端无输入输出超过该时长自动断开。连接超时：建立 SSH 连接的最长等待（慢设备可放宽）。会话保活：断开后服务端保留会话可随时接管的时长。终端类型：老设备乱码时可降级（如 vt100）。</p>
          <label>断线自动重连
            <div class="hf-switch-row">
              <label class="switch"><input type="checkbox" id="hf-auto-reconnect" /><span></span></label>
              <span class="hf-switch-desc">网络瞬断时自动重试（1/2/4 秒退避，共 3 次）；需输入凭据或指纹确认的断开不会自动重试</span>
            </div>
          </label>
          <label>启动目录
            <input type="text" id="hf-start-dir" maxlength="200" placeholder="例如 ~/projects 或 /var/www（留空 = 不切换）" spellcheck="false" />
          </label>
          <label>环境变量
            <textarea id="hf-env" rows="3" maxlength="2000" placeholder="每行一条 KEY=VALUE，例如：&#10;LANG=zh_CN.UTF-8&#10;EDITOR=vim" spellcheck="false"></textarea>
          </label>
          <p class="form-note" style="margin-top:-8px">登录成功后 export 注入（始终生效，不依赖服务器 AcceptEnv）；顺序：环境变量 → 启动目录 → 脚本。</p>
          <label>审计输出摘要
            <select id="hf-audit-output">
              <option value="">跟随全局设置</option>
              <option value="on">开启（该连接记录命令输出摘要）</option>
              <option value="off">关闭（该连接不记录输出摘要）</option>
            </select>
          </label>
          <label>命令黑名单
            <textarea id="hf-blocked-cmds" rows="3" maxlength="1000" placeholder="每行一个命令词，例如：&#10;rm&#10;shutdown&#10;mkfs" spellcheck="false"></textarea>
          </label>
          <p class="form-note" style="margin-top:-8px">MCP 与快捷命令执行时按首个命令词精确匹配拒绝（服务端硬边界，≤50 条）；网页终端输入同样拦截（Enter 被替换为取消并提示；历史回溯/粘贴等场景为尽力而为）。</p>
          <div class="form-actions">
            <button type="button" class="btn" id="advanced-form-cancel">取消</button>
            <button type="button" class="btn primary" id="advanced-form-submit">${isEdit ? '保存' : '创建'}</button>
          </div>
        </form>
      </section>
      ${NAV.filter((n) => n.soon)
        .map(
          (n) => `<section class="sp-pane" data-pane="${n.key}">
            <div class="sp-soon">
              ${icon(n.icon, 34)}
              <div class="sp-soon-title">${n.label}</div>
              <div class="sp-soon-desc">${n.soon} · 功能规划中，敬请期待</div>
            </div>
          </section>`
        )
        .join('')}
    </div>`
  );
  m.root.classList.add('host-form-modal');
  m.setTitle(isEdit ? `编辑：${host.name}` : '新建会话连接');

  // 菜单切换：右侧面板淡入滑移
  const switchPane = (key) => {
    m.root.querySelectorAll('.sp-nav-item').forEach((b) => b.classList.toggle('active', b.dataset.pane === key));
    m.root.querySelectorAll('.sp-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === key));
  };
  m.root.querySelectorAll('.sp-nav-item').forEach((btn) =>
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) return;
      switchPane(btn.dataset.pane);
    })
  );

  // —— 主机级二次认证开关 ——
  // 能否开启取决于全局 2FA验证 是否已绑定：status 403 = 已绑定未验证（也算已启用）；
  // 未绑定时开关保持置灰并提示。默认置灰，检测到已绑定才放开（防误触先开后关）。
  const twofaSwitch = m.root.querySelector('#hf-require-twofa');
  const twofaNote = m.root.querySelector('#hf-twofa-note');
  apiFetch('2fa/status')
    .then((r) => {
      if (r.status === 403) return true; // 已绑定（面板受保护）
      if (r.ok) return r.json().then((s) => s.enabled === true);
      return false;
    })
    .catch(() => false)
    .then((enabled) => {
      if (!m.root.isConnected) return; // 弹窗已关闭
      twofaSwitch.disabled = !enabled;
      twofaNote.hidden = enabled;
    });

  const form = m.root.querySelector('#host-form');
  const authInput = form.querySelector('[name=authType]');
  // FR-050：认证方式切换时仅显示对应凭据框（分段选择器）
  const syncCred = () => {
    const v = authInput.value;
    form.querySelector('[data-cred=password]').hidden = v !== 'password';
    form.querySelectorAll('[data-cred=privateKey]').forEach((l) => (l.hidden = v !== 'privateKey'));
    form.querySelector('[data-cred=none]').hidden = v !== 'none';
    // 通用加密提示仅密码模式显示：none 不存凭据；密钥区已有专属说明（口令连接时输入）
    form.querySelector('#hf-cred-note').hidden = v !== 'password';
    // 仅匹配认证方式组（data-value），避免误伤「范围」组（data-scope）
    form.querySelectorAll('.seg-btn[data-value]').forEach((b) =>
      b.classList.toggle('selected', b.dataset.value === v)
    );
  };
  form.querySelectorAll('.seg-btn[data-value]').forEach((btn) =>
    btn.addEventListener('click', () => {
      authInput.value = btn.dataset.value;
      syncCred();
    })
  );
  syncCred();

  // —— 范围：全选（默认）/ 终端 / MCP ——
  const scopeInput = form.querySelector('[name=scope]');
  const scopeNote = form.querySelector('#hf-scope-note');
  const mcpScopeTag = m.root.querySelector('#mcp-scope-tag');
  const mcpNoteEl = m.root.querySelector('#mcp-pane-note');
  const mcpBox = m.root.querySelector('#mcp-prompt-box');
  const mcpPrefer = m.root.querySelector('#mcp-prefer');
  const mcpChain = m.root.querySelector('#mcp-chain');
  const mcpScenario = m.root.querySelector('#mcp-scenario');
  const mcpConsent = m.root.querySelector('#mcp-consent');
  const mcpPreview = m.root.querySelector('#mcp-preview');
  const mcpCopy = m.root.querySelector('#mcp-copy');
  const mcpFields = [mcpPrefer, mcpScenario, mcpConsent];
  // MCP 面板仅用于收集提示词：屏蔽隐式提交（真正提交走「连接」面板的 #host-form）
  m.root.querySelector('#mcp-form').addEventListener('submit', (e) => e.preventDefault());
  // 场景填写 / 提示词预览：同一容器内切换视角（复制按钮仅预览视角可见）
  const syncSceneView = (view) => {
    m.root.querySelectorAll('.mcp-tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
    mcpScenario.hidden = view !== 'edit';
    mcpPreview.hidden = view !== 'preview';
    mcpCopy.hidden = view !== 'preview';
  };
  m.root.querySelectorAll('.mcp-tab').forEach((tab) =>
    tab.addEventListener('click', () => syncSceneView(tab.dataset.view))
  );

  /** 当前分组（「连接」面板的分组下拉）→ 优先使用候选仅限同分组 */
  const groupInput = form.querySelector('[name=group]');
  /** 本连接在 MCP 中的使用顺序：默认 1；指定优先目标后顺延为目标顺序 + 1 */
  const currentMcpOrder = () => {
    const sel = mcpPrefer.value;
    if (!sel) return MCP_ORDER_BASE;
    const orders = computeMcpOrders(
      allHosts.map((h) => (h.id === host?.id ? { ...h, mcpPrompt: { ...h.mcpPrompt, preferHostId: sel } } : h))
    );
    return host?.id ? orders.get(host.id) ?? MCP_ORDER_BASE : (orders.get(sel) ?? MCP_ORDER_BASE) + 1;
  };
  /** 「优先使用」下拉：默认 + 当前分组下的其他会话连接（排除对 MCP 不可见与会成环的） */
  const syncPreferOptions = () => {
    const g = normalizeGroup(groupInput.value);
    const saved = mcpPrefer.value;
    const candidates = allHosts.filter(
      (h) =>
        h.id !== host?.id &&
        normalizeGroup(h.group) === g &&
        normalizeScope(h.scope) !== 'terminal' &&
        !preferChainReaches(allHosts, h.id, host?.id)
    );
    const orders = computeMcpOrders(allHosts);
    mcpPrefer.innerHTML =
      `<option value="">默认（本连接顺序 ${MCP_ORDER_BASE}）</option>` +
      candidates
        .map(
          (h) =>
            `<option value="${escapeHtml(h.id)}">${escapeHtml(h.name)}（顺序 ${orders.get(h.id) ?? MCP_ORDER_BASE}）</option>`
        )
        .join('');
    // 分组切换后原目标可能已不在候选内 → 回落默认
    mcpPrefer.value = candidates.some((h) => h.id === saved) ? saved : '';
  };
  /** 顺序链可视化：被指向的连接在前，本连接顺延（胶囊 + 箭头） */
  const syncOrderNote = () => {
    if (mcpPrefer.disabled) {
      mcpChain.innerHTML = ''; // 终端范围：不参与 MCP 排序
      return;
    }
    const selfName = form.querySelector('[name=name]').value.trim() || (isEdit ? host.name : '当前连接');
    const selfChip = `<span class="mcp-chip self"><span class="mcp-chip-name">${escapeHtml(selfName)}</span><span class="mcp-chip-order">顺序 ${currentMcpOrder()}</span></span>`;
    const sel = mcpPrefer.value;
    if (!sel) {
      mcpChain.innerHTML = `${selfChip}<span class="mcp-chain-hint">未指定优先连接，Agent 按默认选择使用本连接</span>`;
      return;
    }
    const target = allHosts.find((h) => h.id === sel);
    const targetOrder = computeMcpOrders(allHosts).get(sel) ?? MCP_ORDER_BASE;
    mcpChain.innerHTML =
      `<span class="mcp-chip"><span class="mcp-chip-name">${escapeHtml(target?.name ?? sel)}</span><span class="mcp-chip-order">顺序 ${targetOrder}</span></span>` +
      `<span class="mcp-chain-arrow">→</span>` +
      selfChip +
      `<span class="mcp-chain-hint">必须先使用前者，不可用时才轮到本连接</span>`;
  };

  /** 终端提示词：按四个字段拼成可复制给 AI 客户端的约束文本 */
  const buildMcpPromptText = () => {
    const name = form.querySelector('[name=name]').value.trim() || (isEdit ? host.name : '当前会话连接');
    const sel = mcpPrefer.value;
    const target = allHosts.find((h) => h.id === sel);
    const order = currentMcpOrder();
    return [
      `会话连接：${name}`,
      `MCP 使用顺序：${order}`,
      target
        ? `优先使用：必须先使用「${target.name}」（顺序 ${computeMcpOrders(allHosts).get(target.id) ?? MCP_ORDER_BASE}），该连接不可用时才使用本连接（顺序 ${order}）。`
        : '优先使用：默认（由 Agent 判断），本连接顺序 1。',
      `使用场景：${mcpScenario.value.trim() || '（未填写，由 Agent 自行判断）'}`,
      mcpConsent.checked
        ? '使用当前会话连接执行前，必须经用户同意（Agent 需先取得确认再执行）。'
        : '使用当前会话连接无需逐次征求同意（仍受令牌授权范围与命令策略约束）。',
    ].join('\n');
  };
  const refreshPreview = () => {
    mcpPreview.value = mcpScenario.disabled ? '' : buildMcpPromptText();
    syncOrderNote();
  };
  const syncScope = () => {
    const v = normalizeScope(scopeInput.value);
    form.querySelectorAll('.seg-btn[data-scope]').forEach((b) =>
      b.classList.toggle('selected', b.dataset.scope === v)
    );
    scopeNote.textContent = SCOPE_NOTE[v];
    mcpScopeTag.textContent = SCOPE_LABEL[v];
    mcpScopeTag.className = `tag${v === 'mcp' ? ' warn' : ''}`;
    // 终端范围：连接对 MCP 不可见 → 提示词不可配置（本页不提供分组授权与主机授权）
    mcpNoteEl.textContent =
      v === 'terminal'
        ? '终端范围：该连接对 MCP 不可见，AI 侧列不出也调不动，无需配置终端提示词。'
        : '本页按会话连接粒度授权，不提供分组授权与主机授权；令牌侧的授权范围请在「个人设置 → MCP 令牌」配置。';
    const disabled = v === 'terminal';
    mcpFields.forEach((el) => (el.disabled = disabled));
    mcpCopy.disabled = disabled;
    mcpBox.classList.toggle('disabled', disabled);
    refreshPreview();
  };
  form.querySelectorAll('.seg-btn[data-scope]').forEach((btn) =>
    btn.addEventListener('click', () => {
      scopeInput.value = btn.dataset.scope;
      syncScope();
    })
  );
  mcpFields.forEach((el) => el.addEventListener('input', refreshPreview));
  mcpPrefer.addEventListener('change', refreshPreview);
  mcpConsent.addEventListener('change', refreshPreview);
  form.querySelector('[name=name]').addEventListener('input', refreshPreview);
  // 分组变化 → 「优先使用」候选随之变化（仅同分组内可选）
  groupInput.addEventListener('change', () => {
    syncPreferOptions();
    refreshPreview();
  });
  mcpCopy.addEventListener('click', () => {
    const text = mcpPreview.value;
    if (!text) return;
    navigator.clipboard?.writeText(text).then(() => {
      mcpCopy.textContent = '已复制';
      setTimeout(() => (mcpCopy.innerHTML = `${icon('file', 12)} 复制`), 1200);
    });
  });
  // 初始候选与已保存的「优先使用」（目标若已不在候选内则回落默认）
  syncPreferOptions();
  if (mp.preferHostId && [...mcpPrefer.options].some((o) => o.value === mp.preferHostId)) {
    mcpPrefer.value = mp.preferHostId;
  }
  syncScope();

  // —— 连接方式：跳板机模式下显示跳板主机选择（仅直连且已存凭据的主机可作跳板）——
  const viaInput = form.querySelector('[name=connectVia]');
  const jumpSelect = form.querySelector('[name=jumpHostId]');
  const syncVia = () => {
    const isJump = viaInput.value === 'jump';
    form.querySelectorAll('[data-via=jump]').forEach((el) => (el.hidden = !isJump));
  };
  viaInput.addEventListener('change', syncVia);
  {
    const candidates = allHosts.filter(
      (h) => h.id !== host?.id && h.hasSecret && h.authType !== 'none' && (h.connectVia ?? 'direct') === 'direct'
    );
    const current = isEdit ? (host.jumpHostId ?? '') : '';
    jumpSelect.innerHTML = candidates.length
      ? `<option value="" ${current ? '' : 'selected'} disabled>选择作为跳板的主机…</option>` +
        candidates
          .map(
            (h) =>
              `<option value="${escapeHtml(h.id)}" ${h.id === current ? 'selected' : ''}>` +
              `${escapeHtml(h.name)}（${escapeHtml(h.username)}@${escapeHtml(h.host)}:${h.port}）</option>`
          )
          .join('')
      : '<option value="" selected disabled>暂无可用跳板机（需先创建一台已保存凭据的直连主机）</option>';
  }
  syncVia();

  form.querySelector('[name=name]').focus(); // 打开即聚焦首个字段

  m.root.querySelector('#host-form-cancel').addEventListener('click', () => m.close());
  // MCP 授权页底部操作：取消 = 关弹窗；创建/保存与「连接」页同一套提交流程，
  // 但连接必填项未完成时不提交——切回「连接」页签并提示具体缺什么
  m.root.querySelector('#mcp-form-cancel').addEventListener('click', () => m.close());
  m.root.querySelector('#mcp-form-submit').addEventListener('click', () => {
    // 连接页未完成（必填/密钥/地址/端口/跳板）：切回连接页，自定义气泡指到具体字段
    const v = validateConnectFields();
    if (v) {
      switchPane('connect');
      showFieldBubble(v.field, v.err);
      errEl.textContent = v.err;
      return;
    }
    form.requestSubmit(); // 复用连接页提交（含保存状态与成功关弹窗）
  });
  // —— 脚本页：登录后自动执行的命令列表（序号 = 执行顺序，上到下）——
  const scriptsList = m.root.querySelector('#hf-scripts-list');
  const SCRIPT_MAX = 500;
  const renumberScripts = () => {
    scriptsList.querySelectorAll('.hf-script-idx').forEach((el, i) => (el.textContent = i + 1));
  };
  const appendScriptRow = (cmd = '', delaySec = 0) => {
    const row = document.createElement('div');
    row.className = 'hf-script-row';
    row.innerHTML = `
      <span class="hf-script-idx"></span>
      <label class="hf-script-delay${Number(delaySec) > 0 ? ' has-delay' : ''}" title="执行本条命令前等待的秒数（0–60，0 = 立即）">
        ${icon('clock', 13)}<input type="number" class="hf-script-delay-input" min="0" max="60" step="1" value="${Number(delaySec) || 0}" />
        <span>秒后执行</span>
      </label>
      <input type="text" class="pref-input hf-script-cmd" maxlength="${SCRIPT_MAX}" placeholder="例如：df -h" value="${escapeHtml(cmd)}" spellcheck="false" />
      <button type="button" class="icon-btn danger" title="删除本条">${icon('trash', 13)}</button>`;
    // 延迟非 0 时胶囊转主题色强调：一眼看出这条命令会等待
    const delayInput = row.querySelector('.hf-script-delay-input');
    delayInput.addEventListener('input', () => {
      row.querySelector('.hf-script-delay').classList.toggle('has-delay', Number(delayInput.value) > 0);
    });
    row.querySelector('.icon-btn').addEventListener('click', () => {
      row.remove();
      renumberScripts();
    });
    scriptsList.appendChild(row);
    renumberScripts();
    return row;
  };
  m.root.querySelector('#hf-script-add').addEventListener('click', () => {
    appendScriptRow().querySelector('.hf-script-cmd').focus();
  });
  (isEdit && Array.isArray(host.scripts) ? host.scripts : []).forEach((s) =>
    appendScriptRow(typeof s === 'string' ? s : s.command, typeof s === 'string' ? 0 : s.delaySec ?? 0)
  );
  /** 收集脚本：trim + 去空（顺序 = 列表顺序）；每条带执行前延迟秒数 */
  const collectScripts = () => ({
    scripts: [...scriptsList.querySelectorAll('.hf-script-row')]
      .map((row) => ({
        command: row.querySelector('.hf-script-cmd').value.trim(),
        delaySec: Math.max(0, Math.min(60, Math.floor(Number(row.querySelector('.hf-script-delay-input').value) || 0))),
      }))
      .filter((s) => s.command),
  });
  m.root.querySelector('#scripts-form-cancel').addEventListener('click', () => m.close());
  m.root.querySelector('#scripts-form-submit').addEventListener('click', () => {
    // 与 MCP 页一致：连接页未完成时切回并提示具体缺什么
    const v = validateConnectFields();
    if (v) {
      switchPane('connect');
      showFieldBubble(v.field, v.err);
      errEl.textContent = v.err;
      return;
    }
    form.requestSubmit();
  });
  // —— 高级页：连接级会话参数 ——
  const idleSel = m.root.querySelector('#hf-idle-timeout');
  const connSel = m.root.querySelector('#hf-conn-timeout');
  const detachSel = m.root.querySelector('#hf-detach-ttl');
  const termSel = m.root.querySelector('#hf-term-type');
  const autoReconnectEl = m.root.querySelector('#hf-auto-reconnect');
  const startDirInput = m.root.querySelector('#hf-start-dir');
  const envInput = m.root.querySelector('#hf-env');
  const auditOutputSel = m.root.querySelector('#hf-audit-output');
  const blockedInput = m.root.querySelector('#hf-blocked-cmds');
  if (isEdit && host.session) {
    idleSel.value = String(host.session.idleTimeoutMs ?? '');
    connSel.value = String(host.session.connectTimeoutMs ?? '');
    detachSel.value = String(host.session.detachedTtlMs ?? '');
    termSel.value = host.session.termType ?? '';
    autoReconnectEl.checked = host.session.autoReconnect === true;
    startDirInput.value = host.session.startDirectory ?? '';
    envInput.value = host.session.env ?? '';
    auditOutputSel.value = host.session.auditOutput ?? '';
    blockedInput.value = Array.isArray(host.session.blockedCommands) ? host.session.blockedCommands.join('\n') : '';
  }
  /** 收集高级页配置：null 字段 = 跟随全局；全空整体为 null */
  const collectSessionCfg = () => {
    const idle = idleSel.value ? Number(idleSel.value) : null;
    const conn = connSel.value ? Number(connSel.value) : null;
    const detach = detachSel.value ? Number(detachSel.value) : null;
    const term = termSel.value || null;
    const auto = autoReconnectEl.checked || null;
    const dir = startDirInput.value.trim() || null;
    const env = envInput.value.trim() || null;
    const auditOut = auditOutputSel.value || null;
    const blocked = blockedInput.value
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const cfg = {
      idleTimeoutMs: idle,
      connectTimeoutMs: conn,
      detachedTtlMs: detach,
      termType: term,
      autoReconnect: auto,
      startDirectory: dir,
      env,
      auditOutput: auditOut,
      blockedCommands: blocked.length ? blocked : null,
    };
    return Object.values(cfg).every((v) => v == null) ? null : cfg;
  };
  m.root.querySelector('#advanced-form-cancel').addEventListener('click', () => m.close());
  m.root.querySelector('#advanced-form-submit').addEventListener('click', () => {
    const v = validateConnectFields();
    if (v) {
      switchPane('connect');
      showFieldBubble(v.field, v.err);
      errEl.textContent = v.err;
      return;
    }
    form.requestSubmit();
  });
  const submitBtn = form.querySelector('[type=submit]');
  const errEl = form.querySelector('.hf-error');

  // —— 私钥文件导入：本地文件 / 飞牛 NAS 浏览 / 拖拽 ——
  let keyPem = null;
  const keyDrop = form.querySelector('#key-drop');
  const keyFile = form.querySelector('#key-file');
  const keySelected = form.querySelector('#key-selected');
  const setKey = (name, pem) => {
    keyPem = pem;
    form.querySelector('#key-name').textContent = name;
    form.querySelector('#key-size').textContent = `${(new Blob([pem]).size / 1024).toFixed(1)} KB`;
    keySelected.hidden = false;
    keyDrop.hidden = true;
    errEl.textContent = '';
  };
  const clearKey = () => {
    keyPem = null;
    keyFile.value = '';
    keySelected.hidden = true;
    keyDrop.hidden = false;
  };
  const KEY_HEADER_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
  const readKeyFile = (file) => {
    if (!file) return;
    if (file.size > 256 * 1024) {
      errEl.textContent = '文件超过 256KB，不是有效的私钥';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '');
      if (!KEY_HEADER_RE.test(text)) {
        errEl.textContent = '文件内容不是 PEM 格式的私钥（缺少 PRIVATE KEY 头）';
        return;
      }
      setKey(file.name, text);
    };
    reader.onerror = () => (errEl.textContent = '文件读取失败');
    reader.readAsText(file);
  };
  form.querySelector('#key-local').addEventListener('click', () => keyFile.click());
  keyFile.addEventListener('change', () => readKeyFile(keyFile.files[0]));
  form.querySelector('#key-remove').addEventListener('click', clearKey);
  // 拖拽导入
  keyDrop.addEventListener('dragover', (e) => {
    e.preventDefault();
    keyDrop.classList.add('dragover');
  });
  keyDrop.addEventListener('dragleave', () => keyDrop.classList.remove('dragover'));
  keyDrop.addEventListener('drop', (e) => {
    e.preventDefault();
    keyDrop.classList.remove('dragover');
    readKeyFile(e.dataTransfer?.files?.[0]);
  });
  // 「从飞牛导入」仅 fnOS 模式可见（/api/runtime 判定，结果缓存）
  getRuntime().then(({ mode }) => {
    if (mode !== 'fnos') return;
    const btn = form.querySelector('#key-fnos');
    btn.hidden = false;
    btn.addEventListener('click', () => openNasKeyPicker((name, pem) => setKey(name, pem)));
  });

  /** 连接页字段校验（含必填）：返回 {err, field} 或 null。
   *  连接页与 MCP 授权页共用——MCP 页提交前先跑同一套校验，未完成时切回连接页提示 */
  const validateConnectFields = () => {
    // 必填：名称 / 用户名 / 地址（form 已 novalidate，原生气泡由自定义气泡替代）
    for (const [n, label] of [['name', '名称'], ['username', '用户名'], ['host', '地址']]) {
      const el = form.querySelector(`[name=${n}]`);
      if (!el.value.trim()) return { err: `请填写${label}`, field: el };
    }
    // 新建密钥认证必须先导入私钥（编辑态不导入 = 保持原私钥）
    if (authInput.value === 'privateKey' && !keyPem && !isEdit) {
      return { err: '请导入私钥文件（本地或从飞牛）', field: keyDrop };
    }
    // —— 地址校验：合法 IPv4 / IPv6 / 域名 ——
    const rawHost = form.querySelector('[name=host]').value.trim();
    {
      // 纯数字四段 = 用户意图是 IPv4：强制逐段校验 0–255，不再落入域名分支放行（如 256.1.1.1）
      const looksLikeIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(rawHost);
      const isV4 = looksLikeIp && rawHost.split('.').every((s) => Number(s) >= 0 && Number(s) <= 255);
      const isV6 = rawHost.includes(':') && /^[0-9a-fA-F:]+$/.test(rawHost);
      // 域名：点分结构（≥2 段），段内 1–63 字符（字母数字 - _，不首尾连字符），TLD 非纯数字；localhost 特例
      const segs = rawHost.split('.');
      const isDomain =
        !looksLikeIp &&
        (rawHost === 'localhost' ||
          (segs.length >= 2 &&
            /^[A-Za-z0-9_-]{1,63}(\.[A-Za-z0-9_-]{1,63})+$/.test(rawHost) &&
            !/^\d+$/.test(segs[segs.length - 1]) &&
            segs.every((s) => !s.startsWith('-') && !s.endsWith('-'))));
      if (!rawHost || (!isV4 && !isV6 && !isDomain)) {
        return {
          err: looksLikeIp
            ? 'IP 地址格式不正确（每段必须为 0–255）'
            : '地址必须是合法的 IP 或域名（如 192.168.1.1、example.com）',
          field: form.querySelector('[name=host]'),
        };
      }
    }
    // —— 端口校验：1–65535 整数（number input 的 min/max 在 preventDefault 提交下不生效） ——
    const rawPort = String(form.querySelector('[name=port]').value ?? '').trim();
    const port = rawPort === '' ? 22 : Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { err: '端口必须为 1–65535 的整数', field: form.querySelector('[name=port]') };
    }
    // —— 跳板机模式必须选定跳板主机 ——
    if (viaInput.value === 'jump' && !jumpSelect.value) {
      return { err: '请选择作为跳板的主机', field: jumpSelect };
    }
    return null;
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';
    const v = validateConnectFields();
    if (v) {
      showFieldBubble(v.field, v.err);
      errEl.textContent = v.err;
      return;
    }
    const rawHost = form.querySelector('[name=host]').value.trim();
    const rawPort = String(form.querySelector('[name=port]').value ?? '').trim();
    const port = rawPort === '' ? 22 : Number(rawPort);
    submitBtn.disabled = true;
    submitBtn.textContent = isEdit ? '保存中…' : '创建中…';
    const fd = new FormData(form);
    const body = {
      name: fd.get('name').trim(),
      host: rawHost,
      port,
      username: fd.get('username').trim(),
      group: fd.get('group'),
      authType: fd.get('authType'),
      connectVia: fd.get('connectVia'),
      // 主机级二次认证：开关状态（开启前提：全局 2FA验证 已绑定，服务端同样强制）
      requireTwofa: twofaSwitch.checked,
      // 登录后自动执行脚本（脚本页收集，顺序 = 列表顺序；空数组 = 清空）
      scripts: collectScripts().scripts,
      // 连接级会话参数（高级页收集；null = 全部跟随全局）
      session: collectSessionCfg(),
      // 授权范围（全选/终端/MCP）+ MCP 终端提示词（终端范围不携带）
      scope: normalizeScope(fd.get('scope')),
      mcpPrompt:
        normalizeScope(fd.get('scope')) === 'terminal'
          ? null
          : {
              preferHostId: mcpPrefer.value || null,
              scenario: mcpScenario.value.trim(),
              requireConsent: mcpConsent.checked,
            },
    };
    // 跳板机模式必须选定跳板主机（校验已在 validateConnectFields 完成）
    if (body.connectVia === 'jump') body.jumpHostId = fd.get('jumpHostId');
    const pw = fd.get('password');
    if (body.authType === 'password' && pw) body.password = pw;
    if (body.authType === 'privateKey' && keyPem) body.privateKey = keyPem;

    // 「仅 MCP」范围：终端入口已关闭，创建/编辑是唯一变更入口 → 走 2FA 保护请求（自动弹码验证）
    const path = isEdit ? `hosts/${encodeURIComponent(host.id)}` : 'hosts';
    const req = {
      method: isEdit ? 'PUT' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    };
    const res = body.scope === 'mcp'
      ? await apiFetch(path, { ...req, forcePrompt: true })
      : (body.requireTwofa === true && (isEdit ? host.requireTwofa !== true : true))
        // 开启「连接二次认证」属安全敏感变更（新建即开/存量打开）：同样走 2FA 保护请求
        ? await apiFetch(path, { ...req, forcePrompt: true })
        : await fetch(apiUrl(path), req);
    if (res._twofaCancelled) {
      // 用户取消验证：静默放弃（不弹「保存失败」）
      submitBtn.disabled = false;
      submitBtn.textContent = isEdit ? '保存' : '创建';
      return;
    }
    if (res.ok) {
      m.close();
      onSaved?.();
    } else {
      const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
      switchPane('connect'); // 从 MCP 页提交时错误显示在连接页操作栏，切回保证可见
      errEl.textContent = `保存失败：${err.error?.message ?? '未知错误'}`;
      submitBtn.disabled = false;
      submitBtn.textContent = isEdit ? '保存' : '创建';
    }
  });
  return m;
}

/**
 * 从飞牛导入私钥：NAS 文件浏览弹窗（仅 fnOS 模式，服务端限制 /vol*、/home 根）。
 * 目录导航（面包屑 + 点击下钻），点击文件即读取校验（PEM）后回填。
 * @param {(name: string, pem: string) => void} onPick 选中回调
 */
function openNasKeyPicker(onPick) {
  const m = openModal(`
    <div class="nfs">
      <div class="nfs-crumbs" id="nfs-crumbs"></div>
      <div class="nfs-list" id="nfs-list"></div>
      <div class="nfs-status" id="nfs-status"></div>
    </div>`);
  m.root.classList.add('nfs-modal');
  m.setTitle('从飞牛导入私钥');
  const crumbsEl = m.root.querySelector('#nfs-crumbs');
  const listEl = m.root.querySelector('#nfs-list');
  const statusEl = m.root.querySelector('#nfs-status');
  let segs = []; // 当前路径段（如 ['vol1','Users','admin']）

  function renderCrumbs() {
    crumbsEl.innerHTML =
      `<button class="nfs-crumb" data-i="-1">${icon('nas', 13)} 存储</button>` +
      segs
        .map(
          (s, i) =>
            `${icon('chevron', 10)}<button class="nfs-crumb" data-i="${i}">${escapeHtml(s)}</button>`
        )
        .join('');
  }

  async function load() {
    const path = segs.length ? `/${segs.join('/')}` : '';
    renderCrumbs();
    statusEl.textContent = '加载中…';
    listEl.innerHTML = '';
    try {
      const res = await fetch(apiUrl(`fs/list?path=${encodeURIComponent(path)}`));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message ?? '加载失败');
      statusEl.textContent = data.entries.length ? '' : '空目录';
      listEl.innerHTML = data.entries
        .map(
          (e) => `<button class="nfs-item" data-name="${escapeHtml(e.name)}" data-type="${e.type}">
            ${icon(e.type === 'dir' ? 'folder' : 'file', 14)}
            <span class="nfs-name">${escapeHtml(e.name)}</span>
            ${e.type === 'dir' ? icon('chevron', 12) : ''}
          </button>`
        )
        .join('');
    } catch (err) {
      statusEl.textContent = err.message ?? '加载失败';
    }
  }

  async function pick(name) {
    statusEl.textContent = '读取中…';
    try {
      const res = await fetch(apiUrl('fs/read-key'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: `/${[...segs, name].join('/')}` }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message ?? '读取失败');
      m.close();
      onPick(data.name, data.content);
    } catch (err) {
      statusEl.textContent = err.message ?? '读取失败';
    }
  }

  crumbsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.nfs-crumb');
    if (!b) return;
    const i = Number(b.dataset.i);
    segs = i < 0 ? [] : segs.slice(0, i + 1);
    load();
  });
  listEl.addEventListener('click', (e) => {
    const b = e.target.closest('.nfs-item');
    if (!b) return;
    if (b.dataset.type === 'dir') {
      segs.push(b.dataset.name);
      load();
    } else {
      pick(b.dataset.name);
    }
  });
  load();
}

/** 字段校验气泡（替代浏览器原生「请填写此字段」）：红色描边 + 浮泡，
 *  fixed 定位挂 body（面板 overflow 不裁剪）；上方放不下自动翻到字段下方；
 *  输入即消 / 3.5s 自动消；同一时间只保留一个气泡 */
function showFieldBubble(field, msg) {
  document.querySelectorAll('.field-bubble').forEach((b) => b.remove());
  document.querySelectorAll('.field-invalid').forEach((el) => el.classList.remove('field-invalid'));
  if (!field) return;
  field.classList.add('field-invalid');
  field.focus(); // 先聚焦（可能触发面板滚动），再按最终位置测量
  const bubble = document.createElement('div');
  bubble.className = 'field-bubble';
  bubble.textContent = msg;
  document.body.appendChild(bubble);
  const r = field.getBoundingClientRect();
  bubble.style.left = `${Math.min(r.left + 12, window.innerWidth - bubble.offsetWidth - 8)}px`;
  const top = r.top - bubble.offsetHeight - 8;
  if (top < 8) {
    bubble.style.top = `${r.bottom + 8}px`;
    bubble.classList.add('below');
  } else {
    bubble.style.top = `${top}px`;
  }
  const clear = () => {
    bubble.remove();
    field.classList.remove('field-invalid');
    field.removeEventListener('input', clear);
    field.removeEventListener('change', clear);
  };
  field.addEventListener('input', clear);
  field.addEventListener('change', clear); // select 无 input 事件
  setTimeout(clear, 3500);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

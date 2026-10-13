// 左侧会话连接列表 + 表单弹窗（FR-044/055：左栏展示已保存的会话连接；表单走弹窗）
import { openModal } from './modal.js';
import { showContextMenu } from './contextmenu.js';
import { apiUrl } from './base.js';
import { icon } from './icons.js';

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

  if (!hosts.length) {
    container.innerHTML =
      '<div class="sidebar-empty">暂无会话连接<br/>点击右上角「新增」或右键新建</div>';
  }
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

  container.innerHTML = sortedGroups
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
                (h) => `<div class="host-item ${connected.has(h.id) ? 'connected' : ''}" data-id="${escapeHtml(h.id)}">
                <div class="host-main">
                  <span class="host-name">${escapeHtml(h.name)}</span>
                  <span class="host-meta">${escapeHtml(h.username)}@${escapeHtml(h.host)}:${h.port} · ${h.authType === 'password' ? '密码' : '密钥'}</span>
                </div>
                <span class="host-actions">
                  ${hostBadge(h)}
                  <button class="icon-btn act-connect" title="连接终端">${icon('play', 13)}</button>
                  <button class="icon-btn act-edit" title="编辑">${icon('pencil', 13)}</button>
                  <button class="icon-btn danger act-delete" title="删除">${icon('trash', 13)}</button>
                </span>
              </div>`
              )
              .join('')}
          </div>
        </div>
      </div>`
    )
    .join('');

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
    // 主条目点击 = 连接（每次新建一个会话卡）
    item.addEventListener('click', () => onConnect(host));
    // FR-055：会话连接右键菜单
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, {
        meta: `${host.name}`,
        items: [
          { label: '连接', onClick: () => onConnect(host) },
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
    });
    item.querySelector('.act-edit').addEventListener('click', (e) => {
      e.stopPropagation();
      openHostFormModal(host, onChanged);
    });
    item.querySelector('.act-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`确定删除「${host.name}」？其凭据将一并删除。`)) return;
      await fetch(apiUrl(`hosts/${encodeURIComponent(host.id)}`), { method: 'DELETE' });
      onChanged();
    });
    const cf = item.querySelector('.act-confirm-fp');
    if (cf) {
      cf.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmFingerprintModal(host);
        if (ok) onChanged();
      });
    }
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

function hostBadge(h) {
  if (h.fingerprintConfirmed) return '';
  if (h.pendingFingerprint) {
    return `<button class="icon-btn act-confirm-fp" title="确认指纹 ${escapeHtml(h.pendingFingerprint)}" style="color: var(--warn)">${icon('key', 13)}</button>`;
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
  const m = openModal(
    `<form id="host-form" class="host-form">
      <label>名称 <input name="name" required maxlength="64" value="${isEdit ? escapeHtml(host.name) : ''}" /></label>
      <label>地址 <input name="host" required placeholder="域名或 IP" value="${isEdit ? escapeHtml(host.host) : ''}" /></label>
      <label>端口 <input name="port" type="number" min="1" max="65535" value="${isEdit ? host.port : 22}" /></label>
      <label>用户名 <input name="username" required value="${isEdit ? escapeHtml(host.username) : ''}" /></label>
      <label>分组
        <select name="group">
          ${groupOptions
            .map((g) => `<option value="${escapeHtml(g)}" ${g === currentGroup ? 'selected' : ''}>${escapeHtml(g)}</option>`)
            .join('')}
        </select>
      </label>
      <label>认证方式
        <div class="seg" role="radiogroup">
          <button type="button" class="seg-btn ${!isEdit || host.authType === 'password' ? 'selected' : ''}" data-value="password">${icon('key', 13)} 密码</button>
          <button type="button" class="seg-btn ${isEdit && host.authType === 'privateKey' ? 'selected' : ''}" data-value="privateKey">${icon('file', 13)} 密钥</button>
        </div>
        <input type="hidden" name="authType" value="${isEdit ? host.authType : 'password'}" />
      </label>
      <label data-cred="password">密码 <input name="password" type="password" autocomplete="new-password" placeholder="${isEdit ? '留空保持不变' : ''}" /></label>
      <label data-cred="privateKey" hidden>密钥（PEM） <textarea name="privateKey" rows="4" placeholder="${isEdit ? '留空保持不变' : '-----BEGIN OPENSSH PRIVATE KEY-----'}"></textarea></label>
      <label data-cred="privateKey" hidden>密钥口令（可选） <input name="passphrase" type="password" autocomplete="new-password" /></label>
      <p class="form-note">${isEdit ? '凭据留空表示保持原凭据不变。' : '凭据将以 AES-256-GCM 加密保存，不会明文显示。'}</p>
      <div class="form-actions">
        <button type="submit" class="btn primary">${isEdit ? '保存' : '创建'}</button>
        <button type="button" class="btn" id="host-form-cancel">取消</button>
      </div>
    </form>`
  );
  m.setTitle(isEdit ? `编辑：${host.name}` : '新建会话连接');

  const form = m.root.querySelector('#host-form');
  const authInput = form.querySelector('[name=authType]');
  // FR-050：认证方式切换时仅显示对应凭据框（分段选择器）
  const syncCred = () => {
    const v = authInput.value;
    form.querySelector('[data-cred=password]').hidden = v !== 'password';
    form.querySelectorAll('[data-cred=privateKey]').forEach((l) => (l.hidden = v !== 'privateKey'));
    form.querySelectorAll('.seg-btn').forEach((b) =>
      b.classList.toggle('selected', b.dataset.value === v)
    );
  };
  form.querySelectorAll('.seg-btn').forEach((btn) =>
    btn.addEventListener('click', () => {
      authInput.value = btn.dataset.value;
      syncCred();
    })
  );
  syncCred();

  m.root.querySelector('#host-form-cancel').addEventListener('click', () => m.close());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = {
      name: fd.get('name').trim(),
      host: fd.get('host').trim(),
      port: Number(fd.get('port')) || 22,
      username: fd.get('username').trim(),
      group: fd.get('group'),
      authType: fd.get('authType'),
    };
    const pw = fd.get('password');
    const key = fd.get('privateKey');
    if (body.authType === 'password' && pw) body.password = pw;
    if (body.authType === 'privateKey' && key) {
      body.privateKey = key;
      if (fd.get('passphrase')) body.passphrase = fd.get('passphrase');
    }

    const res = await fetch(isEdit ? apiUrl(`hosts/${encodeURIComponent(host.id)}`) : apiUrl('hosts'), {
      method: isEdit ? 'PUT' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      m.close();
      onSaved?.();
    } else {
      const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
      alert(`保存失败：${err.error?.message ?? '未知错误'}`);
    }
  });
  return m;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

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
    const g = h.group ?? '默认';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(h);
  }
  const collapsed = loadCollapsedGroups();
  // 分组按名称排序置顶；组内主机按名称排序（竖状树形 + 可折叠）
  const sortedGroups = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'));
  for (const [, list] of sortedGroups) list.sort((a, b) => a.name.localeCompare(b.name, 'zh'));

  container.innerHTML = sortedGroups
    .map(
      ([g, list]) => `
      <div class="side-group ${collapsed.has(g) ? 'collapsed' : ''}" data-group="${escapeHtml(g)}">
        <button class="side-group-head" title="点击展开/折叠">
          <span class="group-chevron">▾</span>
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
      if (collapsed.has(g)) collapsed.delete(g);
      else collapsed.add(g);
      saveCollapsedGroups(collapsed);
      groupEl.classList.toggle('collapsed');
    });
  });

  container.querySelectorAll('.host-item').forEach((item) => {
    const host = hosts.find((h) => h.id === item.dataset.id);
    if (!host) return;
    // 主条目点击 = 连接（已连接则激活对应 tab）
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
              await fetch(apiUrl(`hosts/${host.id}/duplicate`), { method: 'POST' });
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
              await fetch(apiUrl(`hosts/${host.id}`), { method: 'DELETE' });
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
      await fetch(apiUrl(`hosts/${host.id}`), { method: 'DELETE' });
      onChanged();
    });
    const cf = item.querySelector('.act-confirm-fp');
    if (cf) {
      cf.addEventListener('click', async (e) => {
        e.stopPropagation();
        await confirmFingerprint(host, onChanged);
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

/** 分组折叠状态（FR-054）：localStorage 持久化 */
const COLLAPSE_KEY = 'webssh-collapsed-groups';
function loadCollapsedGroups() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}
function saveCollapsedGroups(set) {
  localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set]));
}

function hostBadge(h) {
  if (h.fingerprintConfirmed) return '';
  if (h.pendingFingerprint) {
    return `<button class="icon-btn act-confirm-fp" title="确认指纹 ${escapeHtml(h.pendingFingerprint)}" style="color: var(--warn)">${icon('key', 13)}</button>`;
  }
  return '<span class="tag" title="首次连接需确认指纹">待确认</span>';
}

async function confirmFingerprint(host, onChanged) {
  if (!host.pendingFingerprint) return;
  if (
    !confirm(
      `确认以下指纹属于 ${host.host}:${host.port} ？\n\n${host.pendingFingerprint}\n\n请与目标主机管理员核对（如 ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub）。`
    )
  )
    return;
  const res = await fetch(apiUrl(`hosts/${host.id}/verify-hostkey`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fingerprint: host.pendingFingerprint }),
  });
  if (res.ok) onChanged();
  else alert('确认失败');
}

/**
 * 新增/编辑主机弹窗（凭据留空 = 保持不变，FR-005）
 */
export function openHostFormModal(host, onSaved) {
  const isEdit = Boolean(host);
  const m = openModal(
    `<form id="host-form" class="host-form">
      <label>名称 <input name="name" required maxlength="64" value="${isEdit ? escapeHtml(host.name) : ''}" /></label>
      <label>地址 <input name="host" required placeholder="域名或 IP" value="${isEdit ? escapeHtml(host.host) : ''}" /></label>
      <label>端口 <input name="port" type="number" min="1" max="65535" value="${isEdit ? host.port : 22}" /></label>
      <label>用户名 <input name="username" required value="${isEdit ? escapeHtml(host.username) : ''}" /></label>
      <label>分组 <input name="group" placeholder="可选" value="${isEdit ? escapeHtml(host.group ?? '') : ''}" /></label>
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
      group: fd.get('group').trim() || null,
      authType: fd.get('authType'),
    };
    const pw = fd.get('password');
    const key = fd.get('privateKey');
    if (body.authType === 'password' && pw) body.password = pw;
    if (body.authType === 'privateKey' && key) {
      body.privateKey = key;
      if (fd.get('passphrase')) body.passphrase = fd.get('passphrase');
    }

    const res = await fetch(isEdit ? apiUrl(`hosts/${host.id}`) : apiUrl('hosts'), {
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

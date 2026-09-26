// 主机侧栏列表 + 表单弹窗（FR-044：主机管理在左侧栏；表单走弹窗）
import { openModal } from './modal.js';

export async function fetchHosts() {
  try {
    const res = await fetch('/api/hosts');
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
    container.innerHTML = '<div class="sidebar-empty">暂无主机<br/>点击右上角「＋」添加</div>';
    return;
  }
  const connected = new Set(connectedIds);
  const groups = new Map();
  for (const h of hosts) {
    const g = h.group ?? '默认';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(h);
  }
  container.innerHTML =
    [...groups.entries()]
      .map(
        ([g, list]) =>
          `<div class="sidebar-group-title">${escapeHtml(g)}</div>` +
          list
            .map(
              (h) => `<div class="host-item ${connected.has(h.id) ? 'connected' : ''}" data-id="${escapeHtml(h.id)}">
              <div class="host-main">
                <span class="host-name">${escapeHtml(h.name)}</span>
                <span class="host-meta">${escapeHtml(h.username)}@${escapeHtml(h.host)}:${h.port}</span>
              </div>
              <span class="host-actions">
                ${hostBadge(h)}
                <button class="icon-btn act-connect" title="连接终端">▶</button>
                <button class="icon-btn act-edit" title="编辑">✎</button>
                <button class="icon-btn danger act-delete" title="删除">🗑</button>
              </span>
            </div>`
            )
            .join('')
      )
      .join('');

  container.querySelectorAll('.host-item').forEach((item) => {
    const host = hosts.find((h) => h.id === item.dataset.id);
    if (!host) return;
    // 主条目点击 = 连接（已连接则激活对应 tab）
    item.addEventListener('click', () => onConnect(host));
    item.querySelector('.act-edit').addEventListener('click', (e) => {
      e.stopPropagation();
      openHostFormModal(host, onChanged);
    });
    item.querySelector('.act-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`确定删除「${host.name}」？其凭据将一并删除。`)) return;
      await fetch(`/api/hosts/${host.id}`, { method: 'DELETE' });
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
}

function hostBadge(h) {
  if (h.fingerprintConfirmed) return '';
  if (h.pendingFingerprint) {
    return `<button class="icon-btn act-confirm-fp" title="确认指纹 ${escapeHtml(h.pendingFingerprint)}" style="color: var(--warn)">🔑</button>`;
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
  const res = await fetch(`/api/hosts/${host.id}/verify-hostkey`, {
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
        <select name="authType">
          <option value="password" ${isEdit && host.authType === 'password' ? 'selected' : ''}>口令</option>
          <option value="privateKey" ${isEdit && host.authType === 'privateKey' ? 'selected' : ''}>私钥</option>
        </select>
      </label>
      <label data-cred="password">口令 <input name="password" type="password" autocomplete="new-password" placeholder="${isEdit ? '留空保持不变' : ''}" /></label>
      <label data-cred="privateKey" hidden>私钥（PEM） <textarea name="privateKey" rows="4" placeholder="${isEdit ? '留空保持不变' : '-----BEGIN OPENSSH PRIVATE KEY-----'}"></textarea></label>
      <label data-cred="privateKey" hidden>私钥口令（可选） <input name="passphrase" type="password" autocomplete="new-password" /></label>
      <p class="form-note">${isEdit ? '凭据留空表示保持原凭据不变。' : '凭据将以 AES-256-GCM 加密保存，不会明文显示。'}</p>
      <div class="form-actions">
        <button type="submit" class="btn primary">${isEdit ? '保存' : '创建'}</button>
        <button type="button" class="btn" id="host-form-cancel">取消</button>
      </div>
    </form>`
  );
  m.setTitle(isEdit ? `编辑：${host.name}` : '新增主机');

  const form = m.root.querySelector('#host-form');
  const authSelect = form.querySelector('[name=authType]');
  const syncCred = () => {
    form.querySelector('[data-cred=password]').hidden = authSelect.value !== 'password';
    form.querySelector('[data-cred=privateKey]').hidden = authSelect.value !== 'privateKey';
    form.querySelector('[data-cred=privateKey]').hidden =
      form.querySelector('[data-cred=privateKey]').hidden || false;
    // 第二个 privateKey 标签（口令）跟随
    const labels = form.querySelectorAll('[data-cred=privateKey]');
    labels.forEach((l) => (l.hidden = authSelect.value !== 'privateKey'));
  };
  authSelect.addEventListener('change', syncCred);
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

    const res = await fetch(isEdit ? `/api/hosts/${host.id}` : '/api/hosts', {
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

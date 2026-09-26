// 主机管理页（US2）：列表 / 新增 / 编辑 / 删除 / 分组 / 指纹确认
// 凭据永不回显：编辑时凭据留空表示保持不变（FR-005）

export async function render(el) {
  const hosts = await loadHosts();
  el.innerHTML = `
    <div class="hosts-page">
      <div class="hosts-toolbar">
        <span id="hosts-count"></span>
        <button id="host-add" class="primary">＋ 新增主机</button>
      </div>
      <div id="host-list"></div>
      <div id="host-form-wrap"></div>
    </div>`;
  renderList(el, hosts);
  el.querySelector('#host-add').addEventListener('click', () => showForm(el, null));
}

async function loadHosts() {
  try {
    const res = await fetch('/api/hosts');
    if (res.ok) return await res.json();
  } catch {
    /* 网络异常 */
  }
  return [];
}

function renderList(el, hosts) {
  el.querySelector('#hosts-count').textContent = `共 ${hosts.length} 台`;
  const list = el.querySelector('#host-list');
  if (!hosts.length) {
    list.innerHTML = '<div class="placeholder">还没有主机，点击右上角「新增主机」开始。</div>';
    return;
  }
  const groups = new Map();
  for (const h of hosts) {
    const g = h.group ?? '默认';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(h);
  }
  list.innerHTML = [...groups.entries()]
    .map(
      ([g, items]) => `<div class="host-group">
        <div class="host-group-title">${escapeHtml(g)}</div>
        ${items.map((h) => hostRow(h)).join('')}
      </div>`
    )
    .join('');

  list.querySelectorAll('[data-action]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const id = btn.closest('[data-id]').dataset.id;
      const host = hosts.find((h) => h.id === id);
      const action = btn.dataset.action;
      if (action === 'edit') showForm(el, host);
      if (action === 'delete') await deleteHost(el, host);
      if (action === 'confirm-fp') await confirmFingerprint(el, host);
    })
  );
}

function hostRow(h) {
  return `
    <div class="host-row" data-id="${escapeHtml(h.id)}">
      <div class="host-row-main">
        <span class="host-name">${escapeHtml(h.name)}</span>
        <span class="host-meta">${escapeHtml(h.username)}@${escapeHtml(h.host)}:${h.port} · ${h.authType === 'password' ? '口令' : '私钥'}</span>
      </div>
      <div class="host-row-actions">
        ${
          h.fingerprintConfirmed
            ? '<span class="tag ok">指纹已确认</span>'
            : h.pendingFingerprint
              ? `<span class="tag warn">待确认 ${escapeHtml(h.pendingFingerprint.slice(0, 22))}…</span>
                 <button data-action="confirm-fp" title="确认该指纹属于目标主机">确认指纹</button>`
              : '<span class="tag">指纹未确认</span>'
        }
        <button data-action="edit">编辑</button>
        <button data-action="delete" class="danger">删除</button>
      </div>
    </div>`;
}

function showForm(el, host) {
  const wrap = el.querySelector('#host-form-wrap');
  const isEdit = Boolean(host);
  wrap.innerHTML = `
    <form id="host-form" class="host-form">
      <h3>${isEdit ? `编辑：${escapeHtml(host.name)}` : '新增主机'}</h3>
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
        <button type="submit" class="primary">${isEdit ? '保存' : '创建'}</button>
        <button type="button" id="host-form-cancel">取消</button>
      </div>
    </form>`;

  const form = wrap.querySelector('#host-form');
  const authSelect = form.querySelector('[name=authType]');
  const syncCred = () => {
    form.querySelector('[data-cred=password]').hidden = authSelect.value !== 'password';
    form.querySelector('[data-cred=privateKey]').hidden = authSelect.value !== 'privateKey';
  };
  authSelect.addEventListener('change', syncCred);
  syncCred();

  wrap.querySelector('#host-form-cancel').addEventListener('click', () => (wrap.innerHTML = ''));
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
      wrap.innerHTML = '';
      render(el);
    } else {
      const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
      alert(`保存失败：${err.error?.message ?? '未知错误'}`);
    }
  });
}

async function deleteHost(el, host) {
  if (!confirm(`确定删除「${host.name}」？其凭据将一并删除。`)) return;
  await fetch(`/api/hosts/${host.id}`, { method: 'DELETE' });
  render(el);
}

async function confirmFingerprint(el, host) {
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
  if (res.ok) render(el);
  else alert('确认失败');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

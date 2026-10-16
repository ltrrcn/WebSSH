// 左侧会话连接列表 + 表单弹窗（FR-044/055：左栏展示已保存的会话连接；表单走弹窗）
import { openModal } from './modal.js';
import { showContextMenu } from './contextmenu.js';
import { apiUrl, getRuntime } from './base.js';
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
                  <span class="host-meta">${escapeHtml(h.username)}@${escapeHtml(h.host)}:${h.port} · ${{ password: '密码', privateKey: '密钥', none: '每次输入' }[h.authType] ?? h.authType}</span>
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
  // 左侧菜单：连接承载表单；脚本/隧道/高级为规划中的占位面板
  const NAV = [
    { key: 'connect', label: '连接', icon: 'terminal' },
    { key: 'scripts', label: '脚本', icon: 'code', soon: '登录后自动执行的命令脚本' },
    { key: 'tunnels', label: '隧道', icon: 'tunnel', soon: '本地 / 远程端口转发' },
    { key: 'advanced', label: '高级', icon: 'sliders', soon: '连接参数与高级选项' },
  ];
  const m = openModal(
    `<nav class="sp-nav">${NAV.map(
      (n, i) => `<button type="button" class="sp-nav-item${i === 0 ? ' active' : ''}" data-pane="${n.key}">${icon(n.icon, 15)}<span>${n.label}</span></button>`
    ).join('')}</nav>
    <div class="sp-panes">
      <section class="sp-pane active" data-pane="connect">
        <form id="host-form" class="host-form">
      <div class="hf-row">
        <label>名称 <input name="name" required maxlength="64" placeholder="例如：生产服务器" value="${isEdit ? escapeHtml(host.name) : ''}" /></label>
        <label>用户名 <input name="username" required placeholder="root" value="${isEdit ? escapeHtml(host.username) : ''}" /></label>
      </div>
      <div class="hf-row">
        <label class="hf-via">连接方式
          <select name="connectVia">
            <option value="direct" ${!isEdit || (host.connectVia ?? 'direct') === 'direct' ? 'selected' : ''}>直连（默认）</option>
            <option value="jump" ${isEdit && host.connectVia === 'jump' ? 'selected' : ''}>跳板机</option>
            <option value="tunnel" disabled>隧道（后续加入）</option>
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
      <label>分组
        <select name="group">
          ${groupOptions
            .map((g) => `<option value="${escapeHtml(g)}" ${g === currentGroup ? 'selected' : ''}>${escapeHtml(g)}</option>`)
            .join('')}
        </select>
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
        <p class="form-note" style="margin-top:6px">私钥有口令时无需在此填写，连接时会提示输入。</p>
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
      ${NAV.slice(1)
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
  m.root.querySelectorAll('.sp-nav-item').forEach((btn) =>
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) return;
      m.root.querySelectorAll('.sp-nav-item').forEach((b) => b.classList.toggle('active', b === btn));
      m.root.querySelectorAll('.sp-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === btn.dataset.pane));
    })
  );

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

  // —— 连接方式：跳板机模式下显示跳板主机选择（仅直连且已存凭据的主机可作跳板）——
  const viaInput = form.querySelector('[name=connectVia]');
  const jumpSelect = form.querySelector('[name=jumpHostId]');
  const syncVia = () => {
    const isJump = viaInput.value === 'jump';
    form.querySelectorAll('[data-via=jump]').forEach((el) => (el.hidden = !isJump));
  };
  viaInput.addEventListener('change', syncVia);
  {
    const all = await fetchHosts();
    const candidates = all.filter(
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

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';
    // 新建密钥认证必须先导入私钥（编辑态不导入 = 保持原私钥）
    if (authInput.value === 'privateKey' && !keyPem && !isEdit) {
      errEl.textContent = '请导入私钥文件（本地或从飞牛）';
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = isEdit ? '保存中…' : '创建中…';
    const fd = new FormData(form);
    const body = {
      name: fd.get('name').trim(),
      host: fd.get('host').trim(),
      port: Number(fd.get('port')) || 22,
      username: fd.get('username').trim(),
      group: fd.get('group'),
      authType: fd.get('authType'),
      connectVia: fd.get('connectVia'),
    };
    // 跳板机模式必须选定跳板主机
    if (body.connectVia === 'jump') {
      const jumpId = fd.get('jumpHostId');
      if (!jumpId) {
        errEl.textContent = '请选择作为跳板的主机';
        submitBtn.disabled = false;
        submitBtn.textContent = isEdit ? '保存' : '创建';
        return;
      }
      body.jumpHostId = jumpId;
    }
    const pw = fd.get('password');
    if (body.authType === 'password' && pw) body.password = pw;
    if (body.authType === 'privateKey' && keyPem) body.privateKey = keyPem;

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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

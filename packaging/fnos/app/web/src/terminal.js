// 多会话终端管理（FR-045）：每 tab 一个独立 xterm 实例与 WS 连接
// 切换 tab 时非活动终端仅隐藏（display），连接不中断；重新激活时重新 fit
import { FrameType, encodeDataFrame, PROTOCOL_VERSION } from './protocol/frames.js';
import { xtermTheme, onThemeChange } from './theme.js';
import { fetchHosts } from './hosts.js';
import { openModal } from './modal.js';
import { showContextMenu } from './contextmenu.js';
import { wsUrl, apiUrl } from './base.js';
import { icon } from './icons.js';
import { getPrefs, onPrefsChange } from './prefs.js';
import { getQuickCommands, addQuickCommand, onQuickCommandsChange } from './quick-commands.js';

/** 存活终端集合：通用设置变更时动态应用（字号/光标闪烁） */
const liveTerms = new Map(); // term -> fit 函数
onPrefsChange((name, value) => {
  for (const [term, fit] of liveTerms) {
    try {
      if (name === 'fontSize') {
        term.options.fontSize = value;
        // 字号改变单元格尺寸，行列映射必须重新 fit，否则光标/文本渲染错位
        setTimeout(fit, 30);
      }
      if (name === 'cursorBlink') term.options.cursorBlink = value;
    } catch {
      /* 忽略已销毁实例 */
    }
  }
});

const { Terminal } = window;
const FitAddonCtor = window.FitAddon?.FitAddon ?? window.FitAddon;

const tabs = new Map(); // tabId -> tab
let seq = 0;
let activeTabId = null;
let ui = null; // { tabbar, terminals, emptyState }
let themeUnsub = null;
const tabsChangeListeners = new Set();

export function onTabsChange(fn) {
  tabsChangeListeners.add(fn);
  return () => tabsChangeListeners.delete(fn);
}
function notifyTabsChange() {
  for (const fn of tabsChangeListeners) fn();
}

export function mountTerminalArea(refs) {
  ui = refs;
  renderTabbar(); // 初始渲染：无 tab 时也要显示「新建会话」入口
  onThemeChange((name) => {
    for (const t of tabs.values()) {
      try {
        t.term.options.theme = xtermTheme(name);
      } catch {
        /* 忽略 */
      }
    }
  });
  window.addEventListener('resize', () => {
    const t = tabs.get(activeTabId);
    if (t) fitAndReport(t);
  });
}

/** 连接主机：默认已有活动 tab 则激活；右键「复制会话」时 forceNew 强制新建（FR-049） */
export function connectHost(host, { forceNew = false } = {}) {
  if (!forceNew) {
    const existing = [...tabs.values()].find(
      (t) =>
        t.host.id === host.id &&
        (t.ws?.readyState === WebSocket.OPEN || t.ws?.readyState === WebSocket.CONNECTING)
    );
    if (existing) return activateTab(existing.id);
  }
  return createTab(host);
}

export function hasActiveSessions() {
  for (const t of tabs.values()) {
    if (t.ws && t.ws.readyState === WebSocket.OPEN) return true;
  }
  return false;
}

export function connectedHostIds() {
  const ids = [];
  for (const t of tabs.values()) {
    if (t.ws && t.ws.readyState === WebSocket.OPEN) ids.push(t.host.id);
  }
  return ids;
}

async function createTab(host) {
  const id = `tab_${++seq}`;
  const prefs = getPrefs();
  // 会话临时 ID（FR-051）：备注名按此 ID 存储于 localStorage，与主机数据无关
  const sessionKey = `sess_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
  const instance = document.createElement('div');
  instance.className = 'term-instance';
  instance.innerHTML = `
    <div class="term-container"></div>
    <div class="quick-bar"></div>
    <div class="term-status"></div>`;
  ui.terminals.appendChild(instance);

  const term = new Terminal({
    cursorBlink: prefs.cursorBlink,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    fontSize: prefs.fontSize,
    theme: xtermTheme(),
  });
  let fitAddon = null;
  if (FitAddonCtor) {
    fitAddon = new FitAddonCtor();
    term.loadAddon(fitAddon);
  }
  term.open(instance.querySelector('.term-container'));

  const tab = { id, host, sessionKey, label: null, term, fitAddon, el: instance, ws: null, queue: [], scheduled: false };
  tabs.set(id, tab);
  liveTerms.set(term, () => fitAndReport(tab));

  const statusEl = instance.querySelector('.term-status');
  const setStatus = (text, isErr) => {
    statusEl.textContent = text;
    statusEl.classList.toggle('show', Boolean(text));
    statusEl.classList.toggle('err', Boolean(isErr));
  };
  tab.setStatus = setStatus;
  setStatus('连接中…');

  renderQuickBar(instance.querySelector('.quick-bar'), tab);

  // 终端选中文字右键：复制 / 保存为快捷命令（FR-049 共享右键组件）
  instance.querySelector('.term-container').addEventListener('contextmenu', (e) => {
    const sel = term.getSelection?.().trim();
    if (!sel) return; // 无选中时保留默认行为
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, {
      meta: sel.length > 60 ? `${sel.slice(0, 60)}…` : sel,
      items: [
        {
          label: '复制',
          onClick: () => navigator.clipboard.writeText(sel).catch(() => {}),
        },
        {
          label: '保存为快捷命令',
          onClick: () => {
            const name = prompt('快捷命令名称：', sel.length > 12 ? sel.slice(0, 12) : sel);
            if (name?.trim()) addQuickCommand(name.trim(), sel);
          },
        },
      ],
    });
  });

  // —— WS 连接（前缀感知：fnOS 统一网关下携带 /app/webssh/ 基址）——
  // 网关可能不向 WS 升级注入用户头：先经 REST 换一次性票据一并携带
  let ticket = '';
  try {
    const tr = await fetch(apiUrl('ws-ticket'), { method: 'POST' });
    if (tr.ok) ticket = (await tr.json()).ticket ?? '';
  } catch {
    /* 票据为可选回退，失败不阻断 */
  }
  const url =
    wsUrl('ws/terminal') +
    `?hostId=${encodeURIComponent(host.id)}&version=${PROTOCOL_VERSION}` +
    (ticket ? `&ticket=${encodeURIComponent(ticket)}` : '');
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  tab.ws = ws;

  // 输出分片节流（FR-021）
  const flush = () => {
    tab.scheduled = false;
    if (!tab.queue.length) return;
    term.write(tab.queue.splice(0, tab.queue.length).join(''));
  };
  const enqueue = (text) => {
    tab.queue.push(text);
    if (!tab.scheduled) {
      tab.scheduled = true;
      setTimeout(flush, 16);
    }
  };

  ws.onmessage = (e) => {
    const buf = new Uint8Array(e.data);
    if (buf[0] === FrameType.DATA) enqueue(new TextDecoder().decode(buf.subarray(1)));
  };
  ws.onopen = () => {
    setStatus('');
    renderTabbar();
    notifyTabsChange();
  };
  ws.onclose = (e) => {
    const map = {
      4003: '主机不在授权范围',
      4004: '超出并发会话上限',
      4005: '主机指纹未确认：请先在主机列表完成指纹确认',
      4006: `连接失败（${e.reason || e.code}）`,
      4010: '会话空闲超时，已自动断开',
      4011: '执行超时，已终止',
    };
    const msg = map[e.code] ?? `连接已关闭（${e.reason || e.code}）`;
    setStatus(msg, true);
    term.write(`\r\n\x1b[31m—— ${msg} ——\x1b[0m\r\n`);
    renderTabbar();
    notifyTabsChange();
  };

  term.onData((d) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(encodeDataFrame(d));
  });

  activateTab(id);
  return tab;
}

/** 快捷命令栏：点击即向终端发送命令并执行（命令+回车） */
function renderQuickBar(barEl, tab) {
  const cmds = getQuickCommands();
  barEl.innerHTML = cmds.length
    ? cmds
        .map(
          (c) => `<button class="quick-cmd" data-id="${escapeHtml(c.id)}" title="${escapeHtml(c.cmd)}">${escapeHtml(c.name)}</button>`
        )
        .join('')
    : '<span class="quick-empty">右键终端选中文字可「保存为快捷命令」，或在设置中管理</span>';
  barEl.querySelectorAll('.quick-cmd').forEach((b) =>
    b.addEventListener('click', () => {
      if (tab.ws?.readyState !== WebSocket.OPEN) {
        tab.setStatus?.('未连接，无法发送快捷命令', true);
        return;
      }
      const c = cmds.find((x) => x.id === b.dataset.id);
      if (!c) return;
      tab.ws.send(encodeDataFrame(`${c.cmd}\r`));
      tab.term.focus();
    })
  );
}

// 命令增删后刷新所有存活终端的快捷栏（栏高变化需重新 fit）
onQuickCommandsChange(() => {
  for (const tab of tabs.values()) {
    const bar = tab.el.querySelector('.quick-bar');
    if (bar) renderQuickBar(bar, tab);
    setTimeout(() => fitAndReport(tab), 30);
  }
});

function fitAndReport(tab) {
  if (!tab.fitAddon) return;
  try {
    tab.fitAddon.fit();
  } catch {
    return;
  }
  const { ws, term } = tab;
  if (ws?.readyState === WebSocket.OPEN && term.cols > 0 && term.rows > 0) {
    const payload = new TextEncoder().encode(
      JSON.stringify({ cols: term.cols, rows: term.rows })
    );
    ws.send(new Uint8Array([FrameType.RESIZE, ...payload]));
  }
}

export function activateTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  activeTabId = id;
  for (const t of tabs.values()) t.el.classList.toggle('active', t.id === id);
  renderTabbar();
  // 重新显示后容器尺寸可能变化，需要重新 fit
  setTimeout(() => fitAndReport(tab), 50);
  tab.term.focus();
}

/** 关闭 tab（FR-046）：活动会话先确认 */
export function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  if (tab.ws && tab.ws.readyState === WebSocket.OPEN) {
    if (!confirm(`「${tab.host.name}」的终端会话仍在进行，关闭将断开连接。\n是否关闭当前终端？`)) {
      return;
    }
  }
  destroyTab(id);
}

function destroyTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  try {
    if (tab.ws) {
      tab.ws.onclose = null; // 主动关闭不再提示
      if (tab.ws.readyState === WebSocket.OPEN || tab.ws.readyState === WebSocket.CONNECTING) {
        tab.ws.close(1000);
      }
    }
  } catch {
    /* 忽略 */
  }
  try {
    liveTerms.delete(tab.term);
    tab.term.dispose();
  } catch {
    /* 忽略 */
  }
  tab.el.remove();
  tabs.delete(id);
  if (activeTabId === id) {
    const next = [...tabs.keys()].pop();
    if (next) activateTab(next);
    else {
      activeTabId = null;
      renderTabbar();
    }
  } else {
    renderTabbar();
  }
  notifyTabsChange();
}

function renderTabbar() {
  if (!ui) return;
  const bar = ui.tabbar;
  bar.innerHTML = '';
  const hasTabs = tabs.size > 0;
  ui.emptyState.style.display = hasTabs ? 'none' : 'flex';
  for (const t of tabs.values()) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === activeTabId ? ' active' : '');
    el.dataset.tabId = t.id;
    const isOpen = t.ws?.readyState === WebSocket.OPEN;
    el.innerHTML = `
      <span class="tab-status ${isOpen ? 'open' : ''}" title="${isOpen ? '已连接' : '连接中/已断开'}"></span>
      <span class="tab-label" title="双击修改备注名&#10;会话 ID: ${t.sessionKey}"></span>
      <button class="tab-close" title="关闭终端">${icon('x', 11)}</button>`;
    el.querySelector('.tab-label').textContent = t.label ?? t.host.name;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close')) return;
      activateTab(t.id);
    });
    // 双击会话卡 → 修改备注名（FR-051）
    el.querySelector('.tab-label').addEventListener('dblclick', () => startRename(t));
    // 右键 → 会话菜单（FR-049）
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      activateTab(t.id);
      showSessionMenu(t, e.clientX, e.clientY);
    });
    el.querySelector('.tab-close').addEventListener('click', () => closeTab(t.id));
    bar.appendChild(el);
  }
  // FR-052：tab 栏末尾「新建会话」入口
  const addBtn = document.createElement('button');
  addBtn.className = 'tab new-session';
  addBtn.title = '新建会话';
  addBtn.innerHTML = icon('plus', 14);
  addBtn.addEventListener('click', () => openSessionPicker());
  bar.appendChild(addBtn);
}

/** 新建会话：弹出主机选择（连接需要选定主机） */
async function openSessionPicker() {
  const hosts = await fetchHosts();
  const m = openModal(
    hosts.length
      ? `<div class="picker-list">${hosts
          .map(
            (h) => `<button class="picker-item" data-id="${escapeHtml(h.id)}">
              <span class="picker-name">${escapeHtml(h.name)}</span>
              <span class="picker-meta">${escapeHtml(h.username)}@${escapeHtml(h.host)}:${h.port}</span>
            </button>`
          )
          .join('')}</div>`
      : '<div class="placeholder-box">暂无主机，请先在左侧新增。</div>'
  );
  m.setTitle('新建会话');
  m.root.querySelectorAll('.picker-item').forEach((b) =>
    b.addEventListener('click', () => {
      m.close();
      const host = hosts.find((h) => h.id === b.dataset.id);
      if (host) connectHost(host);
    })
  );
}

/** 会话名冲突检查（FR-053）：与任何其他会话卡的当前显示名（备注名或主机名）相同即冲突 */
function hasNameConflict(tab, name) {
  for (const t of tabs.values()) {
    if (t.id === tab.id) continue;
    if ((t.label ?? t.host.name) === name) return true;
  }
  return false;
}

/** 双击会话卡修改备注名：本地存储，按会话临时 ID 关联（FR-051） */
function startRename(tab) {
  const labelEl = ui.tabbar.querySelector(`.tab[data-tab-id="${tab.id}"] .tab-label`);
  if (!labelEl) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 64;
  input.value = tab.label ?? tab.host.name;
  input.className = 'tab-rename';
  labelEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    if (save) {
      const v = input.value.trim();
      // FR-053：与现有会话名冲突则拒绝保存并提示（停留在编辑态）
      if (v && hasNameConflict(tab, v)) {
        input.classList.add('conflict');
        input.setAttribute('title', `会话名「${v}」与现有会话冲突`);
        input.select();
        return; // 不结束编辑，等待用户改名或 Esc 取消
      }
      done = true;
      tab.label = v || null;
      if (v) localStorage.setItem(`webssh-tab-label:${tab.sessionKey}`, v);
      else localStorage.removeItem(`webssh-tab-label:${tab.sessionKey}`);
    } else {
      done = true;
    }
    renderTabbar();
  };
  input.addEventListener('input', () => input.classList.remove('conflict'));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

/** 会话右键菜单（FR-049）：复制会话 / 重命名 / 关闭会话（共享组件见 contextmenu.js） */
function showSessionMenu(tab, x, y) {
  showContextMenu(x, y, {
    meta: `会话 ${tab.sessionKey}`,
    items: [
      {
        label: '复制会话',
        onClick: () => {
          // FR-052：复制的会话创建后立即进入改名编辑态
          const dup = createTab(tab.host);
          setTimeout(() => startRename(dup), 80);
        },
      },
      { label: '重命名', onClick: () => startRename(tab) },
      'sep',
      { label: '关闭会话', danger: true, onClick: () => closeTab(tab.id) },
    ],
  });
}

/** 页面卸载前清理（beforeunload 提示在 app.js 中注册） */
export function disposeAll() {
  for (const id of [...tabs.keys()]) destroyTab(id);
  if (themeUnsub) {
    themeUnsub();
    themeUnsub = null;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

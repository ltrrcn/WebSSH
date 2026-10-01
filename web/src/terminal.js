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
import {
  sanitizeTmuxSessionName,
  buildTmuxProbeCommand,
  buildTmuxAttachCommand,
  createTmuxDetector,
} from './tmux.js';

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

/** 连接主机：默认已有活动 tab 则激活；右键「复制会话」时 forceNew 强制新建（FR-049）
 *  R001：tmux=true 时以 tmux 保活会话连接（远端探测可用后自动 attach，同一主机共享会话） */
export function connectHost(host, { forceNew = false, tmux = false } = {}) {
  if (!forceNew && !tmux) {
    const existing = [...tabs.values()].find(
      (t) =>
        t.host.id === host.id &&
        !t.tmux &&
        (t.ws?.readyState === WebSocket.OPEN || t.ws?.readyState === WebSocket.CONNECTING)
    );
    if (existing) return activateTab(existing.id);
  }
  return createTab(host, { tmux });
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

async function createTab(host, { tmux = false } = {}) {
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

  const tab = {
    id,
    host,
    sessionKey,
    label: null,
    term,
    fitAddon,
    el: instance,
    ws: null,
    queue: [],
    scheduled: false,
    // R001 tmux 会话模式：name 净化后的会话名；state: detecting → active | off
    tmux: tmux ? { name: sanitizeTmuxSessionName('webssh'), state: 'detecting', detector: null, timer: null } : null,
  };
  tabs.set(id, tab);
  liveTerms.set(term, () => fitAndReport(tab));

  const statusEl = instance.querySelector('.term-status');
  const setStatus = (text, isErr) => {
    statusEl.textContent = text;
    statusEl.classList.toggle('show', Boolean(text));
    statusEl.classList.toggle('err', Boolean(isErr));
    // 状态行显示/隐藏会改变终端容器高度，必须重新 fit，否则已渲染的 canvas 溢出压住快捷命令栏
    setTimeout(() => fitAndReport(tab), 30);
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

  term.onData((d) => {
    // tmux 探测期忽略输入：防干扰探测命令，探测通常亚秒级完成
    if (tab.tmux?.state === 'detecting') return;
    const ws = tab.ws;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(encodeDataFrame(d));
    } else if (ws?.readyState === WebSocket.CLOSED && (d === '\r' || d === '\n')) {
      // 断开后 Enter 重连：复用原终端与回滚缓冲，仅重建 WS
      reconnectTab(tab);
    }
  });

  await connectWs(tab);
  activateTab(id);
  return tab;
}

// 输出分片节流（FR-021）：队列挂在 tab 上，重连后沿用同一节流通道
function enqueue(tab, text) {
  tab.queue.push(text);
  if (!tab.scheduled) {
    tab.scheduled = true;
    setTimeout(() => {
      tab.scheduled = false;
      if (tab.queue.length) tab.term.write(tab.queue.splice(0, tab.queue.length).join(''));
    }, 16);
  }
}

// —— WS 连接（前缀感知：fnOS 统一网关下携带 /app/webssh/ 基址）——
// 网关可能不向 WS 升级注入用户头：先经 REST 换一次性票据一并携带。
// createTab 首连与断开后重连共用本函数。
async function connectWs(tab) {
  if (tab.connecting) return; // 票据换取期间的二次触发防抖
  tab.connecting = true;
  const { host, term } = tab;
  tab.setStatus?.('连接中…');
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

  ws.onmessage = (e) => {
    const buf = new Uint8Array(e.data);
    if (buf[0] !== FrameType.DATA) return;
    const text = new TextDecoder().decode(buf.subarray(1));
    // R001 tmux 探测期：输出喂状态机判定，不显示（探测命令回显不进终端）
    if (tab.tmux?.state === 'detecting') {
      const verdict = tab.tmux.detector(text);
      if (verdict === 'found') {
        tab.tmux.state = 'active';
        clearTimeout(tab.tmux.timer);
        ws.send(encodeDataFrame(`${buildTmuxAttachCommand(tab.tmux.name)}\r`));
        renderTabbar();
      } else if (verdict === 'missing') {
        tab.tmux.state = 'off';
        clearTimeout(tab.tmux.timer);
        showTmuxMissingHint(tab);
        renderTabbar();
      }
      return;
    }
    enqueue(tab, text);
  };
  ws.onopen = () => {
    tab.connecting = false;
    tab.setStatus?.('');
    // R001 tmux 模式：首连与断线重连统一在此启动探测（重连后自动 attach 恢复现场）
    if (tab.tmux) startTmuxProbe(tab);
    renderTabbar();
    notifyTabsChange();
  };
  ws.onclose = (e) => {
    tab.connecting = false;
    const map = {
      4003: '主机不在授权范围',
      4004: '超出并发会话上限',
      4005: '主机指纹未确认：请先在主机列表完成指纹确认',
      4006: `连接失败（${e.reason || e.code}）`,
      4010: '会话空闲超时，已自动断开',
      4011: '执行超时，已终止',
    };
    const msg = map[e.code] ?? `连接已关闭（${e.reason || e.code}）`;
    // 断开原因只写入终端回滚区，底部状态行不显示
    term.write(`\r\n\x1b[31m—— ${msg} ——\x1b[0m\r\n`);
    term.write('\x1b[90m按 Enter 重新连接\x1b[0m\r\n');
    renderTabbar();
    notifyTabsChange();
  };
}

/** R001 tmux 探测：发送探测命令 + 4s 超时兜底（超时按乐观处理直接 attach，错误自然显示） */
function startTmuxProbe(tab) {
  const tm = tab.tmux;
  tm.state = 'detecting';
  tm.detector = createTmuxDetector();
  clearTimeout(tm.timer);
  tm.timer = setTimeout(() => {
    // 超时：极慢的远端或输出被吞，乐观 attach（远端无 tmux 时 shell 会报错，用户可见）
    if (tm.state === 'detecting' && tab.ws?.readyState === WebSocket.OPEN) {
      tm.state = 'active';
      tab.ws.send(encodeDataFrame(`${buildTmuxAttachCommand(tm.name)}\r`));
      renderTabbar();
    }
  }, 4000);
  if (tab.ws?.readyState === WebSocket.OPEN) {
    tab.ws.send(encodeDataFrame(`${buildTmuxProbeCommand()}\r`));
  }
}

/** R001 远端无 tmux：明确提示（含安装指引），当前 tab 退化为普通终端继续可用 */
function showTmuxMissingHint(tab) {
  const m = openModal(`
    <div class="tmux-hint">
      <p>主机 <strong>${escapeHtml(tab.host.name)}</strong> 未安装 tmux，无法使用保活会话。</p>
      <p>当前终端已按普通模式继续，功能不受影响。</p>
      <p class="tmux-hint-install">在远端安装后即可启用（断线恢复 / 多标签同步）：</p>
      <pre><code>apt-get install -y tmux</code></pre>
      <p class="tmux-hint-note">其他系统：yum install tmux / apk add tmux / pacman -S tmux</p>
    </div>`);
  m.setTitle('tmux 不可用');
}

/** 断开后重连：复用同一终端实例（保留回滚缓冲与备注名），仅重建 WS */
function reconnectTab(tab) {
  if (!tab.ws || tab.ws.readyState !== WebSocket.CLOSED) return;
  tab.term.write('\x1b[90m—— 重新连接… ——\x1b[0m\r\n');
  connectWs(tab);
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
      if (tab.tmux?.state === 'detecting') return; // R001 探测期不注入命令，防干扰
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
    // 高分屏（DPR>1）下实际渲染行高按物理像素取整，会略大于 fit 用的理论 cell 高，
    // 多行累计后 canvas 底部会超出容器、与快捷命令栏重叠：检测到溢出则按少一行重设
    const container = tab.term.element?.parentElement;
    if (container) {
      const cs = getComputedStyle(container);
      const avail = parseFloat(cs.height) + parseFloat(cs.paddingBottom);
      if (tab.term.element.offsetHeight > avail && tab.term.rows > 1) {
        tab.term.resize(tab.term.cols, tab.term.rows - 1);
      }
    }
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
    // R001：tmux 会话关闭提示不同——远端会话保留，重连可恢复现场
    const msg =
      tab.tmux?.state === 'active'
        ? `「${tab.host.name}」处于 tmux 保活会话，关闭标签后远端会话继续保留，\n重新连接可恢复现场。是否关闭当前终端？`
        : `「${tab.host.name}」的终端会话仍在进行，关闭将断开连接。\n是否关闭当前终端？`;
    if (!confirm(msg)) {
      return;
    }
  }
  destroyTab(id);
}

function destroyTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  if (tab.tmux) clearTimeout(tab.tmux.timer); // R001：清理探测超时定时器
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
      <span class="tab-label" title="双击修改备注名&#10;会话 ID: ${t.sessionKey}${t.tmux ? `&#10;tmux 会话: ${t.tmux.state === 'active' ? t.tmux.name : '探测中/不可用'}` : ''}"></span>
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
  const prefs = getPrefs();
  const m = openModal(
    hosts.length
      ? `<label class="picker-tmux"><input type="checkbox" id="picker-tmux" ${prefs.tmuxDefault ? 'checked' : ''} />
          <span>以 tmux 保活会话连接<div class="picker-tmux-desc">断线后可恢复现场；同一主机的多个标签屏幕同步（需远端已安装 tmux）</div></span>
        </label>
        <div class="picker-list">${hosts
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
      const tmux = m.root.querySelector('#picker-tmux')?.checked ?? false;
      if (host) connectHost(host, { forceNew: tmux, tmux });
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
  const dupTmux = tab.tmux?.state === 'active';
  showContextMenu(x, y, {
    meta: `会话 ${tab.sessionKey}${tab.tmux ? ` · tmux: ${tab.tmux.name}` : ''}`,
    items: [
      {
        label: dupTmux ? '复制会话（tmux 同步）' : '复制会话',
        onClick: () => {
          // FR-052：复制的会话创建后立即进入改名编辑态
          // R001：tmux 会话的复制 attach 同一远端会话，两端屏幕同步
          const dup = createTab(tab.host, { tmux: dupTmux });
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

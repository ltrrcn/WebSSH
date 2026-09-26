// 多会话终端管理（FR-045）：每 tab 一个独立 xterm 实例与 WS 连接
// 切换 tab 时非活动终端仅隐藏（display），连接不中断；重新激活时重新 fit
import { FrameType, encodeDataFrame, PROTOCOL_VERSION } from './protocol/frames.js';
import { xtermTheme, onThemeChange } from './theme.js';

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

/** 连接主机：已有该主机的活动 tab 则直接激活（当前策略：每主机一个 tab） */
export function connectHost(host) {
  const existing = [...tabs.values()].find(
    (t) =>
      t.host.id === host.id &&
      (t.ws?.readyState === WebSocket.OPEN || t.ws?.readyState === WebSocket.CONNECTING)
  );
  if (existing) return activateTab(existing.id);
  createTab(host);
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

function createTab(host) {
  const id = `tab_${++seq}`;
  const instance = document.createElement('div');
  instance.className = 'term-instance';
  instance.innerHTML = `
    <div class="term-container"></div>
    <div class="term-status"></div>`;
  ui.terminals.appendChild(instance);

  const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    fontSize: 13,
    theme: xtermTheme(),
  });
  let fitAddon = null;
  if (FitAddonCtor) {
    fitAddon = new FitAddonCtor();
    term.loadAddon(fitAddon);
  }
  term.open(instance.querySelector('.term-container'));

  const tab = { id, host, term, fitAddon, el: instance, ws: null, queue: [], scheduled: false };
  tabs.set(id, tab);

  const statusEl = instance.querySelector('.term-status');
  const setStatus = (text, isErr) => {
    statusEl.textContent = text;
    statusEl.classList.toggle('show', Boolean(text));
    statusEl.classList.toggle('err', Boolean(isErr));
  };
  tab.setStatus = setStatus;
  setStatus('连接中…');

  // —— WS 连接 ——
  const url =
    (location.protocol === 'https:' ? 'wss://' : 'ws://') +
    location.host +
    `/ws/terminal?hostId=${encodeURIComponent(host.id)}&version=${PROTOCOL_VERSION}`;
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
}

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
    const isOpen = t.ws?.readyState === WebSocket.OPEN;
    el.innerHTML = `
      <span class="tab-status ${isOpen ? 'open' : ''}" title="${isOpen ? '已连接' : '连接中/已断开'}"></span>
      <span class="tab-label"></span>
      <button class="tab-close" title="关闭终端">✕</button>`;
    el.querySelector('.tab-label').textContent = t.host.name;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close')) return;
      activateTab(t.id);
    });
    el.querySelector('.tab-close').addEventListener('click', () => closeTab(t.id));
    bar.appendChild(el);
  }
}

/** 页面卸载前清理（beforeunload 提示在 app.js 中注册） */
export function disposeAll() {
  for (const id of [...tabs.keys()]) destroyTab(id);
  if (themeUnsub) {
    themeUnsub();
    themeUnsub = null;
  }
}

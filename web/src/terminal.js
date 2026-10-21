// 多会话终端管理（FR-045）：每 tab 一个独立 xterm 实例与 WS 连接
// 切换 tab 时非活动终端仅隐藏（display），连接不中断；重新激活时重新 fit
import { FrameType, encodeDataFrame, PROTOCOL_VERSION } from './protocol/frames.js';
import { xtermTheme, onThemeChange } from './theme.js';
import { fetchHosts } from './hosts.js';
import { confirmFingerprintModal } from './hosts.js';
import { openModal, confirmModal, isModalOpen } from './modal.js';
import { showContextMenu } from './contextmenu.js';
import { wsUrl, apiUrl } from './base.js';
import { icon } from './icons.js';
import { getPrefs, setPref, onPrefsChange } from './prefs.js';
import { getQuickCommands, addQuickCommand, nextQuickCommandName, onQuickCommandsChange, removeQuickCommand } from './quick-commands.js';
import { openQuickCommandNamer } from './quick-commands-ui.js';
import { promptTwofaVerify, getTwofaTicket } from './twofa.js';
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
let ui = null; // { tabbar, tabStrip, terminals, emptyState }
let themeUnsub = null;
/** 会话条可见窗口的起始索引：窗口宽度不足时由右侧 ‹ › 左右滑动切换 */
let tabOffset = 0;
/** 已保证过可见的活动会话：仅在活动会话切换时重新定位，避免把用户手动滑动的结果拉回 */
let pinnedTabId = null;
const tabsChangeListeners = new Set();

export function onTabsChange(fn) {
  tabsChangeListeners.add(fn);
  return () => tabsChangeListeners.delete(fn);
}
function notifyTabsChange() {
  for (const fn of tabsChangeListeners) fn();
  // 会话变动后同步一次服务端保活列表（合并高频触发）
  if (detachedRefreshTimer) clearTimeout(detachedRefreshTimer);
  detachedRefreshTimer = setTimeout(() => refreshDetachedSessions(), 300);
}

export function mountTerminalArea(refs) {
  ui = refs;
  buildTabbar();
  renderTabbar(); // 初始渲染：无 tab 时也要显示「新建会话」入口
  refreshDetachedSessions(); // FR-059：刷新页面后仍可接管服务端保活的会话
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
    pinnedTabId = null; // 宽度变化后重新保证活动会话可见
    layoutTabs(); // 窗口尺寸变化 → 可容纳会话数随之变化
    const t = tabs.get(activeTabId);
    if (t) fitAndReport(t);
  });
}

/** tabbar 骨架：左侧会话条（容纳不下的会话卡隐藏）+ 右侧左右切换与「新建会话」 */
function buildTabbar() {
  const bar = ui.tabbar;
  bar.innerHTML = `
    <div class="tab-strip"></div>
    <div class="tab-tools">
      <button class="tab-nav-btn" id="tab-nav-prev" title="向左切换会话" aria-label="向左切换会话">${icon('chevron', 14)}</button>
      <button class="tab-nav-btn" id="tab-nav-next" title="向右切换会话" aria-label="向右切换会话">${icon('chevron', 14)}</button>
      <button class="tab-bg-btn" id="btn-bg-sessions" title="后台运行的会话">${icon('monitor', 13)}<span id="bg-count"></span></button>
      <button class="tab-detached-btn" id="btn-detached" title="服务端保活的会话（刷新/关窗口后仍可恢复）">${icon('monitor', 13)}<span id="dt-count"></span></button>
      <button class="tab new-session" id="btn-new-session" title="新建会话">${icon('plus', 14)}</button>
    </div>`;
  ui.tabStrip = bar.querySelector('.tab-strip');
  const prev = bar.querySelector('#tab-nav-prev');
  const next = bar.querySelector('#tab-nav-next');
  prev.querySelector('.icon').style.transform = 'scaleX(-1)'; // 复用 chevron 图标做左向箭头
  prev.addEventListener('click', () => shiftTabs(-1));
  next.addEventListener('click', () => shiftTabs(1));
  bar.querySelector('#btn-bg-sessions').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showBackgroundMenu(r.left, r.bottom + 4); // 菜单贴着按钮左下展开
  });
  bar.querySelector('#btn-detached').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showDetachedMenu(r.left, r.bottom + 4);
  });
  bar.querySelector('#btn-new-session').addEventListener('click', () => openSessionPicker());
  // 触控板横向滑动 / Shift+滚轮 = 左右切换（未溢出时不拦截默认行为）
  ui.tabStrip.addEventListener(
    'wheel',
    (e) => {
      const d = e.deltaX !== 0 ? e.deltaX : e.shiftKey ? e.deltaY : 0;
      if (!d || !bar.classList.contains('overflowing')) return;
      e.preventDefault();
      shiftTabs(d > 0 ? 1 : -1);
    },
    { passive: false }
  );
}

/** 连接主机：每次点「连接」都新建一个会话卡（同一主机可多开），与会话卡右键「复制会话」行为一致
 *  R001：tmux=true 时以 tmux 保活会话连接（远端探测可用后自动 attach，同一主机共享屏幕）
 *  R003：指纹未确认时先弹确认（有 pendingFingerprint 才拦，无指纹记录直接连、由 4005 流程接管） */
export async function connectHost(host, { tmux = false } = {}) {
  // 「仅 MCP」授权范围：网页终端入口关闭（服务端同样拒绝），只能编辑该连接
  if ((host.scope ?? 'all') === 'mcp') {
    alert(`「${host.name}」仅授权 MCP，网页终端不可连接。如需使用终端，请先编辑该会话连接把范围改为全选。`);
    return null;
  }
  if (!host.fingerprintConfirmed && host.pendingFingerprint) {
    const ok = await confirmFingerprintModal(host);
    if (!ok) return null; // 取消确认 = 放弃连接
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

async function createTab(host, { tmux = false, attachId = '' } = {}) {
  const id = `tab_${++seq}`;
  const prefs = getPrefs();
  // 会话临时 ID（FR-051）：备注名按此 ID 存储于 localStorage，与主机数据无关
  const sessionKey = `sess_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
  const instance = document.createElement('div');
  instance.className = 'term-instance';
  instance.innerHTML = `
    <div class="term-container"><div class="term-surface"></div></div>
    <div class="term-zoom">
      <button type="button" data-z="-" title="减小字号">-</button>
      <span class="term-zoom-val">${prefs.fontSize}</span>
      <button type="button" data-z="+" title="增大字号">+</button>
    </div>
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
  term.open(instance.querySelector('.term-surface'));

  const tab = {
    id,
    host,
    sessionKey,
    serverSessionId: null, // 服务端会话 ID（session+连接时刻）：建连后由 SESSION 帧下发，与审计记录对应
    label: null,
    term,
    fitAddon,
    el: instance,
    ws: null,
    queue: [],
    scheduled: false,
    // FR-059：接管服务端挂起会话时携带其会话 ID；为空表示新建会话
    attachSessionId: attachId || null,
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

  // 右上角字号调节（hover 终端浮现）：与通用设置同一偏好，setPref 广播后全部终端即时生效（liveTerms 订阅负责重渲染与 fit）
  const zoomVal = instance.querySelector('.term-zoom-val');
  const zoomStep = (d) => {
    const cur = getPrefs().fontSize;
    const v = Math.min(18, Math.max(12, cur + d)); // 与通用设置滑杆同一范围 12–18
    if (v !== cur) setPref('fontSize', v);
  };
  instance.querySelector('[data-z="-"]').addEventListener('click', (e) => { e.stopPropagation(); zoomStep(-1); });
  instance.querySelector('[data-z="+"]').addEventListener('click', (e) => { e.stopPropagation(); zoomStep(1); });
  // 其他入口（设置页滑杆）改字号时同步本终端的显示值
  tab.zoomUnsub = onPrefsChange((name, value) => {
    if (name === 'fontSize') zoomVal.textContent = value;
  });

  // 布局高度变化根治监测：term-container 高度一旦变化（快捷栏增删、空态提示、状态行显隐）
  // 立即重新 fit——替代对每类变化逐一 setTimeout 打点的脆弱时序（快捷栏空态↔命令态高度不一曾遮挡终端）
  tab.resizeObserver = new ResizeObserver(() => fitAndReport(tab));
  tab.resizeObserver.observe(instance.querySelector('.term-surface'));

  // 终端选中文字右键：复制 / 保存为快捷命令（FR-049 共享右键组件）
  instance.querySelector('.term-container').addEventListener('contextmenu', (e) => {
    const selectedText = term.getSelection?.() ?? '';
    if (!selectedText) return; // 无选中时保留默认行为
    const sel = selectedText.trim();
    e.preventDefault();
    // 保存长度上限（通用设置，默认 24 / 最大 128）：超出则菜单项禁用，防止误存长文本
    const maxChars = getPrefs().quickCmdMaxChars ?? 24;
    const tooLong = sel.length > maxChars;
    showContextMenu(e.clientX, e.clientY, {
      meta: sel.length > 60 ? `${sel.slice(0, 60)}…` : sel,
      items: [
        {
          label: '复制',
          onClick: () => navigator.clipboard.writeText(selectedText).catch(() => {}),
        },
        {
          label: tooLong
            ? `保存为快捷命令（选中 ${sel.length} 字符，超出上限 ${maxChars}）`
            : '保存为快捷命令',
          disabled: tooLong || !sel,
          // 命名弹窗只收名称（命令不回填，防泄露）；留空保存则用「快捷命令N」自动编号
          onClick: tooLong || !sel ? undefined : () => openQuickCommandNamer(nextQuickCommandName(), (name) => addQuickCommand(name, sel)),
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

  // 本地尺寸任何变化（fit/激活/字号等路径）实时同步远端；WS 未就绪时跳过，
  // 由 onopen 的 sendResize 补报当前值——不再依赖 fitAndReport 的调用点覆盖
  term.onResize(() => sendResize(tab));

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
  // 主机级二次认证：开启且未完成过验证 → 弹 2FA 验证码（一次验证永久生效，此后不再提示）；
  // 取消验证则中止本次连接，终端留痕可按 Enter 重试
  let twofaTicket = '';
  if (host.requireTwofa && !host.twofaVerified) {
    const ok = await promptTwofaVerify();
    if (!ok) {
      tab.connecting = false;
      term.write('\r\n\x1b[31m—— 已取消 2FA 验证，连接中止（按 Enter 重试） ——\x1b[0m\r\n');
      tab.setStatus?.('已取消');
      return;
    }
    twofaTicket = getTwofaTicket() ?? '';
    host.twofaVerified = true; // 服务端已落盘授权；本地同步避免重连再弹码
  }
  // FR-059：带 sessionId 时服务端把本连接接到已挂起的会话上（而非新建）
  // pt：私钥口令一次性票据（口令明文不进 URL/日志）；取出即清，保证一次性
  const passTicket = tab.passTicket;
  tab.passTicket = null;
  const url =
    wsUrl('ws/terminal') +
    `?hostId=${encodeURIComponent(host.id)}&version=${PROTOCOL_VERSION}` +
    (tab.attachSessionId ? `&sessionId=${encodeURIComponent(tab.attachSessionId)}` : '') +
    (passTicket ? `&pt=${encodeURIComponent(passTicket)}` : '') +
    (twofaTicket ? `&twofa=${encodeURIComponent(twofaTicket)}` : '') +
    (ticket ? `&ticket=${encodeURIComponent(ticket)}` : '');
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  tab.ws = ws;

  ws.onmessage = (e) => {
    const buf = new Uint8Array(e.data);
    if (buf[0] === FrameType.SESSION) {
      // 服务端会话 ID：与审计记录里的「会话 ID」是同一个值（FR-058）
      try {
        const meta = JSON.parse(new TextDecoder().decode(buf.subarray(1)));
        if (meta?.sessionId) tab.serverSessionId = meta.sessionId;
      } catch {
        /* 忽略 */
      }
      return;
    }
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
    // 尺寸同步第一帧：WS 打开即上报当前行列，不依赖后续 fit 定时器链。
    // 服务端会暂存建连期间（SSH shell 尚未就绪）到达的 RESIZE 并在就绪后补投，
    // 保证远端 pty 不会停留在默认 80×24（长命令换行错位/内容上叠的根因）
    sendResize(tab);
    // FR-059 接管会话：重设窗口尺寸，让远端按当前终端大小重绘
    if (tab.attachSessionId) setTimeout(() => fitAndReport(tab), 60);
    // 断线重连（按 Enter / 网络恢复）也须重新 fit：断开期间窗口尺寸或样式可能已变，
    // 旧 cols/rows 会让 canvas 溢出容器（命令蔓延到边缘），远端也无法对齐
    else if (tab.everConnected) setTimeout(() => fitAndReport(tab), 60);
    tab.everConnected = true;
    tab.autoRetries = 0; // 连接成功：重置自动重连计数
    // R001 tmux 模式：首连与断线重连统一在此启动探测（重连后自动 attach 恢复现场）
    if (tab.tmux) startTmuxProbe(tab);
    renderTabbar();
    notifyTabsChange();
  };
  ws.onclose = (e) => {
    tab.connecting = false;
    // R003 首次连接指纹未确认：服务端在 reason 携带指纹（fingerprint_unconfirmed:<fp>），
    // 弹居中确认弹窗——信任则自动重连，取消则终止（无需再去左侧点钥匙）
    let fpMissMsg = null;
    if (e.code === 4007) {
      // 待接管的会话已失效（超保活时长被回收 / 不属于当前用户）→ 退化为新建会话重连一次
      tab.attachSessionId = null;
      term.write('\r\n\x1b[33m—— 原会话已失效，正在建立新连接 ——\x1b[0m\r\n');
      connectWs(tab);
      return;
    }
    if (e.code === 4005) {
      const fp = e.reason?.startsWith('fingerprint_unconfirmed:')
        ? e.reason.slice('fingerprint_unconfirmed:'.length)
        : '';
      if (fp) {
        handleFingerprintConfirm(tab, fp);
        return;
      }
      // 无指纹 = 服务端捕获失败（目标不可达/握手失败），弹窗无从弹起——文案必须说清
      fpMissMsg = '无法获取主机指纹：请检查主机地址与端口是否可达，再重新连接';
    }
    // 需要手动输入凭据：私钥口令（passphrase_*）或 none 主机密码（password_required / 认证失败重试）
    const isNoneAuth = tab.host.authType === 'none';
    const needSecret =
      e.reason === 'passphrase_required' ||
      e.reason === 'passphrase_invalid' ||
      e.reason === 'password_required' ||
      (isNoneAuth && e.reason === 'auth_failed');
    if (e.code === 4006 && needSecret) {
      promptPassphrase(tab, {
        invalid: e.reason === 'passphrase_invalid' || (isNoneAuth && e.reason === 'auth_failed'),
      });
      renderTabbar();
      notifyTabsChange();
      return;
    }
    // 跳板机失败原因 → 可读文案（4006 的 reason 已在服务端白名单化）
    const reasonMap = {
      jump_loop: '跳板机配置无效（不支持多级跳板或自引用）',
      jump_not_found: '跳板机不存在或已删除',
      jump_no_secret: '跳板机未保存凭据，请先编辑该主机保存密码或密钥',
      jump_fingerprint_unconfirmed: '跳板机指纹未确认，请先直连一次跳板机完成确认',
      jump_fingerprint_changed: '跳板机指纹已变化，请先直连重新确认',
      jump_passphrase_required: '跳板机私钥需要口令，请先连接一次跳板机并勾选记住口令',
      jump_connect_failed: '无法连接跳板机（地址/端口/凭据）',
      jump_forward_failed: '跳板机转发失败：目标地址从跳板机侧不可达（检查目标地址/端口，以及从跳板机能否连通目标）',
      jump_forward_denied: '跳板机拒绝 TCP 转发：sshd 配置禁止（AllowTcpForwarding no 或 PermitOpen 限制），需在跳板机上开启转发',
      passphrase_required: '私钥需要口令',
      passphrase_invalid: '私钥口令错误',
    };
    const map = {
      4003: '主机不在授权范围',
      4004: '超出并发会话上限',
      4005: '主机指纹未确认：请重新连接并在弹窗中确认',
      4006: `连接失败（${reasonMap[e.reason] ?? e.reason ?? e.code}）`,
      4009: '口令票据无效或已过期，请重新连接',
      4010: '会话空闲超时，已自动断开',
      4011: '执行超时，已终止',
      4012: '该连接需先完成 2FA 验证（重新连接将弹出验证码）',
    };
    const msg = fpMissMsg ?? map[e.code] ?? `连接已关闭（${e.reason || e.code}）`;
    // 断开原因只写入终端回滚区，底部状态行不显示
    term.write(`\r\n\x1b[31m—— ${msg} ——\x1b[0m\r\n`);
    term.write('\x1b[90m按 Enter 重新连接\x1b[0m\r\n');
    renderTabbar();
    notifyTabsChange();
    // 高级页「断线自动重连」：异常断开（1006）/连接失败（4006）自动重试；
    // 需用户输入的关闭（凭据/指纹弹窗已提前 return）与认证失败不重试
    if (
      tab.host?.session?.autoReconnect === true &&
      !tab.userClosed &&
      (e.code === 1006 || (e.code === 4006 && e.reason !== 'auth_failed'))
    ) {
      scheduleAutoReconnect(tab);
    }
  };
}

/** 高级页「断线自动重连」：指数退避自动重试（1s/2s/4s，共 3 次），
 *  连接成功由 SESSION 帧回调重置计数；用户关闭会话即停止 */
function scheduleAutoReconnect(tab) {
  if (tab.autoRetryTimer) return;
  tab.autoRetries = (tab.autoRetries ?? 0) + 1;
  if (tab.autoRetries > 3) {
    tab.term.write('\x1b[90m—— 自动重连已放弃（3 次未成功），按 Enter 手动重试 ——\x1b[0m\r\n');
    tab.autoRetries = 0;
    return;
  }
  const delaySec = 2 ** (tab.autoRetries - 1); // 1s / 2s / 4s
  tab.term.write(`\x1b[90m—— ${delaySec} 秒后自动重连（第 ${tab.autoRetries}/3 次）——\x1b[0m\r\n`);
  tab.autoRetryTimer = setTimeout(() => {
    tab.autoRetryTimer = null;
    if (tab.userClosed || !tabs.has(tab.id)) return;
    if (tab.ws?.readyState === WebSocket.OPEN || tab.ws?.readyState === WebSocket.CONNECTING) return;
    reconnectTab(tab);
  }, delaySec * 1000);
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

/** 连接凭据弹窗：加密私钥需口令 / none 主机每次手动输密码（后者无「记住」选项） */
function promptPassphrase(tab, { invalid = false } = {}) {
  const { term, host } = tab;
  if (isModalOpen()) return; // 已有弹窗（如指纹确认）时不叠加
  const isPassword = host.authType === 'none'; // none = 不记录密码，每次手动输入
  const m = openModal(`
    <div class="pass-prompt">
      ${invalid ? `<p class="pass-err">${isPassword ? '密码错误，认证失败，请重新输入。' : '口令错误或私钥解密失败，请重新输入。'}</p>` : ''}
      <p class="pass-desc">${
        isPassword
          ? `「<strong>${escapeHtml(host.name)}</strong>」不记录密码，请输入登录密码：`
          : `「<strong>${escapeHtml(host.name)}</strong>」的私钥已加密，请输入密钥口令：`
      }</p>
      <input type="password" id="pass-input" class="pref-input" placeholder="${isPassword ? '登录密码' : '密钥口令'}" autocomplete="off" />
      ${
        isPassword
          ? ''
          : `<label class="picker-tmux pass-remember"><input type="checkbox" id="pass-remember" />
        <span>记住口令<div class="picker-tmux-desc">AES-256-GCM 加密保存在本应用，下次连接免输入</div></span>
      </label>`
      }
      <p class="pass-err hf-error" id="pass-error" role="alert"></p>
      <div class="qc-edit-actions" style="margin-top:6px">
        <button class="btn" id="pass-cancel">取消</button>
        <button class="btn primary" id="pass-ok">连接</button>
      </div>
    </div>`);
  m.setTitle(isPassword ? '输入密码' : '需要密钥口令');
  term.write(
    isPassword
      ? '\r\n\x1b[33m—— 等待输入密码… ——\x1b[0m\r\n'
      : '\r\n\x1b[33m—— 私钥已加密，等待输入口令… ——\x1b[0m\r\n'
  );
  const input = m.root.querySelector('#pass-input');
  const errEl = m.root.querySelector('#pass-error');
  const okBtn = m.root.querySelector('#pass-ok');
  input.focus();
  okBtn.addEventListener('click', async () => {
    const secret = input.value;
    if (!secret) {
      input.focus();
      return;
    }
    okBtn.disabled = true;
    okBtn.textContent = '连接中…';
    errEl.textContent = '';
    try {
      const res = await fetch(apiUrl(`hosts/${encodeURIComponent(host.id)}/connect-secret`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          isPassword
            ? { password: secret }
            : { passphrase: secret, remember: m.root.querySelector('#pass-remember').checked }
        ),
      });
      if (!res.ok) throw new Error();
      const { ticket } = await res.json();
      tab.passTicket = ticket;
      m.close();
      term.write('\x1b[90m—— 凭据已接收，正在连接… ——\x1b[0m\r\n');
      connectWs(tab);
    } catch {
      okBtn.disabled = false;
      okBtn.textContent = '连接';
      errEl.textContent = '提交失败，请重试';
    }
  });
  m.root.querySelector('#pass-cancel').addEventListener('click', () => {
    m.close();
    term.write('\x1b[90m—— 已取消，按 Enter 重新连接 ——\x1b[0m\r\n');
  });
}

/** R003 指纹确认流程：弹窗 → 信任则自动重连，取消则终端留痕终止 */
async function handleFingerprintConfirm(tab, fp) {
  const { term } = tab;
  renderTabbar();
  notifyTabsChange();
  const ok = await confirmFingerprintModal({ ...tab.host, pendingFingerprint: fp });
  if (ok) {
    term.write('\r\n\x1b[90m—— 指纹已确认，正在连接… ——\x1b[0m\r\n');
    reconnectTab(tab);
  } else {
    term.write(`\r\n\x1b[90m—— 已取消指纹确认（${fp}）——\x1b[0m\r\n`);
    term.write('\x1b[90m按 Enter 重新连接\x1b[0m\r\n');
  }
}

/** 断开后重连：复用同一终端实例（保留回滚缓冲与备注名），仅重建 WS */
function reconnectTab(tab) {
  if (!tab.ws || tab.ws.readyState !== WebSocket.CLOSED) return;
  tab.term.write('\x1b[90m—— 重新连接… ——\x1b[0m\r\n');
  connectWs(tab);
}

/** 掩码执行（快捷命令）：走 /api/quick-exec 独立 exec 通道，命令不经过终端输入流——
 *  屏幕只有本地画的等长星号与执行结果，远端 shell 无感知、历史无记录。
 *  备注名随请求传给后端写入审计，审计页展示备注名而非命令原文。
 *  （回显操纵方案在 zsh 语法高亮/重绘下不可靠，已放弃；exec 通道的代价是
 *   与当前 shell 不共享 cd/环境变量、不支持交互式命令） */
async function runQuickCommand(tab, qc) {
  const cmd = qc.cmd;
  const { term } = tab;
  term.write(`${'*'.repeat(cmd.length)}\r\n\x1b[90m执行中…\x1b[0m`);
  const erasePending = '\r\x1b[2K'; // 回行首并清掉「执行中…」
  try {
    const res = await fetch(apiUrl('quick-exec'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostId: tab.host.id, command: cmd, quickName: qc.name }),
    });
    const data = await res.json().catch(() => ({}));
    term.write(erasePending);
    if (!res.ok) {
      term.write(`\x1b[31m错误：${data.error?.message ?? res.statusText}\x1b[0m`);
    } else {
      let out = data.stdout ?? '';
      if (data.stderr) {
        if (out && !out.endsWith('\n')) out += '\n';
        out += data.stderr;
      }
      out = out.replace(/\n+$/, ''); // 去尾换行：新行由下方空回车补出，避免多一个空行
      term.write(out.replace(/\n/g, '\r\n'));
      if (data.timedOut) term.write((out ? '\r\n' : '') + '\x1b[33m执行超时，已终止\x1b[0m');
    }
  } catch {
    term.write(`${erasePending}\x1b[31m错误：网络异常，未执行\x1b[0m`);
  }
  // 空回车让远端 shell 打出新提示符，恢复可输入状态（无需手动按 Enter）
  if (tab.ws?.readyState === WebSocket.OPEN) tab.ws.send(encodeDataFrame('\r'));
}

/** 快捷命令栏：点击掩码执行（独立 exec 通道，终端只显示等长 * 与输出）；
 *  删除入口为按钮右上角叉号（悬停显现，点击直接删，无二次确认） */
function renderQuickBar(barEl, tab) {
  const cmds = getQuickCommands();
  barEl.innerHTML = cmds.length
    ? cmds
        .map(
          (c) => `<span class="quick-cmd-wrap">
            <button class="quick-cmd" data-id="${escapeHtml(c.id)}" title="点击执行（命令不回显，显示等长 *）">${escapeHtml(c.name)}</button>
            <button class="quick-cmd-del" data-id="${escapeHtml(c.id)}" title="删除该快捷命令">${icon('x', 10)}</button>
          </span>`
        )
        .join('')
    : '<span class="quick-empty">右键终端选中文字可「保存为快捷命令」，或在设置中管理</span>';
  barEl.querySelectorAll('.quick-cmd').forEach((b) =>
    b.addEventListener('click', () => {
      const c = cmds.find((x) => x.id === b.dataset.id);
      if (!c) return;
      runQuickCommand(tab, c); // 独立 exec 通道，与终端 WS 状态无关
      tab.term.focus();
    })
  );
  // 两段式删除：首次点击变红进入确认态（2s 超时自动退出），再点一次才真正删除
  barEl.querySelectorAll('.quick-cmd-del').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.classList.contains('confirming')) {
        clearTimeout(b._confirmTimer);
        removeQuickCommand(b.dataset.id); // onQuickCommandsChange 会重渲染命令栏
        return;
      }
      b.classList.add('confirming');
      b.title = '再点一次确认删除';
      b._confirmTimer = setTimeout(() => {
        b.classList.remove('confirming');
        b.title = '删除该快捷命令';
      }, 2000);
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
  // 非激活 tab（display:none）不 fit：零尺寸下 fit 会把行列打成 0；激活时 activateTab 会重新 fit 恢复
  if (!tab.el?.classList.contains('active')) return;
  try {
    tab.fitAddon.fit();
  } catch {
    return;
  }
  sendResize(tab);
}

/** 把本地终端当前尺寸同步给远端 pty（0x01 RESIZE 帧）；WS 未就绪时静默跳过 */
function sendResize(tab) {
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
  // 主动切换到某会话（点击会话卡 / 左侧连接）时重新定位可见窗口：
  // 该会话可能正被宽度隐藏，必须滑到可见位置（用户手动滑动不经过此路径，不会被拉回）
  pinnedTabId = null;
  for (const t of tabs.values()) t.el.classList.toggle('active', t.id === id);
  renderTabbar();
  // 重新显示后容器尺寸可能变化，需要重新 fit
  setTimeout(() => fitAndReport(tab), 50);
  tab.term.focus();
}

/** 关闭 tab（FR-046）：活动会话先弹确认（替代原生 confirm） */
export async function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  if (tab.ws && tab.ws.readyState === WebSocket.OPEN) {
    // R001：tmux 会话关闭提示不同——远端会话保留，重连可恢复现场
    const tmuxOn = tab.tmux?.state === 'active';
    const res = await confirmModal({
      title: '关闭会话',
      danger: true,
      iconName: 'monitor',
      confirmText: '关闭会话',
      extraText: '后台运行',
      message: `<strong>${escapeHtml(tab.host.name)}</strong> 的终端会话正在进行。`,
      note: `关闭将断开 SSH 连接${tmuxOn ? '（tmux 远端会话保留，重连可恢复现场）' : '，未写入文件的现场会丢失'}。后台运行则保持连接、只收起会话卡，可从右上角随时恢复。`,
    });
    if (res === 'extra') {
      backgroundTab(tab);
      return;
    }
    if (res !== true) return; // 取消
  }
  destroyTab(id);
}

/** 后台运行（FR-058）：会话卡从会话条收起，终端隐藏，WS 连接保持不断 */
export function backgroundTab(idOrTab) {
  const tab = typeof idOrTab === 'string' ? tabs.get(idOrTab) : idOrTab;
  if (!tab || tab.bg) return;
  tab.bg = true;
  tab.el.classList.remove('active');
  if (activeTabId === tab.id) {
    activeTabId = null;
    const next = visibleTabs().pop();
    if (next) {
      activateTab(next.id); // 内部会 renderTabbar
      notifyTabsChange();
      return;
    }
  }
  renderTabbar();
  notifyTabsChange();
}

/**
 * 审计页定位本地会话卡（FR-058）：
 * - 优先按服务端会话 ID 精确匹配
 * - 兜底：服务端未下发 ID 的旧会话（如后端未重启）按主机匹配唯一候选，避免误判为「其他页面」
 * @param {string} serverId 审计记录里的 sessionId
 * @param {string} hostId 审计记录里的主机 ID
 */
export function findLocalTab(serverId, hostId) {
  if (serverId) {
    const exact = findTabByServerId(serverId);
    if (exact) return exact;
  }
  if (!hostId) return null;
  const cands = [...tabs.values()].filter((t) => t.host.id === hostId && !t.serverSessionId);
  return cands.length === 1 ? cands[0] : null;
}

/** 按服务端会话 ID 定位本地会话卡（含后台运行的）：供审计页「继续连接」使用（FR-058） */
export function findTabByServerId(serverId) {
  if (!serverId) return null;
  for (const t of tabs.values()) {
    if (t.serverSessionId === serverId) return t;
  }
  return null;
}

/** 恢复后台会话到会话条并激活 */
export function restoreTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  tab.bg = false;
  activateTab(id);
  notifyTabsChange();
}

function visibleTabs() {
  return [...tabs.values()].filter((t) => !t.bg);
}

function backgroundTabs() {
  return [...tabs.values()].filter((t) => t.bg);
}

/** 后台会话菜单：列出后台会话（点击恢复），可一次性全部关闭 */
function showBackgroundMenu(x, y) {
  const list = backgroundTabs();
  if (!list.length) return;
  showContextMenu(x, y, {
    meta: `后台运行 ${list.length} 个会话`,
    items: [
      ...list.map((t) => ({
        label: t.label ?? t.host.name,
        onClick: () => restoreTab(t.id),
      })),
      'sep',
      {
        label: `全部关闭（${list.length}）`,
        danger: true,
        onClick: async () => {
          const ok = await confirmModal({
            title: '关闭后台会话',
            danger: true,
            iconName: 'trash',
            confirmText: '全部关闭',
            message: `将断开 <strong>${list.length}</strong> 个后台会话的 SSH 连接，现场不可恢复。`,
          });
          if (ok !== true) return;
          for (const t of list) destroyTab(t.id);
        },
      },
    ],
  });
}

// —— FR-059：服务端挂起（断线保活）的会话 ——
// 与本地「后台运行」不同：这些会话的浏览器连接已经消失（刷新/关窗口/掉线），
// SSH 连接仍由服务端持有，页面重新打开后可原样接管。
let detachedSessions = [];
let detachedRefreshTimer = null;

/** 拉取服务端保活会话并刷新会话条入口（主机已删除的会话不可恢复，直接忽略） */
export async function refreshDetachedSessions() {
  try {
    const [list, hosts] = await Promise.all([
      fetch(apiUrl('sessions')).then((r) => (r.ok ? r.json() : [])),
      fetchHosts(),
    ]);
    detachedSessions = (Array.isArray(list) ? list : [])
      .filter((s) => s.state === 'detached')
      .map((s) => ({ ...s, host: hosts.find((h) => h.id === s.hostId) }))
      .filter((s) => s.host);
  } catch {
    detachedSessions = [];
  }
  renderTabbar();
}

/** 保活会话菜单：点击恢复（接管），可一次性全部断开 */
function showDetachedMenu(x, y) {
  const list = detachedSessions;
  if (!list.length) return;
  showContextMenu(x, y, {
    meta: `${list.length} 个会话在服务端保活`,
    items: [
      ...list.map((s) => ({
        label: `${s.host.name} · ${s.id}`,
        onClick: async () => {
          const tab = await createTab(s.host, { attachId: s.id });
          if (tab) {
            activateTab(tab.id);
            refreshDetachedSessions();
          }
        },
      })),
      'sep',
      {
        label: `全部断开（${list.length}）`,
        danger: true,
        onClick: async () => {
          const ok = await confirmModal({
            title: '断开保活会话',
            danger: true,
            iconName: 'trash',
            confirmText: '全部断开',
            message: `将断开 <strong>${list.length}</strong> 个保活会话的 SSH 连接，现场不可恢复。`,
          });
          if (ok !== true) return;
          for (const s of list) {
            await fetch(apiUrl(`sessions/${encodeURIComponent(s.id)}`), { method: 'DELETE' }).catch(() => {});
          }
          refreshDetachedSessions();
        },
      },
    ],
  });
}

function destroyTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  if (tab.tmux) clearTimeout(tab.tmux.timer); // R001：清理探测超时定时器
  tab.zoomUnsub?.(); // 字号偏好订阅
  tab.resizeObserver?.disconnect();
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
  // 用户主动关闭：停止自动重连（标记 + 清定时器）
  tab.userClosed = true;
  if (tab.autoRetryTimer) clearTimeout(tab.autoRetryTimer);
  tabs.delete(id);
  if (activeTabId === id) {
    const next = visibleTabs().pop();
    if (next) activateTab(next.id);
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
  if (!ui?.tabStrip) return;
  const bar = ui.tabStrip;
  bar.innerHTML = '';
  const visible = visibleTabs(); // 后台会话不占会话条（FR-058）
  const bgCount = tabs.size - visible.length;
  ui.emptyState.style.display = visible.length ? 'none' : 'flex';
  // 空态提示位（显式按 ID 查找——快速连接面板内的 div:last-child 会抢匹配，导致副标题被清空）
  const hint = ui.emptyState.querySelector('#empty-hint');
  if (hint) {
    hint.textContent = !visible.length && bgCount ? `${bgCount} 个会话在后台运行` : '';
  }
  ui.tabbar.classList.toggle('has-bg', bgCount > 0);
  ui.tabbar.classList.toggle('has-detached', detachedSessions.length > 0);
  const dtCountEl = ui.tabbar.querySelector('#dt-count');
  if (dtCountEl) dtCountEl.textContent = detachedSessions.length ? String(detachedSessions.length) : '';
  const bgCountEl = ui.tabbar.querySelector('#bg-count');
  if (bgCountEl) bgCountEl.textContent = bgCount ? String(bgCount) : '';
  for (const t of visible) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === activeTabId ? ' active' : '');
    el.dataset.tabId = t.id;
    const isOpen = t.ws?.readyState === WebSocket.OPEN;
    el.innerHTML = `
      <span class="tab-status ${isOpen ? 'open' : ''}" title="${isOpen ? '已连接' : '连接中/已断开'}"></span>
      <span class="tab-label" title="双击修改备注名&#10;本地会话: ${t.sessionKey}${t.serverSessionId ? `&#10;服务端会话: ${t.serverSessionId}（审计中以此 ID 查）` : ''}${t.tmux ? `&#10;tmux 会话: ${t.tmux.state === 'active' ? t.tmux.name : '探测中/不可用'}` : ''}"></span>
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
  layoutTabs(); // 「新建会话」按钮常驻右侧工具区（见 buildTabbar）
}

/** 左右切换会话：dir = -1 向左 / 1 向右，越界由 layoutTabs 收敛 */
function shiftTabs(dir) {
  tabOffset += dir;
  layoutTabs();
}

/** 从 from 开始按可用宽度贪心计算可容纳的会话数量（至少 1 个） */
function capacityFrom(widths, avail, from) {
  let count = 0;
  let used = 0;
  for (let i = from; i < widths.length; i++) {
    if (used + widths[i] > avail) break;
    used += widths[i];
    count++;
  }
  return Math.max(1, count);
}

/**
 * 按窗口宽度决定当前展示的会话数量：容纳得下则全部展示；容纳不下则隐藏溢出会话卡
 * 并启用右侧左右切换（不出现横向滚动条）。活动会话始终保证可见。
 */
function layoutTabs() {
  if (!ui?.tabStrip) return;
  const strip = ui.tabStrip;
  const els = [...strip.querySelectorAll('.tab')];
  if (!els.length) {
    ui.tabbar.classList.remove('overflowing');
    tabOffset = 0;
    pinnedTabId = null;
    return;
  }
  // 先全部显示以量取自然宽度（.tab 为 flex:none，不会被压缩）
  els.forEach((el) => el.classList.remove('hidden'));
  const GAP = 4; // .tab 左右各 2px 外边距
  const widths = els.map((el) => el.offsetWidth + GAP);
  const avail = strip.clientWidth;
  const total = widths.reduce((a, b) => a + b, 0);
  if (total <= avail) {
    ui.tabbar.classList.remove('overflowing');
    tabOffset = 0;
    updateNavButtons(els.length, els.length);
    return;
  }
  ui.tabbar.classList.add('overflowing');
  tabOffset = Math.max(0, Math.min(tabOffset, els.length - 1));
  // 活动会话必须在窗口内：越界时以它作为最后一个可见项向左回退
  // 仅活动会话发生变化时定位一次，用户手动左右滑动后不再强行拉回
  const activeIdx = els.findIndex((el) => el.dataset.tabId === activeTabId);
  if (activeIdx >= 0 && activeTabId !== pinnedTabId) {
    pinnedTabId = activeTabId;
    let visible = capacityFrom(widths, avail, tabOffset);
    if (activeIdx < tabOffset || activeIdx >= tabOffset + visible) {
      let start = activeIdx;
      let used = widths[activeIdx];
      for (let i = activeIdx - 1; i >= 0; i--) {
        if (used + widths[i] > avail) break;
        used += widths[i];
        start = i;
      }
      tabOffset = start;
      visible = capacityFrom(widths, avail, tabOffset);
    }
  }
  let capacity = capacityFrom(widths, avail, tabOffset);
  // 已滑到末尾时向左回退填满：窗口变宽后要把空出来的位置补上，不能只留尾部几个
  if (tabOffset + capacity >= els.length) {
    let start = els.length - 1;
    let used = widths[els.length - 1];
    for (let i = els.length - 2; i >= 0; i--) {
      if (used + widths[i] > avail) break;
      used += widths[i];
      start = i;
    }
    tabOffset = start;
    capacity = capacityFrom(widths, avail, tabOffset);
  }
  els.forEach((el, i) => el.classList.toggle('hidden', i < tabOffset || i >= tabOffset + capacity));
  updateNavButtons(tabOffset + capacity, els.length);
}

function updateNavButtons(visibleEnd, total) {
  const prev = ui.tabbar.querySelector('#tab-nav-prev');
  const next = ui.tabbar.querySelector('#tab-nav-next');
  if (prev) prev.disabled = tabOffset <= 0;
  if (next) next.disabled = visibleEnd >= total;
}

/** 保证指定会话卡可见（宽度不足时先滑到它再操作，如双击改名） */
function ensureTabVisible(id) {
  if (!ui?.tabStrip) return;
  const el = ui.tabStrip.querySelector(`.tab[data-tab-id="${id}"]`);
  if (el && el.classList.contains('hidden')) {
    const els = [...ui.tabStrip.querySelectorAll('.tab')];
    tabOffset = els.indexOf(el);
    layoutTabs();
  }
}

/** 新建会话：弹出主机选择（连接需要选定主机） */
async function openSessionPicker() {
  // 「仅 MCP」范围的连接不出现在终端会话选择器中（终端入口对其关闭）
  const hosts = (await fetchHosts()).filter((h) => (h.scope ?? 'all') !== 'mcp');
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
      if (host) connectHost(host, { tmux });
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
  ensureTabVisible(tab.id); // 会话卡被宽度隐藏时先滑到可见位置再进入编辑态
  const labelEl = ui.tabbar.querySelector(`.tab[data-tab-id="${tab.id}"] .tab-label`);
  if (!labelEl) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 64;
  input.value = tab.label ?? tab.host.name;
  input.className = 'tab-rename';
  // 沿用标签实测宽度：进入编辑态时会话卡宽度保持不变（超出宽度的文本在输入框内滚动）
  input.style.minWidth = '0';
  input.style.width = `${labelEl.offsetWidth}px`;
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
    meta: `会话 ${tab.sessionKey}${tab.serverSessionId ? ` · 服务端 ${tab.serverSessionId}` : ''}${tab.tmux ? ` · tmux: ${tab.tmux.name}` : ''}`,
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
      { label: '后台运行', onClick: () => backgroundTab(tab) },
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

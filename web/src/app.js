// 应用外壳（FR-044）：左侧主机栏 + 右侧多 tab 终端区 + 左下角设置 + beforeunload 会话保护
import { initTheme, currentThemeMode, setTheme } from './theme.js';
import { icon } from './icons.js';
import { renderHostList, openHostFormModal, showHostMenu, fetchHosts, escapeHtml } from './hosts.js';
import { openSettingsModal, openProfileModal, openDocsModal } from './settings.js';
import { isModalOpen, closeModal } from './modal.js';
import { renderAudit } from './audit.js';
import { renderTokens } from './tokens.js';
import { renderTokenConfig, renderTokenAdvanced, renderPermPolicy } from './token-config.js';
import { renderGroups } from './groups.js';
import { getPrefs } from './prefs.js';
import { getRuntime, getIdentity, apiUrl } from './base.js';
import { showContextMenu } from './contextmenu.js';
import * as terminal from './terminal.js';

initTheme();

const hostList = document.getElementById('host-list');
const tabbar = document.getElementById('tabbar');
const terminals = document.getElementById('terminals');
const emptyState = document.getElementById('empty-state');

terminal.mountTerminalArea({ tabbar, terminals, emptyState });

// 会话状态变化 → 刷新侧栏「已连接」标记
terminal.onTabsChange(() => refreshHostList());

function refreshHostList() {
  renderHostList(hostList, {
    onConnect: (host) => terminal.connectHost(host),
    connectedIds: terminal.connectedHostIds(),
    onChanged: refreshHostList,
  });
  renderQuickConnect(); // 空态面板联动刷新（异步自守卫，空态不可见时直接丢弃）
}

/** 相对时间：1 分钟内 N 秒前 / 1 小时内 N 分钟前 / 1 天内 N 小时前 / 7 天内 N 天前 / 更早显示具体日期 */
function fmtAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} 天前`;
  return new Date(ts).toLocaleDateString();
}

/** 空态「快速连接」面板：按最近连接排序的主机卡片（最多 12 个）。
 *  单击直连，右键出与侧栏一致的管理菜单；仅 MCP 授权的连接不展示（无终端）。 */
let qcRenderSeq = 0;
async function renderQuickConnect() {
  const box = document.getElementById('quick-connect');
  if (!box) return;
  const seq = ++qcRenderSeq;
  const hosts = await fetchHosts().catch(() => []);
  if (seq !== qcRenderSeq || emptyState.style.display === 'none') return; // 过期/空态不可见：丢弃
  const usable = hosts
    .filter((h) => (h.scope ?? 'all') !== 'mcp')
    .sort((a, b) => (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0) || a.name.localeCompare(b.name));
  if (!usable.length) {
    box.innerHTML = `<div class="big">⌨</div>
      <div>在左侧选择主机开始连接</div>
      <button class="btn primary" id="qc-new">新建会话连接</button>`;
    box.querySelector('#qc-new').addEventListener('click', () => openHostFormModal(null, refreshHostList));
    return;
  }
  box.innerHTML = `
    <div class="qcc-head">
      <div class="qcc-title">${icon('zap', 15)} 快速连接</div>
      <div class="qcc-sub">按最近连接排序 · 单击连接 · 右键管理 · 空白处右键新建</div>
    </div>
    <div class="qcc-grid">${usable.slice(0, 5).map((h, i) => `
      <button class="qcc-card" data-id="${escapeHtml(h.id)}" style="animation-delay: ${i * 40}ms">
        <span class="qcc-card-main">
          <span class="qcc-card-name">${escapeHtml(h.name)}</span>
          <span class="qcc-card-meta">${escapeHtml(h.username)}@${escapeHtml(h.host)}:${h.port}</span>
        </span>
        ${h.lastConnectedAt ? `<span class="qcc-card-time" title="上次连接：${escapeHtml(new Date(h.lastConnectedAt).toLocaleString())}">${fmtAgo(h.lastConnectedAt)}</span>` : ''}
      </button>`).join('')}
    </div>`;
  box.querySelectorAll('.qcc-card').forEach((card) => {
    const host = usable.find((h) => h.id === card.dataset.id);
    if (!host) return;
    card.addEventListener('click', () => terminal.connectHost(host));
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showHostMenu(host, e.clientX, e.clientY, {
        onConnect: (h) => terminal.connectHost(h),
        onChanged: refreshHostList,
      });
    });
  });
}

// 空态空白处右键 → 新建会话连接（与侧栏空白右键一致）
emptyState.addEventListener('contextmenu', (e) => {
  if (e.target.closest('.qcc-card')) return;
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY, {
    items: [{ label: '新建会话连接', onClick: () => openHostFormModal(null, refreshHostList) }],
  });
});

// 初次渲染（须在 quick-connect 相关声明之后，避免 TDZ）
refreshHostList();

// 用户入口（FR-047）：左下角头像+用户名；standalone 灰色头像区分本地单用户
// 点击弹出用户菜单（向上弹）：资料头（头像+用户名，点击进个人设置）/ 个人设置 / 使用文档 / 设置
// R003：昵称/头像来自 /api/profile；展示格式：有昵称 = 账号(昵称)，如 local(本地)；无昵称仅账号名
let currentUser = { name: '…', avatarText: '…', avatarUrl: null, local: false };
async function refreshUserDisplay() {
  const [identity, runtime] = await Promise.all([getIdentity(), getRuntime()]);
  let profile = null;
  try {
    const r = await fetch(apiUrl('profile'));
    if (r.ok) profile = await r.json();
  } catch {
    /* 接口不可用时按 identity 回退，不阻塞 UI */
  }
  const account = identity.username || identity.id || '—';
  const displayName = profile?.nickname ? `${account}(${profile.nickname})` : account;
  const avatarUrl = profile?.hasAvatar
    ? `${apiUrl('profile/avatar')}${profile.avatarUpdatedAt ? `?v=${encodeURIComponent(profile.avatarUpdatedAt)}` : ''}`
    : null;
  const avatarEl = document.getElementById('user-avatar');
  avatarEl.classList.remove('local', 'img');
  avatarEl.style.backgroundImage = '';
  if (avatarUrl) {
    avatarEl.textContent = '';
    avatarEl.classList.add('img');
    avatarEl.style.backgroundImage = `url("${avatarUrl}")`;
  } else {
    // 头像回退字优先取昵称首字（个性化），无昵称取账号名首字
    const avatarSeed = profile?.nickname || account;
    avatarEl.textContent = String(avatarSeed).trim().charAt(0) || '—';
    if (runtime.mode === 'standalone') avatarEl.classList.add('local');
  }
  document.getElementById('user-name').textContent = displayName;
  currentUser = {
    name: displayName,
    avatarText: avatarEl.textContent,
    avatarUrl,
    local: runtime.mode === 'standalone',
  };
}
refreshUserDisplay();

// 设置类弹窗统一入口（菜单与滚轮互切复用同一组注入）
const openSettings = (pane) =>
  openSettingsModal({ renderAudit, renderGroups, onGroupsChanged: refreshHostList }, pane);
const openProfile = (pane) =>
  openProfileModal({ renderTokens, renderTokenConfig, renderTokenAdvanced, renderPermPolicy, onProfileChanged: refreshUserDisplay }, pane);

// 滚轮互切「设置」/「个人设置」：上滑→个人设置、下滑→设置（竖向顺序与用户菜单一致）
// 弹框内部及顶部/底部遮罩区滚动保持原行为；只有光标在左右两侧遮罩靠屏幕边缘的 1/3 区域滚动时才互切
let wheelSwitching = false; // 过渡动画进行中，防止连续滚轮重复触发
document.addEventListener(
  'wheel',
  (e) => {
    if (!isModalOpen()) return;
    if (document.querySelector('.audit-detail-overlay.show')) return; // 浮层优先（与 ESC/Enter 一致）
    const box = document.querySelector('#modal-root .modal.settings-modal');
    if (!box) return;
    const title = box.querySelector('#modal-title')?.textContent;
    if (title !== '设置' && title !== '个人设置') return;
    // 光标在弹框内部（含标题栏/左侧页签/内容区）时不干预
    if (e.target instanceof Element && box.contains(e.target)) return;
    // 触发区仅左右两侧遮罩靠屏幕边缘的 1/3：左侧间隙最左 1/3、右侧间隙最右 1/3；顶部/底部不响应
    const r = box.getBoundingClientRect();
    const { clientX: x } = e;
    const nearEdge =
      (x < r.left && x < r.left / 3) ||
      (x > r.right && innerWidth - x < (innerWidth - r.right) / 3);
    if (!nearEdge) return;
    const dir = e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0;
    if (!dir || Math.abs(e.deltaY) < 4) return; // 忽略触控板细微抖动
    const target = dir < 0 ? '个人设置' : '设置';
    if (target === title || wheelSwitching) return;
    e.preventDefault();
    const openTarget = () => (target === '设置' ? openSettings() : openProfile());
    // 用户系统偏好「减少动态效果」时保持直接切换
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      closeModal();
      openTarget();
      return;
    }
    // 丝滑互切：旧弹窗沿滚动方向淡出，新弹窗从对侧淡入
    wheelSwitching = true;
    box.classList.add(dir > 0 ? 'switch-out-down' : 'switch-out-up');
    let finished = false;
    const onEnd = (ev) => {
      if (ev.target === box) finish();
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      box.removeEventListener('animationend', onEnd);
      // 不走 closeModal：保留 .show 避免遮罩重放 fadeIn 闪烁；openModal 会重置内容
      const m = openTarget();
      m.root.classList.add(dir > 0 ? 'switch-in-down' : 'switch-in-up');
      wheelSwitching = false;
    };
    box.addEventListener('animationend', onEnd);
    setTimeout(finish, 550); // 兜底：略长于 .45s 淡出动画，animationend 未触发时也能完成切换
  },
  { passive: false }
);

document.getElementById('btn-user').addEventListener('click', (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  showContextMenu(rect.left + 2, rect.top - 6, {
    above: true,
    minWidth: 224,
    profile: {
      avatarText: currentUser.avatarText,
      avatarUrl: currentUser.avatarUrl,
      name: currentUser.name,
      local: currentUser.local,
      onClick: () => openProfile(),
    },
    // 外观快速开关（自动/浅色/深色）：点了立即生效且菜单保留
    section: (el) => {
      el.innerHTML = `<div class="ctx-theme-switch">
        <span class="ctx-theme-thumb"></span>
        <button type="button" data-t="auto">${icon('monitor', 13)}自动</button>
        <button type="button" data-t="light">${icon('sun', 13)}浅色</button>
        <button type="button" data-t="dark">${icon('moon', 13)}深色</button>
      </div>`;
      const thumb = el.querySelector('.ctx-theme-thumb');
      const paint = () => {
        el.querySelectorAll('button').forEach((b) =>
          b.classList.toggle('active', b.dataset.t === currentThemeMode())
        );
        const active = el.querySelector('button.active');
        if (!active) return;
        // 滑块贴合选中项：offsetLeft 含容器 3px 内边距，滑块 left 已锚定 3px
        thumb.style.width = `${active.offsetWidth}px`;
        thumb.style.transform = `translateX(${active.offsetLeft - 3}px)`;
      };
      // 菜单 display:none 时无法测量：首帧（显示后）无动画定位，次帧开启滑动过渡
      requestAnimationFrame(() => {
        paint();
        requestAnimationFrame(() => thumb.classList.add('anim'));
      });
      el.querySelectorAll('button').forEach((b) =>
        b.addEventListener('click', () => {
          setTheme(b.dataset.t);
          paint();
        })
      );
    },
    items: [
      { label: '设置', icon: 'gear', onClick: () => openSettings() },
      { label: '外部集成', icon: 'plug', onClick: () => openProfile('tokens') },
      { label: '使用文档', icon: 'file', onClick: () => openDocsModal() },
      { label: '意见反馈', icon: 'message', disabled: true },
      { label: '检查更新', icon: 'refresh', disabled: true },
    ],
  });
});

// 新增主机入口：侧栏主机列表底部虚线新增框（在 hosts.js renderHostList 中绑定）

// 关闭页面前检查活动会话（FR-046；可在通用设置中关闭确认）
window.addEventListener('beforeunload', (e) => {
  if (getPrefs().exitConfirm && terminal.hasActiveSessions()) {
    e.preventDefault();
    e.returnValue = '仍有终端会话在进行，关闭页面将断开连接。';
    return e.returnValue;
  }
});

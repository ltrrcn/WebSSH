// 应用外壳（FR-044）：左侧主机栏 + 右侧多 tab 终端区 + 左下角设置 + beforeunload 会话保护
import { initTheme, currentThemeMode, setTheme } from './theme.js';
import { icon } from './icons.js';
import { renderHostList, openHostFormModal } from './hosts.js';
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
}
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
        <button type="button" data-t="auto">${icon('monitor', 13)} 自动</button>
        <button type="button" data-t="light">${icon('sun', 13)} 浅色</button>
        <button type="button" data-t="dark">${icon('moon', 13)} 深色</button>
      </div>`;
      const paint = () =>
        el.querySelectorAll('button').forEach((b) =>
          b.classList.toggle('active', b.dataset.t === currentThemeMode())
        );
      paint();
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

// 新增主机入口：侧栏头部（按钮在 index.html 中）
document
  .getElementById('btn-add-host')
  .addEventListener('click', () => openHostFormModal(null, refreshHostList));

// 关闭页面前检查活动会话（FR-046；可在通用设置中关闭确认）
window.addEventListener('beforeunload', (e) => {
  if (getPrefs().exitConfirm && terminal.hasActiveSessions()) {
    e.preventDefault();
    e.returnValue = '仍有终端会话在进行，关闭页面将断开连接。';
    return e.returnValue;
  }
});

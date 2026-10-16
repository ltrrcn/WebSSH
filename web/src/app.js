// 应用外壳（FR-044）：左侧主机栏 + 右侧多 tab 终端区 + 左下角设置 + beforeunload 会话保护
import { initTheme, currentThemeMode, setTheme } from './theme.js';
import { icon } from './icons.js';
import { renderHostList, openHostFormModal } from './hosts.js';
import { openSettingsModal, openProfileModal, openDocsModal } from './settings.js';
import { renderAudit } from './audit.js';
import { renderTokens } from './tokens.js';
import { renderTokenConfig, renderPermPolicy } from './token-config.js';
import { renderGroups } from './groups.js';
import { getPrefs } from './prefs.js';
import { getRuntime, getIdentity } from './base.js';
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
let currentUser = { name: '…', avatarText: '…', local: false };
Promise.all([getIdentity(), getRuntime()]).then(([identity, runtime]) => {
  const name = identity.username || identity.id;
  const avatarEl = document.getElementById('user-avatar');
  avatarEl.textContent = (name || '—').trim().charAt(0) || '—';
  if (runtime.mode === 'standalone') avatarEl.classList.add('local');
  document.getElementById('user-name').textContent = name;
  currentUser = { name, avatarText: avatarEl.textContent, local: runtime.mode === 'standalone' };
});
document.getElementById('btn-user').addEventListener('click', (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  showContextMenu(rect.left + 2, rect.top - 6, {
    above: true,
    minWidth: 224,
    profile: {
      avatarText: currentUser.avatarText,
      name: currentUser.name,
      local: currentUser.local,
      onClick: () => openProfileModal({ renderTokens, renderTokenConfig }),
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
      { label: '设置', icon: 'gear', onClick: () => openSettingsModal({ renderAudit, renderPermPolicy, renderGroups, onGroupsChanged: refreshHostList }) },
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

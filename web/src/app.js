// 应用外壳（FR-044）：左侧主机栏 + 右侧多 tab 终端区 + 左下角设置 + beforeunload 会话保护
import { initTheme } from './theme.js';
import { renderHostList, openHostFormModal } from './hosts.js';
import { openSettingsModal } from './settings.js';
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

// 设置入口（FR-047）
document.getElementById('btn-settings').addEventListener('click', () => {
  openSettingsModal({
    // US4/US6 交付后在此注入：renderAudit / renderTokens
  });
});

// 新增主机入口：侧栏头部
const addBtn = document.createElement('button');
addBtn.className = 'icon-btn';
addBtn.title = '新增主机';
addBtn.textContent = '＋';
addBtn.style.fontSize = '16px';
document.querySelector('.sidebar-header').appendChild(addBtn);
addBtn.addEventListener('click', () => openHostFormModal(null, refreshHostList));

// 关闭页面前检查活动会话（FR-046）
window.addEventListener('beforeunload', (e) => {
  if (terminal.hasActiveSessions()) {
    e.preventDefault();
    e.returnValue = '仍有终端会话在进行，关闭页面将断开连接。';
    return e.returnValue;
  }
});

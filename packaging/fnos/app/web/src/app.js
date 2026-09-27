// 应用外壳（FR-044）：左侧主机栏 + 右侧多 tab 终端区 + 左下角设置 + beforeunload 会话保护
import { initTheme } from './theme.js';
import { renderHostList, openHostFormModal } from './hosts.js';
import { openSettingsModal } from './settings.js';
import { renderAudit } from './audit.js';
import { renderTokens } from './tokens.js';
import { renderTokenConfig } from './token-config.js';
import { renderGroups } from './groups.js';
import { getPrefs } from './prefs.js';
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

// 设置入口（FR-047）；审计/令牌/令牌配置/分组页签注入渲染
document.getElementById('btn-settings').addEventListener('click', () => {
  openSettingsModal({ renderAudit, renderTokens, renderTokenConfig, renderGroups, onGroupsChanged: refreshHostList });
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

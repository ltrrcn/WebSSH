// 设置弹窗（FR-047）：主题切换 + 审计/令牌入口收纳于此
import { openModal } from './modal.js';
import { currentTheme, setTheme } from './theme.js';
import { icon } from './icons.js';

/**
 * 打开设置弹窗。
 * @param {{renderAudit?: (el: HTMLElement)=>void, renderTokens?: (el: HTMLElement)=>void, renderTokenConfig?: (el: HTMLElement)=>void}} pages
 *   US4/US6 交付后由 app.js 注入对应页面渲染函数；当前为占位。
 */
export function openSettingsModal({ renderAudit, renderTokens, renderTokenConfig, renderGroups, onGroupsChanged } = {}) {
  const groupsChanged = onGroupsChanged;
  const m = openModal(
    `<div class="settings-layout">
      <div class="settings-nav">
        <button data-pane="theme" class="active">${icon('palette')} 主题</button>
        <button data-pane="groups">${icon('folder')} 分组</button>
        <button data-pane="audit">${icon('list')} 审计</button>
        <button data-pane="tokens">${icon('key')} 令牌</button>
        <button data-pane="tokenConfig">${icon('shield')} 令牌配置</button>
      </div>
      <div id="settings-pane" class="settings-content"></div>
    </div>`,
    // 关闭时移除大尺寸 class，避免影响其他弹窗（modal 为全局单例）
    { onclose: () => m.root.classList.remove('settings-modal') }
  );
  m.root.classList.add('settings-modal');
  m.setTitle('设置');

  const nav = m.root.querySelector('.settings-nav');
  const pane = m.root.querySelector('#settings-pane');

  const panes = {
    theme: () => {
      const cur = currentTheme();
      pane.innerHTML = `
        <div class="theme-row">
          <div class="theme-option ${cur === 'dark' ? 'selected' : ''}" data-theme="dark">
            <div class="swatch dark"></div>黑色主题
          </div>
          <div class="theme-option ${cur === 'light' ? 'selected' : ''}" data-theme="light">
            <div class="swatch light"></div>白色主题
          </div>
        </div>
        <p class="form-note" style="margin-top:12px">后续版本支持导入终端配色方案（如 iTerm 配色）。</p>`;
      pane.querySelectorAll('.theme-option').forEach((opt) =>
        opt.addEventListener('click', () => {
          setTheme(opt.dataset.theme);
          pane.querySelectorAll('.theme-option').forEach((o) =>
            o.classList.toggle('selected', o === opt)
          );
        })
      );
    },
    audit: () => {
      if (renderAudit) renderAudit(pane);
      else
        pane.innerHTML =
          '<div class="placeholder-box">审计功能将在 US4 阶段交付（当前连接记录已在服务端留痕）。</div>';
    },
    tokens: () => {
      if (renderTokens) renderTokens(pane);
      else pane.innerHTML = '<div class="placeholder-box">MCP 令牌功能将在 US6 阶段交付。</div>';
    },
    tokenConfig: () => {
      if (renderTokenConfig) renderTokenConfig(pane);
      else pane.innerHTML = '<div class="placeholder-box">令牌配置将在 US6 阶段交付。</div>';
    },
    groups: () => {
      if (renderGroups) renderGroups(pane, { onChanged: groupsChanged });
      else pane.innerHTML = '<div class="placeholder-box">分组管理占位。</div>';
    },
  };

  nav.querySelectorAll('button').forEach((btn) =>
    btn.addEventListener('click', () => {
      nav.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
      panes[btn.dataset.pane]();
    })
  );
  panes.theme();
  return m;
}

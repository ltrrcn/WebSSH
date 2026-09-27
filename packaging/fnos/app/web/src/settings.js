// 设置弹窗（FR-047）：主题切换 + 审计/令牌入口收纳于此
import { openModal } from './modal.js';
import { currentThemeMode, setTheme } from './theme.js';
import { icon } from './icons.js';
import { getPrefs, setPref } from './prefs.js';
import { getQuickCommands, addQuickCommand, removeQuickCommand } from './quick-commands.js';

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
        <button data-pane="theme" class="active">${icon('palette')} 通用设置</button>
        <button data-pane="groups">${icon('folder')} 分组管理</button>
        <button data-pane="audit">${icon('list')} 命令审计</button>
        <button data-pane="tokens">${icon('key')} 令牌管理</button>
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
      const mode = currentThemeMode();
      const prefs = getPrefs();
      pane.innerHTML = `
        <div class="pref-section">
          <div class="pref-title">语言</div>
          <div class="pref-row">
            <div class="pref-label">界面语言<div class="pref-desc">当前默认中文（简体）</div></div>
            <select id="pref-lang" class="pref-select">
              <option value="zh-CN" selected>中文（简体）</option>
              <option value="en" disabled title="英文界面将在后续版本提供">English</option>
            </select>
          </div>
        </div>
        <div class="pref-section">
          <div class="pref-title">外观</div>
          <div class="pref-row" style="flex-direction:column;align-items:stretch">
            <div class="pref-label">主题<div class="pref-desc">「跟随系统」随操作系统明暗实时切换；主动选择浅色/深色后持久保持，不随系统变化</div></div>
            <div class="theme-row">
              <div class="theme-option ${mode === 'auto' ? 'selected' : ''}" data-theme="auto">
                ${icon('monitor', 26)}<span>跟随系统</span>
              </div>
              <div class="theme-option ${mode === 'light' ? 'selected' : ''}" data-theme="light">
                ${icon('sun', 26)}<span>浅色</span>
              </div>
              <div class="theme-option ${mode === 'dark' ? 'selected' : ''}" data-theme="dark">
                ${icon('moon', 26)}<span>深色</span>
              </div>
            </div>
          </div>
        </div>
        <div class="pref-section">
          <div class="pref-title">终端</div>
          <div class="pref-row">
            <div class="pref-label">字号<div class="pref-desc">立即应用于已打开的终端</div></div>
            <div class="pref-inline">
              <input type="range" id="pref-fontsize" min="12" max="18" step="1" value="${prefs.fontSize}" />
              <code id="pref-fontsize-val">${prefs.fontSize} px</code>
            </div>
          </div>
          <div class="pref-row">
            <div class="pref-label">光标闪烁</div>
            <label class="switch"><input type="checkbox" id="pref-blink" ${prefs.cursorBlink ? 'checked' : ''} /><span></span></label>
          </div>
        </div>
        <div class="pref-section">
          <div class="pref-title">行为</div>
          <div class="pref-row">
            <div class="pref-label">关闭页面前确认<div class="pref-desc">存在活动终端会话时，离开页面弹出确认</div></div>
            <label class="switch"><input type="checkbox" id="pref-exit" ${prefs.exitConfirm ? 'checked' : ''} /><span></span></label>
          </div>
        </div>
        <div class="pref-section">
          <div class="pref-title">快捷命令</div>
          <div class="pref-row" style="align-items:flex-end">
            <div class="pref-label" style="flex:1">名称<input id="qc-name" class="pref-input" placeholder="如：查看负载" maxlength="32" /></div>
            <div class="pref-label" style="flex:2">命令<input id="qc-cmd" class="pref-input" placeholder="如：uptime && df -h" maxlength="200" /></div>
            <button class="btn primary" id="qc-add">添加</button>
          </div>
          <div id="qc-list"></div>
        </div>
        <p class="form-note" style="margin-top:14px">快捷命令显示在终端底部命令栏，点击即发送执行（含回车）。高级偏好（终端配色方案导入等）将在后续版本提供。</p>`;
      pane.querySelectorAll('.theme-option').forEach((opt) =>
        opt.addEventListener('click', () => {
          setTheme(opt.dataset.theme);
          pane.querySelectorAll('.theme-option').forEach((o) =>
            o.classList.toggle('selected', o === opt)
          );
        })
      );
      const fs = pane.querySelector('#pref-fontsize');
      const fsVal = pane.querySelector('#pref-fontsize-val');
      const paintRange = (el) => {
        const pct = ((el.value - el.min) / (el.max - el.min)) * 100;
        el.style.background = `linear-gradient(to right, var(--accent) ${pct}%, var(--bg-hover) ${pct}%)`;
      };
      paintRange(fs);
      fs.addEventListener('input', () => {
        fsVal.textContent = `${fs.value} px`;
        paintRange(fs);
        setPref('fontSize', Number(fs.value));
      });
      pane.querySelector('#pref-blink').addEventListener('change', (e) => {
        setPref('cursorBlink', e.target.checked);
      });
      pane.querySelector('#pref-exit').addEventListener('change', (e) => {
        setPref('exitConfirm', e.target.checked);
      });

      // —— 快捷命令管理 ——
      const qcList = pane.querySelector('#qc-list');
      const qcName = pane.querySelector('#qc-name');
      const qcCmd = pane.querySelector('#qc-cmd');
      const renderQc = () => {
        const cmds = getQuickCommands();
        qcList.innerHTML = cmds.length
          ? cmds
              .map(
                (c) => `<div class="qc-row" data-id="${escapeAttr(c.id)}">
                  <span class="qc-name">${escapeText(c.name)}</span>
                  <code class="qc-cmd" title="${escapeAttr(c.cmd)}">${escapeText(c.cmd)}</code>
                  <button class="icon-btn danger-text qc-del" title="删除">${icon('trash', 12)}</button>
                </div>`
              )
              .join('')
          : '<div class="qc-empty">暂无快捷命令。终端中选中文字右键可快速保存。</div>';
        qcList.querySelectorAll('.qc-del').forEach((b) =>
          b.addEventListener('click', () => {
            removeQuickCommand(b.closest('.qc-row').dataset.id);
            renderQc();
          })
        );
      };
      pane.querySelector('#qc-add').addEventListener('click', () => {
        const name = qcName.value.trim();
        const cmd = qcCmd.value.trim();
        if (!name || !cmd) return alert('名称与命令都不能为空');
        addQuickCommand(name, cmd);
        qcName.value = '';
        qcCmd.value = '';
        renderQc();
      });
      qcCmd.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') pane.querySelector('#qc-add').click();
      });
      renderQc();
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

function escapeText(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}
function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// 设置弹窗（FR-047）：「设置」（通用/快捷命令/分组/审计/2FA/权限）+「个人设置」（令牌类）+「使用文档」（独立单页）三个弹窗，共享页签骨架
import { openModal } from './modal.js';
import { currentThemeMode, setTheme } from './theme.js';
import { icon } from './icons.js';
import { getPrefs, setPref, FONT_OPTIONS } from './prefs.js';
import { apiUrl } from './base.js';
import { renderQuickCommandsPane } from './quick-commands-ui.js';
import { renderDocs } from './docs.js';
import { renderTwofaPane, apiFetch } from './twofa.js';

// 弹窗页签集：设置（通用/审计/2FA/权限类，还原拆分前顺序）与 个人设置（令牌类）分离
const SETTINGS_TABS = [
  { key: 'theme', icon: 'palette', label: '通用设置' },
  { key: 'quickCmds', icon: 'play', label: '快捷命令' },
  { key: 'groups', icon: 'folder', label: '分组管理' },
  { key: 'opsAudit', icon: 'list', label: '操作审计' },
  { key: 'cmdAudit', icon: 'play', label: '命令审计' },
  { key: 'twofa', icon: 'shield', label: '两步验证' },
  { key: 'permPolicy', icon: 'ban', label: '权限策略' },
];
const PROFILE_TABS = [
  { key: 'tokens', icon: 'key', label: '令牌管理' },
  { key: 'tokenConfig', icon: 'shield', label: '令牌配置' },
];

/** 页签弹窗公共骨架：左侧竖向导航 + 右侧内容区；nav=false 时无导航、内容全宽（单页弹窗） */
function openTabbedModal({ title, tabs, injections, defaultPane, nav: withNav = true }) {
  const m = openModal(
    `<div class="settings-layout">
      ${withNav ? `<div class="settings-nav">
        ${tabs.map((t) => `<button data-pane="${t.key}">${icon(t.icon)} ${t.label}</button>`).join('')}
      </div>` : ''}
      <div id="settings-pane" class="settings-content"></div>
    </div>`,
    // 关闭时移除大尺寸 class，避免影响其他弹窗（modal 为全局单例）
    { onclose: () => m.root.classList.remove('settings-modal') }
  );
  m.root.classList.add('settings-modal');
  m.setTitle(title);

  const pane = m.root.querySelector('#settings-pane');
  const panes = buildPanes(pane, injections);
  if (withNav) {
    const nav = m.root.querySelector('.settings-nav');
    nav.querySelectorAll('button').forEach((btn) =>
      btn.addEventListener('click', () => {
        nav.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
        panes[btn.dataset.pane]();
      })
    );
    nav.querySelector(`[data-pane="${defaultPane}"]`).classList.add('active');
  }
  panes[defaultPane]();
  return m;
}

/** 构建全部页签渲染函数（设置类与安全类共享闭包注入） */
function buildPanes(pane, { renderAudit, renderTokens, renderTokenConfig, renderPermPolicy, renderGroups, onGroupsChanged: groupsChanged }) {
  return {
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
          <div class="pref-row">
            <div class="pref-label">界面字体<div class="pref-desc">全局生效；终端始终使用等宽字体，不受此设置影响</div></div>
            <select id="pref-fontfamily" class="pref-select">
              ${FONT_OPTIONS.map(
                (o) =>
                  `<option value="${o.value.replace(/"/g, '&quot;')}" ${prefs.fontFamily === o.value ? 'selected' : ''}>${o.label}</option>`
              ).join('')}
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
          <div class="pref-row">
            <div class="pref-label">新建会话默认 tmux 保活
              <div class="pref-desc">新建会话弹窗默认勾选「以 tmux 保活会话连接」；远端未安装 tmux 时会自动提示并按普通终端继续</div>
            </div>
            <label class="switch"><input type="checkbox" id="pref-tmux" ${prefs.tmuxDefault ? 'checked' : ''} /><span></span></label>
          </div>
        </div>
        <div class="pref-section">
          <div class="pref-title">行为</div>
          <div class="pref-row">
            <div class="pref-label">关闭页面前确认<div class="pref-desc">存在活动终端会话时，离开页面弹出确认</div></div>
            <label class="switch"><input type="checkbox" id="pref-exit" ${prefs.exitConfirm ? 'checked' : ''} /><span></span></label>
          </div>
          <div class="pref-row">
            <div class="pref-label">记录终端输出摘要
              <div class="pref-desc" id="pref-audit-output-desc">默认关闭：命令审计只记命令原文与元数据。开启后每条命令附带其输出摘要（自动脱敏并截断，命令审计页「查看」可见）。与设置中两步验证面板的开关为同一设置</div>
            </div>
            <label class="switch"><input type="checkbox" id="pref-audit-output" /><span></span></label>
          </div>
          <div class="pref-row">
            <div class="pref-label">右键保存快捷命令长度上限
              <div class="pref-desc">终端选中文字右键「保存为快捷命令」允许的最大字符数，选中内容超出则不可保存。默认 24，最大 128</div>
            </div>
            <input type="number" id="pref-quickcmd-max" class="pref-input" style="width:80px" min="1" max="128" value="${prefs.quickCmdMaxChars ?? 24}" />
          </div>
        </div>`;
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
      pane.querySelector('#pref-fontfamily').addEventListener('change', (e) => {
        setPref('fontFamily', e.target.value);
      });
      pane.querySelector('#pref-blink').addEventListener('change', (e) => {
        setPref('cursorBlink', e.target.checked);
      });
      pane.querySelector('#pref-tmux').addEventListener('change', (e) => {
        setPref('tmuxDefault', e.target.checked);
      });
      pane.querySelector('#pref-exit').addEventListener('change', (e) => {
        setPref('exitConfirm', e.target.checked);
      });
      // 右键保存快捷命令长度上限：非法输入回退默认 24（与 prefs.js DEFAULTS 一致），越界钳制到 1–128
      const qcMaxEl = pane.querySelector('#pref-quickcmd-max');
      qcMaxEl.addEventListener('change', (e) => {
        let v = Math.round(Number(e.target.value));
        if (!Number.isInteger(v) || v < 1) v = 24;
        if (v > 128) v = 128;
        e.target.value = v;
        setPref('quickCmdMaxChars', v);
      });

      // —— 终端输出摘要开关（服务端配置，热生效；与两步验证面板同一设置，两处入口）——
      // 开启该开关前必须已绑定两步验证（后端同样强制校验）：未绑定时拦截并提示
      const auditOutputEl = pane.querySelector('#pref-audit-output');
      const auditOutputDesc = pane.querySelector('#pref-audit-output-desc');
      auditOutputEl.disabled = true;
      // 探测 2FA 绑定状态：status 已绑定时无票据返回 403（即视为已绑定），未绑定返回 200
      let twofaBound = false;
      fetch(apiUrl('2fa/status'))
        .then(async (r) => {
          if (r.status === 403) return true; // 已绑定（受保护才 403）
          if (r.ok) return (await r.json()).enabled === true; // 带有效票据的 200
          return false;
        })
        .catch(() => false)
        .then(async (bound) => {
          twofaBound = bound;
          let s = null;
          try {
            s = await (await fetch(apiUrl('audit-settings'))).json();
          } catch {
            /* 网络异常按默认关闭展示 */
          }
          auditOutputEl.checked = s?.recordTerminalOutput === true;
          auditOutputEl.disabled = false;
          if (!bound) {
            auditOutputDesc.innerHTML +=
              '<br><span style="color:var(--warn)">开启前需先绑定两步验证（设置 → 两步验证）</span>';
          }
        });
      auditOutputEl.addEventListener('change', async (e) => {
        const on = e.target.checked;
        if (on && !twofaBound) {
          // 未绑定 2FA：禁止开启（与后端校验一致），回滚并提示
          alert('开启输出摘要记录前需先启用两步验证（设置 → 两步验证）');
          e.target.checked = false;
          return;
        }
        auditOutputEl.disabled = true;
        try {
          // 修改审计设置属 2FA 保护操作：用户主动切换开关，forcePrompt 直接弹码；GET 不受保护
          const r = await apiFetch('audit-settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ recordTerminalOutput: on }),
            forcePrompt: true,
          });
          if (r._twofaCancelled) {
            auditOutputEl.checked = !on; // 用户取消验证：静默回滚，不报错
            return;
          }
          if (!r.ok) throw new Error(await r.text());
        } catch {
          alert('审计设置保存失败，请重试');
          auditOutputEl.checked = !on; // 回滚 UI
        } finally {
          auditOutputEl.disabled = false;
        }
      });
    },
    opsAudit: () => {
      if (renderAudit) renderAudit(pane, 'operation');
      else
        pane.innerHTML =
          '<div class="placeholder-box">审计功能将在 US4 阶段交付（当前连接记录已在服务端留痕）。</div>';
    },
    cmdAudit: () => {
      if (renderAudit) renderAudit(pane, 'commands');
      else pane.innerHTML = '<div class="placeholder-box">命令审计功能将在 US4 阶段交付。</div>';
    },
    tokens: () => {
      if (renderTokens) renderTokens(pane);
      else pane.innerHTML = '<div class="placeholder-box">MCP 令牌功能将在 US6 阶段交付。</div>';
    },
    tokenConfig: () => {
      if (renderTokenConfig) renderTokenConfig(pane);
      else pane.innerHTML = '<div class="placeholder-box">令牌配置将在 US6 阶段交付。</div>';
    },
    twofa: () => renderTwofaPane(pane),
    permPolicy: () => {
      if (renderPermPolicy) renderPermPolicy(pane);
      else pane.innerHTML = '<div class="placeholder-box">权限策略（目录矩阵与敏感路径）将在 US6 阶段交付。</div>';
    },
    groups: () => {
      if (renderGroups) renderGroups(pane, { onChanged: groupsChanged });
      else pane.innerHTML = '<div class="placeholder-box">分组管理占位。</div>';
    },
    // R002：快捷命令管理（从侧栏独立弹窗迁入设置）
    quickCmds: () => renderQuickCommandsPane(pane),
    docs: () => renderDocs(pane),
  };
}

/**
 * 打开设置弹窗（通用类：通用设置/快捷命令/分组管理/操作审计/命令审计/两步验证/权限策略）。
 * @param {{renderAudit?: (el: HTMLElement, category: 'operation'|'commands')=>void, renderPermPolicy?: (el: HTMLElement)=>void, renderGroups?: (el: HTMLElement, opts: {onChanged?: ()=>void})=>void, onGroupsChanged?: ()=>void}} injections
 */
export function openSettingsModal(injections = {}) {
  return openTabbedModal({
    title: '设置',
    tabs: SETTINGS_TABS,
    injections,
    defaultPane: 'theme',
  });
}

/**
 * 打开个人设置弹窗（令牌类：令牌管理/令牌配置）。
 * @param {{renderTokens?: (el: HTMLElement)=>void, renderTokenConfig?: (el: HTMLElement)=>void}} injections
 */
export function openProfileModal(injections = {}) {
  return openTabbedModal({
    title: '个人设置',
    tabs: PROFILE_TABS,
    injections,
    defaultPane: 'tokens',
  });
}

/** 打开使用文档弹窗（单页，无左侧导航） */
export function openDocsModal() {
  return openTabbedModal({
    title: '使用文档',
    tabs: [],
    injections: {},
    defaultPane: 'docs',
    nav: false,
  });
}

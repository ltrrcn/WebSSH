// 快捷命令管理：设置弹窗内 pane 渲染（R002 从侧栏独立弹窗迁入设置）
// 防逆向设计：命令只能新增/删除，不提供编辑（编辑框会回填明文）；
// 列表中命令打码展示，界面上没有任何入口能把已存命令翻出来
import { openModal } from './modal.js';
import { icon } from './icons.js';
import { getQuickCommands, addQuickCommand, removeQuickCommand } from './quick-commands.js';

/**
 * 保存为快捷命令的命名弹窗（终端选中文字右键触发）：只填名称，命令不回填。
 * 留空点保存则使用自动编号名（快捷命令1/2/…）；Esc/取消不保存。
 */
export function openQuickCommandNamer(defaultName, onSave) {
  const m = openModal(`
    <div class="qc-edit-form">
      <div class="pref-row" style="flex-direction:column;align-items:stretch;gap:4px">
        <div class="pref-label">名称<div class="pref-desc">留空则命名为「${escapeText(defaultName)}」</div></div>
        <input id="qcn-name" class="pref-input" placeholder="${escapeAttr(defaultName)}" maxlength="32" />
      </div>
      <div class="qc-edit-actions">
        <button class="btn" id="qcn-cancel">取消</button>
        <button class="btn primary" id="qcn-save">保存</button>
      </div>
    </div>`);
  m.setTitle('保存为快捷命令');
  const nameEl = m.root.querySelector('#qcn-name');
  m.root.querySelector('#qcn-save').addEventListener('click', () => {
    m.close();
    onSave(nameEl.value.trim() || defaultName);
  });
  m.root.querySelector('#qcn-cancel').addEventListener('click', () => m.close());
  // Enter=保存、Esc=取消由 modal 全局键盘层统一处理
  nameEl.focus();
  return m;
}

/**
 * 渲染快捷命令管理 pane（设置弹窗注入式，与其他设置页一致）。
 * @param {HTMLElement} pane 设置弹窗内容容器
 */
export function renderQuickCommandsPane(pane) {
  pane.innerHTML = `
    <div class="pref-section" style="margin-bottom:0">
      <div class="pref-row" style="align-items:flex-end">
        <div class="pref-label" style="flex:1">名称<input id="qc-name" class="pref-input" placeholder="如：查看负载" maxlength="32" /></div>
        <div class="pref-label" style="flex:2">命令<input id="qc-cmd" class="pref-input" type="password" autocomplete="off" placeholder="如：uptime && df -h" maxlength="200" /></div>
        <button class="btn primary" id="qc-add">添加</button>
      </div>
      <div id="qc-list"></div>
      <p class="form-note" style="margin-top:10px">
        快捷命令显示在终端底部命令栏，点击后经独立通道执行：终端只显示等长 * 与输出，shell 历史无记录；
        与当前终端不共享 cd/环境变量，不支持交互式命令。<br>
        为防止泄露：命令不可编辑、列表打码展示；写错了请删除后重新添加。终端中选中文字右键可快速保存。
      </p>
    </div>`;

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
              <code class="qc-cmd qc-masked" title="命令已打码，不提供查看">••••••••</code>
              <button class="icon-btn qc-del" title="删除">${icon('trash', 12)}</button>
            </div>`
          )
          .join('')
      : '<div class="qc-empty">暂无快捷命令。</div>';
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
  // R004：Enter 统一由 modal 全局键盘层触发「添加」（ESC 关闭弹窗），此处不再单独监听
  renderQc();
}

function escapeText(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}
function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// 快捷命令管理：设置弹窗内 pane 渲染（R002 从侧栏独立弹窗迁入设置），
// 增删改与终端底部命令栏实时联动
import { openModal } from './modal.js';
import { icon } from './icons.js';
import {
  getQuickCommands,
  addQuickCommand,
  removeQuickCommand,
  updateQuickCommand,
} from './quick-commands.js';

/**
 * R002 快捷命令编辑弹框（居中 modal，替代原生 prompt）：
 * 设置页与终端命令栏右键共用。
 * @param {{name: string, cmd: string}} initial 当前值
 * @param {({name: string, cmd: string}) => void} onSave 保存回调（校验通过后触发）
 */
export function openQuickCommandEditor(initial, onSave) {
  const m = openModal(`
    <div class="qc-edit-form">
      <div class="pref-row" style="flex-direction:column;align-items:stretch;gap:4px">
        <div class="pref-label">名称</div>
        <input id="qce-name" class="pref-input" placeholder="如：查看负载" maxlength="32" value="${escapeAttr(initial.name)}" />
      </div>
      <div class="pref-row" style="flex-direction:column;align-items:stretch;gap:4px">
        <div class="pref-label">命令<div class="pref-desc">点击发送即执行（含回车）</div></div>
        <input id="qce-cmd" class="pref-input" placeholder="如：uptime && df -h" maxlength="200" value="${escapeAttr(initial.cmd)}" />
      </div>
      <div class="qc-edit-actions">
        <button class="btn" id="qce-cancel">取消</button>
        <button class="btn primary" id="qce-save">保存</button>
      </div>
    </div>`);
  m.setTitle(initial.name ? '编辑快捷命令' : '新增快捷命令');
  const nameEl = m.root.querySelector('#qce-name');
  const cmdEl = m.root.querySelector('#qce-cmd');
  const save = () => {
    const name = nameEl.value.trim();
    const cmd = cmdEl.value.trim();
    if (!name || !cmd) {
      alert('名称与命令都不能为空');
      return;
    }
    m.close();
    onSave({ name, cmd });
  };
  m.root.querySelector('#qce-save').addEventListener('click', save);
  m.root.querySelector('#qce-cancel').addEventListener('click', () => m.close());
  // R004：Enter/ESC 由 modal 全局键盘层统一处理（Enter=保存、ESC=取消），此处不再单独监听
  nameEl.focus();
  nameEl.select();
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
        <div class="pref-label" style="flex:2">命令<input id="qc-cmd" class="pref-input" placeholder="如：uptime && df -h" maxlength="200" /></div>
        <button class="btn primary" id="qc-add">添加</button>
      </div>
      <div id="qc-list"></div>
      <p class="form-note" style="margin-top:10px">快捷命令显示在终端底部命令栏，点击即发送执行（含回车）；终端中选中文字右键可快速保存，命令栏右键可编辑或删除。</p>
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
              <code class="qc-cmd" title="${escapeAttr(c.cmd)}">${escapeText(c.cmd)}</code>
              <button class="icon-btn qc-edit" title="编辑">${icon('pencil', 12)}</button>
              <button class="icon-btn qc-del" title="删除">${icon('trash', 12)}</button>
            </div>`
          )
          .join('')
      : '<div class="qc-empty">暂无快捷命令。</div>';
    qcList.querySelectorAll('.qc-edit').forEach((b) =>
      b.addEventListener('click', () => editQuickCommand(b.closest('.qc-row').dataset.id, renderQc))
    );
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

/** R002 编辑：居中表单弹框（名称/命令一次填完，取消则不变） */
export function editQuickCommand(id, onChanged) {
  const c = getQuickCommands().find((x) => x.id === id);
  if (!c) return;
  openQuickCommandEditor(c, ({ name, cmd }) => {
    updateQuickCommand(id, { name, cmd });
    onChanged?.();
  });
}

function escapeText(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}
function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

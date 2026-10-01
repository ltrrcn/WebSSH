// 快捷命令管理弹窗：侧栏独立入口（从设置弹窗拆出），增删与终端底部命令栏实时联动
import { openModal } from './modal.js';
import { icon } from './icons.js';
import { getQuickCommands, addQuickCommand, removeQuickCommand } from './quick-commands.js';

export function openQuickCommandsModal() {
  const m = openModal(`
    <div class="pref-section" style="margin-bottom:0">
      <div class="pref-row" style="align-items:flex-end">
        <div class="pref-label" style="flex:1">名称<input id="qc-name" class="pref-input" placeholder="如：查看负载" maxlength="32" /></div>
        <div class="pref-label" style="flex:2">命令<input id="qc-cmd" class="pref-input" placeholder="如：uptime && df -h" maxlength="200" /></div>
        <button class="btn primary" id="qc-add">添加</button>
      </div>
      <div id="qc-list"></div>
      <p class="form-note" style="margin-top:10px">快捷命令显示在终端底部命令栏，点击即发送执行（含回车）；终端中选中文字右键也可快速保存。</p>
    </div>`);
  m.setTitle('快捷命令');

  const pane = m.root;
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
  qcCmd.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') pane.querySelector('#qc-add').click();
  });
  renderQc();
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

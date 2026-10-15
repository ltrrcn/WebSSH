// 快捷命令管理：设置弹窗内 pane 渲染（R002 从侧栏独立弹窗迁入设置）
// 防逆向设计：命令打码展示，编辑入口只允许覆盖（不回填原值）——界面上没有任何入口能把已存命令翻出来
// 行内编辑：名称/命令旁各一个小铅笔，点击进入编辑态，点击别处自动保存（与分组管理一致）
import { icon } from './icons.js';
import { getQuickCommands, addQuickCommand, removeQuickCommand, updateQuickCommand } from './quick-commands.js';

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

/** 行内编辑：把目标元素换成输入框，Enter/点击别处保存，Esc 取消；onSubmit 为空/未变更时跳过 */
function startInlineEdit(row, targetEl, { value = '', placeholder = '', maxLength = 32, onSubmit }) {
  const input = document.createElement('input');
  input.type = 'text'; // 明文可见：输入的是新值，原命令始终不回填
  input.className = 'pref-input qc-inline-input';
  input.maxLength = maxLength;
  if (value) input.value = value;
  if (placeholder) input.placeholder = placeholder;
  input.autocomplete = 'off';
  targetEl.replaceWith(input);
  input.focus();
  if (value) input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v) onSubmit(v);
    renderQcPane(row.closest('#qc-list')); // 重建列表还原编辑态（未变更/取消也还原）
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // 防冒泡到设置弹窗全局快捷键（Enter/Esc）
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
  return input;
}

/**
 * 渲染快捷命令管理 pane（设置弹窗注入式，与其他设置页一致）。
 * @param {HTMLElement} pane 设置弹窗内容容器
 */
export function renderQuickCommandsPane(pane) {
  pane.innerHTML = `
    <div class="pref-section" style="margin-bottom:0">
      <div id="qc-list"></div>
      <div class="qc-add-box" id="qc-add-box" title="点击展开新增表单">${icon('plus', 12)} 新增自定义命令</div>
    </div>`;

  const qcList = pane.querySelector('#qc-list');

  // 底部新增框：点击后在列表末尾追加一行编辑行（名称/命令必填输入框 + 操作列对勾/叉），
  // 视觉上就是列表多长出一行，新增框被丝滑推下移；取消时收起上移；保存后编辑行收起、新行淡入
  const addBox = pane.querySelector('#qc-add-box');
  let editWrap = null; // 展开/收起动画的包装层（高度过渡，内容不变形）
  const collapseEditRow = () => {
    if (!editWrap) return;
    editWrap.style.height = `${editWrap.offsetHeight}px`;
    requestAnimationFrame(() => {
      editWrap.style.height = '0px';
    });
    editWrap.addEventListener('transitionend', function onEnd(e) {
      if (e.propertyName !== 'height') return;
      editWrap.removeEventListener('transitionend', onEnd);
      editWrap.remove();
      editWrap = null;
    });
  };
  addBox.addEventListener('click', () => {
    if (editWrap) return editWrap.querySelector('input')?.focus(); // 已展开则聚焦
    const row = document.createElement('div');
    row.className = 'qc-edit-row';
    row.innerHTML = `
      <input class="pref-input qce-name" placeholder="名称，如：查看负载" maxlength="32" />
      <input class="pref-input qce-cmd" autocomplete="off" placeholder="命令，如：uptime && df -h" maxlength="200" />
      <span class="qc-ops">
        <button class="icon-btn qce-ok" title="添加">${icon('check', 12)}</button>
        <button class="icon-btn qce-cancel" title="取消">${icon('x', 12)}</button>
      </span>`;
    editWrap = document.createElement('div');
    editWrap.className = 'qc-edit-wrap';
    editWrap.appendChild(row);
    qcList.appendChild(editWrap); // 追加为列表最后一行：与上行共用边线，底部圆角由列表容器收尾
    editWrap.style.height = '0px';
    const h = row.offsetHeight;
    requestAnimationFrame(() => {
      editWrap.style.height = `${h}px`;
    });
    editWrap.addEventListener('transitionend', function onEnd(e) {
      if (e.propertyName === 'height' && editWrap) editWrap.style.height = ''; // 展开完成后交给 auto
      editWrap.removeEventListener('transitionend', onEnd);
    });
    row.querySelector('.qce-name').focus();
    row.querySelector('.qce-cancel').addEventListener('click', collapseEditRow);
    row.querySelector('.qce-ok').addEventListener('click', () => {
      const name = row.querySelector('.qce-name').value.trim();
      const cmd = row.querySelector('.qce-cmd').value.trim();
      if (!name || !cmd) return alert('名称与命令都不能为空');
      addQuickCommand(name, cmd);
      const newId = getQuickCommands().at(-1)?.id;
      renderQcPane(qcList, newId); // 列表丝滑出现新行
      collapseEditRow();
    });
  });

  // R004：Enter 统一由 modal 全局键盘层触发「添加」（ESC 关闭弹窗），此处不再单独监听
  renderQcPane(qcList);
}

/** 渲染列表并绑定行内事件（编辑/删除）；行内编辑收尾时也会调用它重建；flashId 为新行丝滑淡入 */
function renderQcPane(qcList, flashId = null) {
  const cmds = getQuickCommands();
  qcList.innerHTML =
    cmds.length
      ? `<div class="qc-head"><span>名称</span><span>命令</span><span class="qc-head-ops">操作</span></div>` +
        cmds
          .map(
            (c) => `<div class="qc-row${c.id === flashId ? ' qc-row-in' : ''}" data-id="${escapeAttr(c.id)}">
              <span class="qc-inline">
                <span class="qc-name" title="${escapeAttr(c.name)}">${escapeText(c.name)}</span>
                <button class="icon-btn qc-name-edit" title="编辑名称">${icon('pencil', 11)}</button>
              </span>
              <span class="qc-inline">
                <code class="qc-cmd qc-masked" title="命令已打码；点铅笔填写新命令覆盖（不显示原命令）">••••••••</code>
                <button class="icon-btn qc-cmd-edit" title="覆盖命令（不显示原命令）">${icon('pencil', 11)}</button>
              </span>
              <span class="qc-ops">
                <button class="icon-btn qc-del" title="删除">${icon('trash', 12)}</button>
              </span>
            </div>`
          )
          .join('')
      : '<div class="qc-empty">暂无快捷命令。</div>';
  qcList.querySelectorAll('.qc-name-edit').forEach((b) =>
    b.addEventListener('click', () => {
      const row = b.closest('.qc-row');
      if (row.querySelector('.qc-inline-input')) return;
      const c = getQuickCommands().find((x) => x.id === row.dataset.id);
      if (!c) return;
      b.style.visibility = 'hidden'; // 编辑态铅笔让位
      startInlineEdit(row, row.querySelector('.qc-name'), {
        value: c.name,
        onSubmit: (v) => updateQuickCommand(c.id, { name: v }),
      });
    })
  );
  qcList.querySelectorAll('.qc-cmd-edit').forEach((b) =>
    b.addEventListener('click', () => {
      const row = b.closest('.qc-row');
      if (row.querySelector('.qc-inline-input')) return;
      const c = getQuickCommands().find((x) => x.id === row.dataset.id);
      if (!c) return;
      b.style.visibility = 'hidden';
      startInlineEdit(row, row.querySelector('.qc-cmd'), {
        placeholder: '填写新命令覆盖，留空取消',
        maxLength: 200,
        onSubmit: (v) => updateQuickCommand(c.id, { cmd: v }),
      });
    })
  );
  qcList.querySelectorAll('.qc-del').forEach((b) =>
    b.addEventListener('click', () => {
      removeQuickCommand(b.closest('.qc-row').dataset.id);
      renderQcPane(qcList);
    })
  );
}

function escapeText(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}
function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

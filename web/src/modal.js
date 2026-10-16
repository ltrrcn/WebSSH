// 弹窗工具：单例 modal-root
import { icon } from './icons.js';
const root = document.getElementById('modal-root');
const box = root.querySelector('.modal');

let onClose = null;

export function openModal(html, { onclose } = {}) {
  onClose = onclose ?? null;
  // modal 是单例：清掉上一弹窗留下的修饰类（settings-modal / confirm-modal），
  // 否则它们的 width 会叠加到新弹窗上（曾导致确认弹窗之后设置弹窗变窄）
  box.className = 'modal';
  box.innerHTML = `<div class="modal-head"><span id="modal-title"></span>
    <button class="icon-btn" id="modal-close">${icon('x', 13)}</button></div>
    <div class="modal-body">${html}</div>`;
  root.classList.add('show');
  box.querySelector('#modal-close').addEventListener('click', closeModal);
  root.querySelector('.modal-mask').addEventListener('click', closeModal);
  return {
    root: box,
    close: closeModal,
    setTitle: (t) => (box.querySelector('#modal-title').textContent = t),
  };
}

export function closeModal() {
  root.classList.remove('show');
  box.innerHTML = '';
  if (onClose) {
    const fn = onClose;
    onClose = null;
    fn();
  }
}

export function isModalOpen() {
  return root.classList.contains('show');
}

/**
 * 通用确认弹窗（替代原生 confirm）：ESC / 遮罩 / 右上角 X = 取消，Enter = 确认。
 * @param {{title?: string, message: string, note?: string, confirmText?: string,
 *          cancelText?: string, extraText?: string, danger?: boolean, iconName?: string}} opts
 *        message/note 为 HTML（调用方负责转义）；传 extraText 会多出一个次要操作按钮
 * @returns {Promise<boolean|'extra'>} true = 确认，'extra' = 次要操作，false = 取消
 */
export function confirmModal({ title = '确认操作', message, note = '', confirmText = '确定', cancelText = '取消', extraText = '', danger = false, iconName = 'info' } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const m = openModal(
      `<div class="confirm-box">
        <div class="confirm-head">
          <span class="confirm-badge${danger ? ' danger' : ''}">${icon(iconName, 17)}</span>
          <p class="confirm-text">${message}</p>
        </div>
        ${note ? `<p class="confirm-note">${note}</p>` : ''}
        <div class="qc-edit-actions confirm-actions">
          <button class="btn" id="confirm-cancel">${cancelText}</button>
          ${extraText ? `<button class="btn" id="confirm-extra">${extraText}</button>` : ''}
          <button class="btn ${danger ? 'danger-solid' : 'primary'}" id="confirm-ok">${confirmText}</button>
        </div>
      </div>`,
      { onclose: () => resolve(false) }
    );
    m.root.classList.add('confirm-modal');
    m.setTitle(title);
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
      m.close();
    };
    m.root.querySelector('#confirm-cancel').addEventListener('click', () => done(false));
    m.root.querySelector('#confirm-extra')?.addEventListener('click', () => done('extra'));
    m.root.querySelector('#confirm-ok').addEventListener('click', () => done(true));
    m.root.querySelector('#confirm-ok').focus();
  });
}

// R004 弹窗键盘快捷键（页面无提示，全局生效）：
// - ESC：关闭弹窗（等价点 X / 遮罩），即「取消」
// - Enter：触发弹窗主按钮（.btn.primary），即「确认/保存/信任并连接」
// 跳过场景：textarea（Enter 换行）、button（浏览器默认点击）、含 <form> 的弹窗（表单隐式提交）
// 浮层优先：存在打开的独立浮层（审计详情 / 2FA 验证码 / 恢复弹窗，均叠在 modal 之上）
// 时，ESC/Enter 归浮层处理，避免按键穿透误关底下的设置弹窗。
document.addEventListener('keydown', (e) => {
  if (!isModalOpen()) return;
  if (e.key === 'Escape' || e.key === 'Enter') {
    if (document.querySelector('.audit-detail-overlay.show')) return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    closeModal();
    return;
  }
  if (e.key !== 'Enter') return;
  const t = e.target;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLButtonElement) return;
  if (box.querySelector('form')) return; // 表单类弹窗由浏览器隐式提交，避免双触发
  const primary = box.querySelector('.btn.primary:not(:disabled)');
  if (primary) {
    e.preventDefault();
    primary.click();
  }
});

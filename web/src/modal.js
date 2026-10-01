// 弹窗工具：单例 modal-root
import { icon } from './icons.js';
const root = document.getElementById('modal-root');
const box = root.querySelector('.modal');

let onClose = null;

export function openModal(html, { onclose } = {}) {
  onClose = onclose ?? null;
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

// R004 弹窗键盘快捷键（页面无提示，全局生效）：
// - ESC：关闭弹窗（等价点 X / 遮罩），即「取消」
// - Enter：触发弹窗主按钮（.btn.primary），即「确认/保存/信任并连接」
// 跳过场景：textarea（Enter 换行）、button（浏览器默认点击）、含 <form> 的弹窗（表单隐式提交）
document.addEventListener('keydown', (e) => {
  if (!isModalOpen()) return;
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

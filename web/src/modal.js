// 弹窗工具：单例 modal-root
const root = document.getElementById('modal-root');
const box = root.querySelector('.modal');

let onClose = null;

export function openModal(html, { onclose } = {}) {
  onClose = onclose ?? null;
  box.innerHTML = `<div class="modal-head"><span id="modal-title"></span>
    <button class="icon-btn" id="modal-close">✕</button></div>
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

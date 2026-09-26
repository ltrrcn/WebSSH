// 共享右键上下文菜单（FR-049/055）：terminal tab 与会话连接列表共用
let menuEl = null;

function ensureMenu() {
  if (menuEl) return menuEl;
  menuEl = document.createElement('div');
  menuEl.className = 'ctx-menu';
  document.body.appendChild(menuEl);
  menuEl.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('click', () => hideContextMenu(), true);
  window.addEventListener('blur', hideContextMenu);
  window.addEventListener('resize', hideContextMenu);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideContextMenu();
  });
  return menuEl;
}

/**
 * 在指定坐标弹出上下文菜单。
 * @param {number} x
 * @param {number} y
 * @param {{meta?: string, items: Array<{label: string, danger?: boolean, onClick: () => void}>}} opts
 */
export function showContextMenu(x, y, { meta, items }) {
  const menu = ensureMenu();
  menu.innerHTML =
    (meta ? `<div class="ctx-meta"></div>` : '') +
    items
      .map(
        (it, i) =>
          it === 'sep'
            ? '<div class="ctx-sep"></div>'
            : `<button class="ctx-item ${it.danger ? 'danger' : ''}" data-idx="${i}"></button>`
      )
      .join('');
  if (meta) menu.querySelector('.ctx-meta').textContent = meta;
  items.forEach((it, i) => {
    if (it === 'sep') return;
    const btn = menu.querySelector(`[data-idx="${i}"]`);
    btn.textContent = it.label;
    btn.addEventListener('click', () => {
      hideContextMenu();
      it.onClick();
    });
  });
  menu.classList.add('show');
  const mw = menu.offsetWidth || 170;
  const mh = menu.offsetHeight || 40 * items.length;
  menu.style.left = `${Math.min(x, window.innerWidth - mw - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - mh - 8)}px`;
}

export function hideContextMenu() {
  if (menuEl) menuEl.classList.remove('show');
}

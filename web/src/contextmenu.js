// 共享右键上下文菜单（FR-049/055）：terminal tab 与会话连接列表共用
let menuEl = null;

function ensureMenu() {
  if (menuEl) return menuEl;
  menuEl = document.createElement('div');
  menuEl.className = 'ctx-menu';
  document.body.appendChild(menuEl);
  menuEl.addEventListener('contextmenu', (e) => e.preventDefault());
  // 菜单内点击不自动关闭（外观开关等交互控件需点了生效且菜单保留）；菜单项自身 click 仍会显式关闭
  document.addEventListener('click', (e) => {
    if (!menuEl?.contains(e.target)) hideContextMenu();
  }, true);
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
 * @param {number} y 菜单顶边坐标；above=true 时为菜单底边坐标（弹出在 y 上方）
 * @param {{profile?: {avatarText: string, name: string, local?: boolean, onClick?: () => void}, meta?: string, section?: (el: HTMLElement) => void, above?: boolean, items: Array<{label: string, danger?: boolean, disabled?: boolean, onClick?: () => void}>}} opts
 *   profile：可点击的资料头（头像+用户名，后跟分隔线），与 meta 互斥、优先渲染
 *   section：items 之前的自定义控件区（如外观快速开关），渲染后自带分隔线；区内点击不关闭菜单
 *   minWidth：覆盖默认最小宽度（168px），用于含分段控件等较宽内容的菜单
 */
export function showContextMenu(x, y, { profile, meta, section, above, minWidth, items }) {
  const menu = ensureMenu();
  menu.innerHTML =
    (profile
      ? '<button class="ctx-profile" type="button"><span class="user-avatar"></span><span class="ctx-profile-name"></span></button><div class="ctx-sep"></div>'
      : '') +
    (meta && !profile ? `<div class="ctx-meta"></div>` : '') +
    (section ? '<div class="ctx-section"></div><div class="ctx-sep"></div>' : '') +
    items
      .map(
        (it, i) =>
          it === 'sep'
            ? '<div class="ctx-sep"></div>'
            : `<button class="ctx-item ${it.danger ? 'danger' : ''}" data-idx="${i}"${it.disabled ? ' disabled' : ''}></button>`
      )
      .join('');
  if (profile) {
    const p = menu.querySelector('.ctx-profile');
    const avatar = p.querySelector('.user-avatar');
    avatar.textContent = profile.avatarText;
    if (profile.local) avatar.classList.add('local');
    p.querySelector('.ctx-profile-name').textContent = profile.name;
    p.addEventListener('click', () => {
      hideContextMenu();
      profile.onClick?.();
    });
  } else if (meta) {
    menu.querySelector('.ctx-meta').textContent = meta;
  }
  if (section) section(menu.querySelector('.ctx-section'));
  menu.style.minWidth = minWidth ? `${minWidth}px` : '';
  items.forEach((it, i) => {
    if (it === 'sep') return;
    const btn = menu.querySelector(`[data-idx="${i}"]`);
    // 图标为代码内受控 id（非用户输入），可安全 innerHTML；label 恒为纯文本
    if (it.icon) {
      btn.classList.add('with-icon');
      btn.insertAdjacentHTML(
        'afterbegin',
        `<svg class="icon" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><use href="assets/icons.svg#${it.icon}"/></svg>`
      );
    }
    btn.append(it.label);
    if (it.disabled) return; // 占位项：仅展示，不绑定行为
    btn.addEventListener('click', () => {
      hideContextMenu();
      it.onClick();
    });
  });
  menu.classList.add('show');
  const mw = menu.offsetWidth || 170;
  const mh = menu.offsetHeight || 40 * items.length;
  menu.style.left = `${Math.min(x, window.innerWidth - mw - 8)}px`;
  menu.style.top = above
    ? `${Math.max(8, y - mh)}px`
    : `${Math.min(y, window.innerHeight - mh - 8)}px`;
}

export function hideContextMenu() {
  if (menuEl) menuEl.classList.remove('show');
}

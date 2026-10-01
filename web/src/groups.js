// 分组管理页（设置 → 分组）：内置 default 分组 + 新建 / 重命名（合并）/ 删除 / 排序
// 删除分组只解除标签：组内主机移回 default 分组，主机与凭据完整保留
import { apiUrl } from './base.js';
import { icon } from './icons.js';
import { loadExpandedGroups, saveExpandedGroups } from './hosts.js';

export async function renderGroups(el, { onChanged } = {}) {
  el.innerHTML = '<div class="placeholder-box">加载中…</div>';
  let groups = [];
  try {
    const res = await fetch(apiUrl('groups'));
    if (res.ok) groups = (await res.json()).groups ?? [];
  } catch {
    /* 网络异常 */
  }

  const doRefresh = () => {
    if (onChanged) onChanged();
    renderGroups(el, { onChanged });
  };

  el.innerHTML = `
    <div class="audit-toolbar">
      <input id="group-new-name" class="audit-search audit-sid-input" type="text"
        placeholder="新分组名称" maxlength="64" />
      <button class="btn primary" id="group-create">新建分组</button>
      <span style="flex:1"></span>
      <button class="btn" id="group-refresh">刷新</button>
    </div>
    <p class="form-note" style="margin:0 0 10px">
      新建主机默认归入 <b>Default</b> 分组（内置，不可删除）。删除自定义分组只解除标签：组内主机移回 Default，主机与凭据完整保留。
    </p>
    <div class="audit-list">${groups
      .map((g, i) => {
        // 自定义分组序号（Default 内置置顶，不参与排序）
        const customIdx = groups.slice(0, i).filter((x) => !x.builtin).length;
        const customTotal = groups.filter((x) => !x.builtin).length;
        const expanded = loadExpandedGroups();
        return `<div class="audit-row group-row" data-name="${escapeHtml(g.name)}" data-builtin="${g.builtin}">
          <span class="audit-event">${escapeHtml(g.name)}${g.builtin ? ' <span class="tag pinned">置顶</span>' : ''}</span>
          <span class="audit-detail">${g.count} 台主机</span>
          <span class="audit-detail" style="min-width:52px">
            <button class="icon-btn group-expand" data-name="${escapeHtml(g.name)}" title="${expanded.has(g.name) ? '已展开，点击折叠' : '已折叠，点击展开'}">
              <svg class="icon" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" style="transition:transform .22s ease;transform-origin:center;transform:rotate(${expanded.has(g.name) ? 90 : 0}deg)"><use href="assets/icons.svg#chevron"/></svg>
            </button>
          </span>
          <span class="group-order-btns">${
            g.builtin
              ? ''
              : `<button class="icon-btn group-move" data-dir="-1" title="上移" ${customIdx === 0 ? 'disabled' : ''}>↑</button>
                 <button class="icon-btn group-move" data-dir="1" title="下移" ${customIdx === customTotal - 1 ? 'disabled' : ''}>↓</button>`
          }</span>
          ${
            g.builtin
              ? '<span></span><span></span>'
              : `<button class="icon-btn group-rename" data-name="${escapeHtml(g.name)}" title="重命名">${icon('pencil', 13)}</button>
                 <button class="icon-btn danger-text group-delete" data-name="${escapeHtml(g.name)}" data-count="${g.count}" title="删除">${icon('trash', 13)}</button>`
          }
        </div>`;
      })
      .join('')}</div>`;

  el.querySelector('#group-refresh').addEventListener('click', () => renderGroups(el, { onChanged }));

  // 展开/不展开（chevron 矢量图标，与侧栏同款）：与侧栏共享 localStorage 状态，切换后立即刷新侧栏
  el.querySelectorAll('.group-expand').forEach((btn) =>
    btn.addEventListener('click', () => {
      const expanded = loadExpandedGroups();
      const name = btn.dataset.name;
      if (expanded.has(name)) expanded.delete(name);
      else expanded.add(name);
      saveExpandedGroups(expanded);
      // 就地旋转箭头，不整页重刷（避免打断其他操作）
      const svg = btn.querySelector('svg');
      if (svg) svg.style.transform = `rotate(${expanded.has(name) ? 90 : 0}deg)`;
      btn.title = expanded.has(name) ? '已展开，点击折叠' : '已折叠，点击展开';
      if (onChanged) onChanged();
    })
  );

  // 新建分组
  const nameInput = el.querySelector('#group-new-name');
  const create = async () => {
    const name = nameInput.value.trim();
    if (!name) return alert('分组名不能为空');
    const res = await fetch(apiUrl('groups'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return alert(`新建失败：${err.error?.message ?? res.statusText}`);
    }
    doRefresh();
  };
  el.querySelector('#group-create').addEventListener('click', create);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') create();
  });

  // 排序：上移/下移后整体提交当前顺序（内置 default 不参与）
  el.querySelectorAll('.group-move').forEach((b) =>
    b.addEventListener('click', async () => {
      if (b.disabled) return;
      const row = b.closest('.group-row');
      const dir = Number(b.dataset.dir);
      const sib = dir < 0 ? row.previousElementSibling : row.nextElementSibling;
      if (!sib || sib.dataset.builtin === 'true') return; // 内置置顶行不可越过
      if (dir < 0) row.parentNode.insertBefore(row, sib);
      else row.parentNode.insertBefore(sib, row);
      const order = [...row.parentNode.querySelectorAll('.group-row')]
        .map((r) => r.dataset.name)
        .filter((n, i, arr) => n !== 'Default' && arr.indexOf(n) === i);
      const res = await fetch(apiUrl('groups/reorder'), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ order }),
      });
      if (res.ok) doRefresh();
    })
  );

  el.querySelectorAll('.group-rename').forEach((b) =>
    b.addEventListener('click', async () => {
      const name = b.dataset.name;
      const newName = prompt(`将分组「${name}」重命名为（目标已存在则两组合并）：`, name);
      if (newName === null) return;
      const trimmed = newName.trim();
      if (!trimmed || trimmed === name) return;
      const res = await fetch(apiUrl(`groups/${encodeURIComponent(name)}`), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ newName: trimmed }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return alert(`重命名失败：${err.error?.message ?? res.statusText}`);
      }
      doRefresh();
    })
  );
  el.querySelectorAll('.group-delete').forEach((b) =>
    b.addEventListener('click', async () => {
      const name = b.dataset.name;
      const n = b.dataset.count;
      if (!confirm(`删除分组「${name}」？\n组内 ${n} 台主机将移回 default 分组，主机与凭据完整保留。`)) return;
      const res = await fetch(apiUrl(`groups/${encodeURIComponent(name)}`), { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return alert(`删除失败：${err.error?.message ?? res.statusText}`);
      }
      doRefresh();
    })
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

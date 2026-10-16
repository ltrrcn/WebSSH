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
    <div class="audit-list group-list">
      <div class="group-head">
        <span>分组名</span>
        <span>主机数</span>
        <span class="group-head-expand" title="展开/折叠该分组的主机列表">展开</span>
        <span class="group-head-move" title="上移/下移，调整侧栏分组顺序">排序</span>
        <span class="group-head-del" title="删除分组（主机移回 Default）">删除</span>
      </div>
      ${groups
      .map((g, i) => {
        // 自定义分组序号（Default 内置置顶，不参与排序）
        const customIdx = groups.slice(0, i).filter((x) => !x.builtin).length;
        const customTotal = groups.filter((x) => !x.builtin).length;
        const expanded = loadExpandedGroups();
        return `<div class="audit-row group-row" data-name="${escapeHtml(g.name)}" data-builtin="${g.builtin}">
          <span class="group-name-cell">
            <span class="audit-event group-name" title="${g.builtin ? '' : '双击重命名'}">${escapeHtml(g.name)}${g.builtin ? ' <span class="tag pinned">置顶</span>' : ''}</span>
            ${g.builtin ? '' : `<button class="icon-btn group-rename" data-name="${escapeHtml(g.name)}" title="重命名（也可双击名称）">${icon('pencil', 13)}</button>`}
          </span>
          <span class="audit-detail">${g.count} 台主机</span>
          <span class="audit-detail group-expand-cell">
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
              ? '<span></span>'
              : `<button class="icon-btn danger-text group-delete" data-name="${escapeHtml(g.name)}" data-count="${g.count}" title="删除">${icon('trash', 13)}</button>`
          }
        </div>`;
      })
      .join('')}</div>
    <div class="qc-add-box" id="group-add" title="点击展开新增表单">${icon('plus', 12)} 新增分组</div>`;

  // 新增分组：点击底部新增框，在列表末尾「长」出一行编辑行（包装层高度过渡，新增框被丝滑推下移），
  // 与快捷命令同款交互：对勾/Enter 保存，叉号/Esc 取消并收起上移；成功后行闪绿再整页刷新
  const list = el.querySelector('.audit-list');
  const addBox = el.querySelector('#group-add');
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
    row.className = 'audit-row group-row group-row-new';
    // 与列表行同网格：名称输入(1.2fr) | 空 | 空 | 操作列(56px，对勾+叉) | 空
    row.innerHTML = `<span class="group-name-cell">
        <input type="text" class="group-name-input" maxlength="64" placeholder="新分组名称" title="回车或点对勾保存，Esc 取消" />
      </span><span></span><span></span>
      <span class="qc-ops">
        <button class="icon-btn group-new-ok" title="添加">${icon('check', 12)}</button>
        <button class="icon-btn group-new-cancel" title="取消">${icon('x', 12)}</button>
      </span><span></span>`;
    editWrap = document.createElement('div');
    editWrap.className = 'qc-edit-wrap';
    editWrap.appendChild(row);
    list.appendChild(editWrap); // 追加为列表最后一行，与上行共用边线
    editWrap.style.height = '0px';
    const h = row.offsetHeight;
    requestAnimationFrame(() => {
      editWrap.style.height = `${h}px`;
    });
    editWrap.addEventListener('transitionend', function onEnd(e) {
      if (e.propertyName === 'height' && editWrap) editWrap.style.height = ''; // 展开完成后交给 auto
      editWrap.removeEventListener('transitionend', onEnd);
    });
    const input = row.querySelector('input');
    input.focus();
    let done = false;
    const cancel = () => {
      if (done) return;
      done = true;
      collapseEditRow();
    };
    const submit = async () => {
      if (done) return;
      const name = input.value.trim();
      if (!name) return input.focus(); // 名称为空不提交，继续编辑
      done = true;
      input.disabled = true; // 提交期间锁定，防止重复触发
      const res = await fetch(apiUrl('groups'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`新建失败：${err.error?.message ?? res.statusText}`);
        done = false; // 保留这一行，改完名称可再次提交
        input.disabled = false;
        input.focus();
        input.select();
        return;
      }
      // 成功：行闪绿提示，稍候再整页刷新，用户能感知"已保存"
      row.classList.add('ok');
      setTimeout(doRefresh, 400);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    });
    row.querySelector('.group-new-ok').addEventListener('click', submit);
    row.querySelector('.group-new-cancel').addEventListener('click', cancel);
  });

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

  // 排序：上移/下移后整体提交当前顺序（内置 default 不参与）
  el.querySelectorAll('.group-move').forEach((b) =>
    b.addEventListener('click', async () => {
      if (b.disabled) return;
      const row = b.closest('.group-row');
      const dir = Number(b.dataset.dir);
      const sib = dir < 0 ? row.previousElementSibling : row.nextElementSibling;
      // 相邻必须是分组行（列表首行是表头），且内置置顶行不可越过
      if (!sib || !sib.classList.contains('group-row') || sib.dataset.builtin === 'true') return;
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

  // 重命名：双击分组名或点击名称旁的铅笔 → 行内输入框；Enter/点击别处保存，Esc 取消
  const editRow = (target) => {
    const row = target.closest('.group-row');
    if (!row || row.dataset.builtin === 'true') return;
    startGroupRename(row, row.dataset.name, doRefresh);
  };
  el.querySelectorAll('.group-name').forEach((n) => n.addEventListener('dblclick', () => editRow(n)));
  el.querySelectorAll('.group-rename').forEach((b) => b.addEventListener('click', () => editRow(b)));
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

// 行内重命名：把名称 span 换成输入框，失焦/Enter 保存，Esc 取消（与终端 tab 改名同款交互）
function startGroupRename(row, currentName, onFinished) {
  const nameEl = row.querySelector('.group-name');
  if (!nameEl || row.querySelector('.group-name-input')) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'group-name-input';
  input.maxLength = 64;
  input.value = currentName;
  input.title = '回车或点击空白保存，Esc 取消；改为已存在的分组名将合并两组';
  row.querySelector('.group-rename')?.style.setProperty('visibility', 'hidden'); // 编辑态让位给输入框
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    const next = input.value.trim();
    // 未改/清空：直接还原，不发请求
    if (!save || !next || next === currentName) {
      done = true;
      onFinished();
      return;
    }
    done = true;
    const res = await fetch(apiUrl(`groups/${encodeURIComponent(currentName)}`), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newName: next }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`重命名失败：${err.error?.message ?? res.statusText}`);
    }
    onFinished();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // 避免冒泡到全局快捷键
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

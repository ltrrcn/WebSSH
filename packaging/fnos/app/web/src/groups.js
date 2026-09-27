// 分组管理页（设置 → 分组）：重命名（合并）/ 删除（组内主机移回「默认」分组，凭据保留）
// 分组是主机 group 字段的集合视图，无独立实体
import { apiUrl } from './base.js';
import { icon } from './icons.js';

export async function renderGroups(el, { onChanged } = {}) {
  el.innerHTML = '<div class="placeholder-box">加载中…</div>';
  let hosts = [];
  try {
    const res = await fetch(apiUrl('hosts'));
    if (res.ok) hosts = await res.json();
  } catch {
    /* 网络异常 */
  }

  // 聚合：真实 group 字符串集合（虚拟「默认」组 = group 为 null 的主机，不可管理）
  const counts = new Map();
  let ungrouped = 0;
  for (const h of hosts) {
    if (h.group == null) ungrouped++;
    else counts.set(h.group, (counts.get(h.group) ?? 0) + 1);
  }
  const groups = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'));

  const doRefresh = () => {
    if (onChanged) onChanged();
    renderGroups(el, { onChanged });
  };

  el.innerHTML = `
    <div class="audit-toolbar">
      <span style="font-size:12px;color:var(--text-faint)">删除分组只解除标签：组内主机移回「默认」分组，主机与凭据完整保留</span>
      <button class="btn" id="group-refresh">刷新</button>
    </div>
    ${
      groups.length
        ? `<div class="audit-list">${groups
            .map(
              ([name, n]) => `<div class="audit-row" data-group="${escapeHtml(name)}">
                <span class="audit-event">${escapeHtml(name)}</span>
                <span class="audit-detail">${n} 台主机</span>
                <button class="btn group-rename" data-name="${escapeHtml(name)}">${icon('pencil', 12)} 重命名</button>
                <button class="btn danger-text group-delete" data-name="${escapeHtml(name)}" data-count="${n}">${icon('trash', 12)} 删除</button>
              </div>`
            )
            .join('')}</div>`
        : '<div class="placeholder-box">暂无自定义分组。在左侧编辑主机时填写「分组」即可创建。</div>'
    }
    ${ungrouped ? `<p class="form-note" style="margin-top:10px">另有 ${ungrouped} 台主机未分组（显示在「默认」分组，不可删除）。</p>` : ''}`;

  el.querySelector('#group-refresh').addEventListener('click', () => renderGroups(el, { onChanged }));
  el.querySelectorAll('.group-rename').forEach((b) =>
    b.addEventListener('click', async () => {
      const name = b.dataset.name;
      const newName = prompt(`将分组「${name}」重命名为（目标已存在则两组合并）：`, name);
      if (newName === null) return;
      const trimmed = newName.trim();
      if (!trimmed || trimmed === name) return;
      if (trimmed === '默认') return alert('「默认」为保留分组名，请换一个名称。');
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
      if (!confirm(`删除分组「${name}」？\n组内 ${n} 台主机将移回「默认」分组，主机与凭据完整保留。`)) return;
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

// 审计页（US4 / FR-012）：渲染在「设置 → 审计」页签中
// 时间顺序列表 + result/hostId 过滤 + 分页 + 导出
const EVENT_LABEL = {
  'connect-attempt': '连接尝试',
  'connect-success': '连接成功',
  'connect-failure': '连接失败',
  command: '命令执行',
  'file-read': '文件读取',
  'file-write': '文件写入',
  disconnect: '断开连接',
};
const RESULT_LABEL = { success: '成功', denied: '拒绝', error: '失败' };

let state = { result: '', hostId: '', offset: 0, limit: 30, total: 0 };

export async function renderAudit(el) {
  el.innerHTML = `
    <div class="audit-toolbar">
      <select id="audit-result">
        <option value="">全部结果</option>
        <option value="success">成功</option>
        <option value="error">失败</option>
        <option value="denied">拒绝</option>
      </select>
      <select id="audit-host"><option value="">全部主机</option></select>
      <button class="btn" id="audit-export">导出</button>
      <button class="btn" id="audit-refresh">刷新</button>
    </div>
    <div id="audit-list" class="audit-list"><div class="placeholder-box">加载中…</div></div>
    <div class="audit-pager">
      <button class="btn" id="audit-prev">上一页</button>
      <span id="audit-page-info" class="audit-page-info"></span>
      <button class="btn" id="audit-next">下一页</button>
    </div>`;

  // 主机过滤选项
  try {
    const hosts = await (await fetch('/api/hosts')).json();
    const sel = el.querySelector('#audit-host');
    for (const h of hosts) {
      const o = document.createElement('option');
      o.value = h.id;
      o.textContent = h.name;
      sel.appendChild(o);
    }
  } catch {
    /* 忽略 */
  }

  el.querySelector('#audit-result').addEventListener('change', (e) => {
    state.result = e.target.value;
    state.offset = 0;
    load(el);
  });
  el.querySelector('#audit-host').addEventListener('change', (e) => {
    state.hostId = e.target.value;
    state.offset = 0;
    load(el);
  });
  el.querySelector('#audit-refresh').addEventListener('click', () => load(el));
  el.querySelector('#audit-export').addEventListener('click', () => {
    window.open('/api/audit/export', '_blank');
  });
  el.querySelector('#audit-prev').addEventListener('click', () => {
    state.offset = Math.max(0, state.offset - state.limit);
    load(el);
  });
  el.querySelector('#audit-next').addEventListener('click', () => {
    if (state.offset + state.limit < state.total) {
      state.offset += state.limit;
      load(el);
    }
  });

  await load(el);
}

async function load(el) {
  const list = el.querySelector('#audit-list');
  const params = new URLSearchParams({ limit: state.limit, offset: state.offset });
  if (state.result) params.set('result', state.result);
  if (state.hostId) params.set('hostId', state.hostId);

  let body;
  try {
    const res = await fetch(`/api/audit?${params}`);
    body = await res.json();
  } catch {
    list.innerHTML = '<div class="placeholder-box">加载失败</div>';
    return;
  }
  state.total = body.total ?? 0;

  if (!body.items?.length) {
    list.innerHTML = '<div class="placeholder-box">暂无审计记录</div>';
  } else {
    list.innerHTML = body.items
      .map(
        (ev) => `<div class="audit-row">
          <span class="audit-time">${formatTime(ev.ts)}</span>
          <span class="audit-event">${EVENT_LABEL[ev.event] ?? ev.event}</span>
          <span class="audit-host">${escapeHtml(ev.hostId ?? '-')}<span class="audit-addr">${escapeHtml(ev.hostAddress ?? '')}</span></span>
          <span class="tag ${ev.result === 'success' ? 'ok' : ev.result === 'denied' ? 'warn' : ''}">${RESULT_LABEL[ev.result] ?? ev.result}</span>
          <span class="audit-detail">${ev.durationMs != null ? `${ev.durationMs}ms ` : ''}${ev.reason ? escapeHtml(ev.reason) : ''}${ev.actorType === 'token' ? ` · 令牌:${escapeHtml(ev.tokenId ?? '')}` : ''}</span>
        </div>`
      )
      .join('');
  }

  const info = el.querySelector('#audit-page-info');
  info.textContent = `第 ${state.offset + 1}–${Math.min(state.offset + state.limit, state.total)} 条 / 共 ${state.total} 条`;
  el.querySelector('#audit-prev').disabled = state.offset === 0;
  el.querySelector('#audit-next').disabled = state.offset + state.limit >= state.total;
}

function formatTime(ts) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

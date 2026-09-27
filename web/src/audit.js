// 审计页（US4 / FR-012）：渲染在「设置 → 审计」页签中
import { apiUrl } from './base.js';
// 时间顺序列表 + result/hostId 过滤 + 分页 + 导出
const EVENT_LABEL = {
  'connect-attempt': '连接尝试',
  'connect-success': '连接成功',
  'connect-failure': '连接失败',
  command: '命令执行',
  'file-read': '文件读取',
  'file-write': '文件写入',
  disconnect: '断开连接',
  'group_rename': '分组重命名',
  'group_delete': '分组删除',
};
const RESULT_LABEL = { success: '成功', denied: '拒绝', error: '失败' };

let state = { result: '', hostId: '', offset: 0, limit: 30, total: 0 };

export async function renderAudit(el) {
  el.innerHTML = `
    <div class="audit-note">
      <b>审计说明</b>：按时间顺序记录全部连接行为与工具调用（元数据脱敏留存，不含凭据与终端输出全文）。
      列：时间 / 事件 / 设备 ID / 状态，补充信息（断开原因、时长、令牌）附于事件下方；支持按结果与主机过滤、分页与导出。
    </div>
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
    <div class="audit-list audit-table">
      <div class="audit-head">
        <span>时间</span><span>事件</span><span>设备 ID</span><span>状态</span>
      </div>
      <div id="audit-list-body"><div class="placeholder-box">加载中…</div></div>
    </div>
    <div class="audit-pager">
      <button class="btn" id="audit-prev">上一页</button>
      <span id="audit-page-info" class="audit-page-info"></span>
      <button class="btn" id="audit-next">下一页</button>
    </div>`;

  // 主机过滤选项
  try {
    const hosts = await (await fetch(apiUrl('hosts'))).json();
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
    window.open(apiUrl('audit/export'), '_blank');
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
  const list = el.querySelector('#audit-list-body');
  const params = new URLSearchParams({ limit: state.limit, offset: state.offset });
  if (state.result) params.set('result', state.result);
  if (state.hostId) params.set('hostId', state.hostId);

  let body;
  try {
    const res = await fetch(`${apiUrl('audit')}?${params}`);
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
        (ev) => {
          // 事件列副文本：时长 / 原因 / 令牌主体（脱敏元数据）
          const subs = [];
          if (ev.durationMs != null) subs.push(`时长 ${ev.durationMs}ms`);
          if (ev.reason) subs.push(escapeHtml(ev.reason));
          if (ev.actorType === 'token') subs.push(`令牌:${escapeHtml(ev.tokenId ?? '')}`);
          const sub = subs.length ? `<span class="audit-sub">${subs.join(' · ')}</span>` : '';
          const hostTitle = ev.hostId
            ? ` title="${escapeHtml(ev.hostId)}${ev.hostAddress ? ' · ' + escapeHtml(ev.hostAddress) : ''}"`
            : '';
          return `<div class="audit-row">
            <span class="audit-time">${formatTime(ev.ts)}</span>
            <span class="audit-cell-event"><span class="audit-event">${EVENT_LABEL[ev.event] ?? ev.event}</span>${sub}</span>
            <span class="audit-host-id"${hostTitle}>${escapeHtml(ev.hostId ?? '-')}${ev.hostAddress ? `<span class="audit-addr">${escapeHtml(ev.hostAddress)}</span>` : ''}</span>
            <span class="audit-cell-status"><span class="tag ${ev.result === 'success' ? 'ok' : ev.result === 'denied' ? 'warn' : ''}">${RESULT_LABEL[ev.result] ?? ev.result}</span></span>
          </div>`;
        }
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

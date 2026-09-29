// 审计页（US4 / FR-012）：设置弹窗内渲染，按类别分两个页签
// - 操作审计（category=operation）：登录记录（连接尝试/成功/失败）、断开、
//   文件读取、分组管理等操作调用记录（一切非命令事件）
// - 命令审计（category=commands）：按会话聚合展开——在线会话实时标记，
//   展开会话可查看该会话执行过的全部命令；MCP 令牌调用归入「无会话」组
import { apiUrl } from './base.js';
import { icon } from './icons.js';

const EVENT_LABEL = {
  'connect-attempt': '连接尝试',
  'connect-success': '连接成功',
  'connect-failure': '连接失败',
  command: '命令执行',
  'file-read': '文件读取',
  'file-write': '文件写入',
  disconnect: '断开连接',
  'group_create': '分组新建',
  'group_rename': '分组重命名',
  'group_delete': '分组删除',
};
const RESULT_LABEL = { success: '成功', denied: '拒绝', error: '失败' };

let state = { category: 'operation', result: '', hostId: '', source: '', command: '', sessionId: '', from: '', to: '', offset: 0, limit: 30, total: 0 };

/**
 * 渲染审计页。
 * @param {HTMLElement} el
 * @param {'operation'|'commands'} category operation=操作审计，commands=命令审计
 */
export async function renderAudit(el, category = 'operation') {
  state = { category, result: '', hostId: '', source: '', command: '', sessionId: '', from: '', to: '', offset: 0, limit: 30, total: 0 };
  const isCmd = category === 'commands';
  if (isCmd) return renderSessionView(el);

  el.innerHTML = `
    <div class="audit-note">
      ${
        isCmd
          ? `<b>命令审计</b>：记录每一条实际执行的命令——Web 终端按回车提交的输入与 MCP 令牌的 run_command 调用（原文脱敏留存）。
             点击「查看」可见完整命令原文、来源、所属会话 ID 与输出摘要。`
          : `<b>操作审计</b>：按时间顺序记录登录（连接尝试/成功/失败，时间即会话创建时间）与操作调用（断开、文件读取、分组管理等非命令事件）。
             元数据脱敏留存，不含凭据与终端输出全文。`
      }
      支持按${isCmd ? '命令原文、' : ''}时间范围、会话 ID、来源、结果与主机过滤、分页与导出。
    </div>
    <div class="audit-toolbar">
      ${
        isCmd
          ? `<input id="audit-command" class="audit-search" type="search"
        placeholder="按命令原文查询…" autocomplete="off" />`
          : ''
      }
      <input id="audit-sid" class="audit-search audit-sid-input" type="search"
        placeholder="会话 ID（点击记录中的 会话:s_… 自动填入）" autocomplete="off" />
      <input id="audit-from" class="audit-search audit-time-input" type="datetime-local" title="起始时间（含）" />
      <input id="audit-to" class="audit-search audit-time-input" type="datetime-local" title="结束时间（含）" />
      <select id="audit-source">
        <option value="">全部来源</option>
        <option value="user">人工操作</option>
        <option value="mcp">MCP 令牌调用</option>
      </select>
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
      <div class="audit-head ${isCmd ? 'audit-head-cmd' : 'audit-head-op'}">
        ${
          isCmd
            ? '<span>时间</span><span>来源</span><span>设备 ID</span><span>命令</span><span>状态</span><span>操作</span>'
            : '<span>时间</span><span>事件</span><span>设备 ID</span><span>状态</span><span>操作</span>'
        }
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

  // 文本类过滤（命令原文 / 会话 ID）：回车或清空即时触发，输入停顿 300ms 自动查询
  const bindDebouncedInput = (selector, key) => {
    const input = el.querySelector(selector);
    if (!input) return;
    let searchTimer = null;
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const v = input.value.trim();
      if (v === '') {
        state[key] = '';
        state.offset = 0;
        load(el);
      } else {
        searchTimer = setTimeout(() => {
          state[key] = v;
          state.offset = 0;
          load(el);
        }, 300);
      }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(searchTimer);
        state[key] = input.value.trim();
        state.offset = 0;
        load(el);
      }
    });
  };
  if (isCmd) bindDebouncedInput('#audit-command', 'command');
  bindDebouncedInput('#audit-sid', 'sessionId');

  // 时间范围筛选（会话创建时间 = 连接尝试事件时间）
  for (const [sel, key] of [['#audit-from', 'from'], ['#audit-to', 'to']]) {
    el.querySelector(sel).addEventListener('change', (e) => {
      state[key] = e.target.value ? new Date(e.target.value).toISOString() : '';
      state.offset = 0;
      load(el);
    });
  }

  // 点击记录中的「会话:s_…」→ 自动填入会话 ID 并查询该会话全部事件
  el.querySelector('#audit-list-body').addEventListener('click', (e) => {
    const sid = e.target.closest('.audit-sid-link');
    if (!sid) return;
    const input = el.querySelector('#audit-sid');
    input.value = sid.dataset.sid;
    state.sessionId = sid.dataset.sid;
    state.offset = 0;
    load(el);
  });

  el.querySelector('#audit-source').addEventListener('change', (e) => {
    state.source = e.target.value;
    state.offset = 0;
    load(el);
  });
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
    const p = new URLSearchParams();
    if (state.source) p.set('source', state.source);
    window.open(`${apiUrl('audit/export')}?${p}`, '_blank');
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
  const params = new URLSearchParams({ limit: state.limit, offset: state.offset, category: state.category });
  if (state.result) params.set('result', state.result);
  if (state.hostId) params.set('hostId', state.hostId);
  if (state.source) params.set('source', state.source);
  if (state.command) params.set('command', state.command);
  if (state.sessionId) params.set('sessionId', state.sessionId);
  if (state.from) params.set('from', state.from);
  if (state.to) params.set('to', state.to);

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
      .map((ev, idx) => renderRow(ev, idx, state.category))
      .join('');
    // 「查看」详情弹窗（行内闭包绑定对应事件）
    list.querySelectorAll('.audit-row').forEach((rowEl) => {
      rowEl.querySelector('.audit-view').addEventListener('click', () => {
        showEventDetail(body.items[Number(rowEl.dataset.idx)]);
      });
    });
  }

  const info = el.querySelector('#audit-page-info');
  info.textContent = `第 ${state.offset + 1}–${Math.min(state.offset + state.limit, state.total)} 条 / 共 ${state.total} 条`;
  el.querySelector('#audit-prev').disabled = state.offset === 0;
  el.querySelector('#audit-next').disabled = state.offset + state.limit >= state.total;
}

/** 会话 ID 副文本（可点击 → 按该会话筛选全部事件） */
function sidLink(ev) {
  if (!ev.sessionId) return '';
  return `<span class="audit-sub audit-sid-link" data-sid="${escapeHtml(ev.sessionId)}" title="查看该会话的全部事件">会话:${escapeHtml(ev.sessionId)}</span>`;
}

/** 单行渲染：命令审计与操作审计列结构不同 */
function renderRow(ev, idx, category) {
  const status = `<span class="audit-cell-status"><span class="tag ${ev.result === 'success' ? 'ok' : ev.result === 'denied' ? 'warn' : ''}">${RESULT_LABEL[ev.result] ?? ev.result}</span></span>`;
  const op = `<span class="audit-cell-op"><button class="audit-view" type="button">查看</button></span>`;
  const time = `<span class="audit-time">${formatTime(ev.ts)}</span>`;
  const hostTitle = ev.hostId
    ? ` title="${escapeHtml(ev.hostId)}${ev.hostAddress ? ' · ' + escapeHtml(ev.hostAddress) : ''}"`
    : '';
  const host = `<span class="audit-host-id"${hostTitle}>${escapeHtml(ev.hostId ?? '-')}${ev.hostAddress ? `<span class="audit-addr">${escapeHtml(ev.hostAddress)}</span>` : ''}</span>`;
  const rowOpen = `<div class="audit-row ${category === 'commands' ? 'audit-row-cmd' : 'audit-row-op'}" data-idx="${idx}">`;

  if (category === 'commands') {
    // 来源：Web 终端（人工）或 MCP 令牌
    const src = ev.actorType === 'token' ? 'MCP 令牌' : 'Web 终端';
    const srcSub = ev.actorType === 'token'
      ? (ev.tokenId ? `<span class="audit-sub">令牌:${escapeHtml(ev.tokenId)}</span>` : '')
      : sidLink(ev); // Web 终端命令显示所属会话
    const cmd = ev.command
      ? `<span class="audit-cmd" title="${escapeHtml(ev.command)}">${escapeHtml(ev.command)}</span>`
      : '<span class="audit-cmd audit-cmd-none">-</span>';
    return `${rowOpen}${time}
      <span class="audit-cell-event"><span class="audit-event">${src}</span>${srcSub}</span>
      ${host}
      <span class="audit-cell-cmd">${cmd}</span>
      ${status}${op}</div>`;
  }

  // 操作审计：事件列副文本（时长 / 原因 / 令牌主体 / 会话）
  const subs = [];
  if (ev.durationMs != null) subs.push(`时长 ${ev.durationMs}ms`);
  if (ev.reason) subs.push(escapeHtml(ev.reason));
  if (ev.actorType === 'token') subs.push(`令牌:${escapeHtml(ev.tokenId ?? '')}`);
  const sub = subs.length ? `<span class="audit-sub">${subs.join(' · ')}</span>` : '';
  return `${rowOpen}${time}
    <span class="audit-cell-event"><span class="audit-event">${EVENT_LABEL[ev.event] ?? ev.event}</span>${sub}${sidLink(ev)}</span>
    ${host}
    ${status}${op}</div>`;
}

/**
 * 审计事件详情：独立二级浮层（不用全局 modal 单例，避免替换掉设置弹窗）。
 * 卡片式布局：头部（事件徽章 + 状态 + 时间）→ 元数据网格 → 终端风格命令块。
 */
function showEventDetail(ev) {
  const statusClass = ev.result === 'success' ? 'ok' : ev.result === 'denied' ? 'warn' : 'err';
  const meta = [
    ['来源', ev.actorType === 'token' ? `MCP 令牌（${ev.tokenId ?? '-'}）` : 'Web 终端（人工）'],
    ['主机', ev.hostId ? `${ev.hostId}${ev.hostAddress ? ` (${ev.hostAddress})` : ''}` : '-'],
    ev.sessionId && ['会话 ID', ev.sessionId],
    ['创建时间', new Date(ev.ts).toLocaleString('zh-CN', { hour12: false })],
    ev.authType && ['认证方式', ev.authType],
    ev.durationMs != null && ['时长', `${ev.durationMs}ms`],
    ev.reason && ['原因', ev.reason],
    ev.path && ['路径', ev.path],
  ].filter(Boolean);

  const overlay = document.createElement('div');
  overlay.className = 'audit-detail-overlay';
  overlay.innerHTML = `
    <div class="detail-mask"></div>
    <div class="detail-card">
      <div class="detail-head">
        <span class="detail-badge">${escapeHtml(EVENT_LABEL[ev.event] ?? ev.event)}</span>
        <span class="tag ${statusClass}">${RESULT_LABEL[ev.result] ?? ev.result}</span>
        <span class="detail-time">${new Date(ev.ts).toLocaleString('zh-CN', { hour12: false })}</span>
        <button class="icon-btn detail-close" title="关闭">${icon('x', 13)}</button>
      </div>
      <div class="detail-meta">
        ${meta.map(([k, v]) => `<div class="meta-item"><span class="meta-key">${escapeHtml(k)}</span><span class="meta-val">${escapeHtml(String(v))}</span></div>`).join('')}
      </div>
      ${ev.command ? `
      <div class="detail-block">
        <div class="block-title">命令原文<button class="detail-copy" data-copy="command" type="button">复制</button></div>
        <pre class="detail-code"><code>${escapeHtml(ev.command)}</code></pre>
      </div>` : ''}
      ${ev.outputDigest ? `
      <div class="detail-block">
        <div class="block-title">输出摘要（脱敏）<button class="detail-copy" data-copy="digest" type="button">复制</button></div>
        <pre class="detail-code digest"><code>${escapeHtml(ev.outputDigest)}</code></pre>
      </div>` : ''}
    </div>`;
  document.body.appendChild(overlay);
  // 入场动画：强制 reflow 后加 class 触发过渡
  requestAnimationFrame(() => overlay.classList.add('show'));

  const close = () => {
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 150);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  overlay.querySelector('.detail-mask').addEventListener('click', close);
  overlay.querySelector('.detail-close').addEventListener('click', close);
  overlay.querySelectorAll('.detail-copy').forEach((b) => {
    b.addEventListener('click', () => {
      const text = b.dataset.copy === 'command' ? ev.command : ev.outputDigest;
      navigator.clipboard?.writeText(text ?? '').then(() => {
        b.textContent = '已复制';
        setTimeout(() => (b.textContent = '复制'), 1200);
      });
    });
  });
}

function formatTime(ts) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ———— 命令审计：会话聚合视图 ————

/** 命令审计：按会话展开。会话行（在线/已关闭）→ 展开后内嵌该会话的命令列表 */
async function renderSessionView(el) {
  el.innerHTML = `
    <div class="audit-note">
      <b>命令审计</b>：按会话组织——每行是一个终端会话（创建时间、主机、命令数、在线状态），
      点击展开可查看该会话执行过的全部命令（含 MCP 令牌的 run_command 调用，归入「MCP 令牌调用」组）。
      支持按会话创建时间范围与主机过滤。
    </div>
    <div class="audit-toolbar">
      <input id="audit-from" class="audit-search audit-time-input" type="datetime-local" title="会话创建起始时间（含）" />
      <input id="audit-to" class="audit-search audit-time-input" type="datetime-local" title="会话创建结束时间（含）" />
      <select id="audit-host"><option value="">全部主机</option></select>
      <button class="btn" id="audit-export">导出</button>
      <button class="btn" id="audit-refresh">刷新</button>
    </div>
    <div class="audit-list" id="session-list"><div class="placeholder-box">加载中…</div></div>`;

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

  for (const [sel, key] of [['#audit-from', 'from'], ['#audit-to', 'to']]) {
    el.querySelector(sel).addEventListener('change', (e) => {
      state[key] = e.target.value ? new Date(e.target.value).toISOString() : '';
      loadSessions(el);
    });
  }
  el.querySelector('#audit-host').addEventListener('change', (e) => {
    state.hostId = e.target.value;
    loadSessions(el);
  });
  el.querySelector('#audit-refresh').addEventListener('click', () => loadSessions(el));
  el.querySelector('#audit-export').addEventListener('click', () => {
    window.open(`${apiUrl('audit/export')}?source=user`, '_blank');
  });

  await loadSessions(el);
}

async function loadSessions(el) {
  const list = el.querySelector('#session-list');
  const params = new URLSearchParams();
  if (state.from) params.set('from', state.from);
  if (state.to) params.set('to', state.to);
  if (state.hostId) params.set('hostId', state.hostId);

  let body;
  try {
    body = await (await fetch(`${apiUrl('audit/sessions')}?${params}`)).json();
  } catch {
    list.innerHTML = '<div class="placeholder-box">加载失败</div>';
    return;
  }
  const sessions = body.sessions ?? [];

  if (!sessions.length) {
    list.innerHTML = '<div class="placeholder-box">暂无会话记录</div>';
    return;
  }

  list.innerHTML =
    sessions
      .map(
        (s) => `<div class="session-item" data-sid="${escapeHtml(s.sessionId)}">
          <div class="session-row">
            <span class="session-toggle">${icon('chevron', 13)}</span>
            <span class="tag ${s.online ? 'ok' : 'closed'}">${s.online ? '在线' : '已关闭'}</span>
            <span class="session-sid" title="会话 ID">${escapeHtml(s.sessionId)}</span>
            <span class="session-host" title="${escapeHtml(s.hostAddress ?? '')}">${escapeHtml(s.hostId ?? '-')}</span>
            <span class="session-time">${formatTime(s.createdAt)} 创建</span>
            <span class="session-count">${s.commandCount} 条命令</span>
            ${s.failed ? '<span class="tag warn">连接失败</span>' : ''}
          </div>
          <div class="session-cmds" hidden></div>
        </div>`
      )
      .join('') +
    // MCP 令牌调用（无会话）归入末尾虚拟组
    `<div class="session-item" data-sid="__mcp__">
      <div class="session-row">
        <span class="session-toggle">${icon('chevron', 13)}</span>
        <span class="tag">MCP</span>
        <span class="session-host" style="flex:1">MCP 令牌调用（无会话）</span>
        <span class="session-count"></span>
      </div>
      <div class="session-cmds" hidden></div>
    </div>`;

  // 展开/折叠
  list.querySelectorAll('.session-item').forEach((item) => {
    item.querySelector('.session-row').addEventListener('click', () => {
      const panel = item.querySelector('.session-cmds');
      const opening = panel.hidden;
      item.classList.toggle('open', opening); // chevron 旋转由 CSS 过渡驱动
      if (!opening) {
        panel.hidden = true;
        return;
      }
      panel.hidden = false;
      loadSessionCommands(panel, item.dataset.sid);
    });
  });
}

/** 展开会话：加载该会话执行的命令（倒序），MCP 组加载全部令牌命令 */
async function loadSessionCommands(panel, sid) {
  panel.innerHTML = '<div class="placeholder-box" style="padding:12px 0">加载中…</div>';
  const url =
    sid === '__mcp__'
      ? `${apiUrl('audit')}?category=commands&source=mcp&limit=500`
      : `${apiUrl('audit')}?category=commands&sessionId=${encodeURIComponent(sid)}&limit=500`;
  let body;
  try {
    body = await (await fetch(url)).json();
  } catch {
    panel.innerHTML = '<div class="placeholder-box" style="padding:12px 0">加载失败</div>';
    return;
  }
  const items = body.items ?? [];
  panel.innerHTML = items.length
    ? `<div class="cmd-sublist">${items
        .map(
          (ev, idx) => `<div class="cmd-row" data-idx="${idx}">
            <span class="audit-time">${formatTime(ev.ts)}</span>
            <span class="audit-cmd" title="${escapeHtml(ev.command ?? '')}">${escapeHtml(ev.command ?? '-')}</span>
            <span class="tag ${ev.result === 'success' ? 'ok' : ev.result === 'denied' ? 'warn' : ''}">${RESULT_LABEL[ev.result] ?? ev.result}</span>
            <button class="audit-view" type="button">查看</button>
          </div>`
        )
        .join('')}</div>`
    : '<div class="cmd-empty">该会话暂无命令记录</div>';

  panel.querySelectorAll('.cmd-row').forEach((row) => {
    row.querySelector('.audit-view').addEventListener('click', (e) => {
      e.stopPropagation();
      showEventDetail(items[Number(row.dataset.idx)]);
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

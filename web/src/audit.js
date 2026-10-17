// 审计页（US4 / FR-012）：设置弹窗内渲染，按类别分两个页签
// - 操作审计（category=operation）：登录记录（连接尝试/成功/失败）、断开、
//   文件读取、分组管理等操作调用记录（一切非命令事件）
// - 命令审计（category=commands）：按会话聚合展开——在线会话实时标记，
//   展开会话可查看该会话执行过的全部命令；MCP 令牌调用归入「无会话」组
import { apiUrl } from './base.js';
import { icon } from './icons.js';
import { closeModal } from './modal.js';
import { activateTab, restoreTab, findLocalTab } from './terminal.js';
import { apiFetch, renderTwofaGate } from './twofa.js';

/**
 * 403 twofa_required → 在容器内渲染2FA验证引导页（进入2FA验证/恢复入口/自动弹码开关）。
 * 「自动弹出验证」偏好关闭时审计加载请求不再自动弹码，改由此呈现引导页；
 * 偏好开启时用户取消弹码同样落此页。验证/恢复成功后 retry 重载原内容。
 * @returns {boolean} true = 已渲染引导页（调用方应终止本次加载）
 */
function twofaGateOrNot(res, container, retry) {
  if (res.status !== 403) return false;
  renderTwofaGate(container, { onDone: retry });
  return true;
}

const EVENT_LABEL = {
  'connect-attempt': '连接尝试',
  'connect-success': '连接成功',
  'connect-failure': '连接失败',
  command: '命令执行',
  'quick-exec': '快捷命令',
  'host_create': '新建会话连接',
  'host_update': '编辑会话连接',
  'host_delete': '删除会话连接',
  'host_duplicate': '复制会话连接',
  'credential-update': '凭据更新',
  'file-read': '文件读取',
  'file-write': '文件写入',
  disconnect: '断开连接',
  detach: '会话挂起',
  resume: '会话恢复',
  'group_create': '分组新建',
  'group_rename': '分组重命名',
  'group_delete': '分组删除',
  twofa_setup: '2FA验证开始绑定',
  twofa_confirm: '2FA验证绑定成功',
  twofa_disable: '2FA验证关闭',
  twofa_verify: '2FA验证通过',
  twofa_verify_failure: '2FA验证失败',
  twofa_locked: '2FA验证锁定',
  twofa_actions_update: '2FA验证保护范围更新',
  twofa_recovery_success: '恢复码恢复成功',
  twofa_recovery_failure: '恢复码恢复失败',
  twofa_recovery_wipe: '恢复失败触发数据清除',
  'mcp-session-start': 'MCP 连接初始化',
  'mcp-session-end': 'MCP 连接结束',
  token_rename: '令牌重命名',
  token_restore: '令牌恢复',
  token_delete: '令牌永久删除',
  'twofa_ticket_ttl_update': '2FA验证票据有效期更新',
  'audit_settings_update': '审计设置更新',
  'mcp_direct_update': 'MCP直连配置更新',
  profile_update: '个人资料更新',
  avatar_upload: '头像上传',
  avatar_delete: '头像删除',
};
const RESULT_LABEL = { success: '成功', denied: '拒绝', error: '失败' };

// 页面说明（收敛为工具栏末尾的感叹号图标，悬停展开气泡）
const NOTE = {
  operation: `<b>操作审计</b>：按时间顺序记录登录（连接尝试/成功/失败，时间即会话创建时间）与操作调用（断开、文件读取、分组管理等非命令事件）。
    元数据脱敏留存，不含凭据与终端输出全文。支持按时间范围、会话 ID、来源、结果与主机过滤、分页与导出。`,
  sessions: `<b>命令审计</b>：按会话组织——每行是一个终端会话（创建时间、主机、命令数、在线状态），
    点击展开可查看该会话执行过的全部命令。AI Agent（MCP）会话同样按会话归组（m_ 前缀，
    主机列显示该会话涉及的主机台数，展开后每条命令标明目标主机）；仅完成协议握手（initialize）
    而未调用任何工具的 MCP 会话不在此列（可在操作审计中查看其连接记录）；不带会话的旧客户端
    令牌调用归入「MCP 令牌调用」组。支持按会话创建时间范围与主机过滤。`,
};

// 命令审计：会话表头（与数据行共用 grid 模板，保证列对齐）
const SESSION_HEAD = `
  <div class="session-head">
    <span></span>
    <span>状态</span>
    <span>会话 ID</span>
    <span>主机名</span>
    <span>创建时间</span>
    <span>标记</span>
    <span class="session-count">命令数</span>
    <span>操作</span>
  </div>`;

// 可筛选条件（key 与 state 字段同名；time 对应 from/to 一对）
const CONDS = [
  { key: 'time', label: '时间范围' },
  { key: 'sessionId', label: '会话 ID' },
  { key: 'source', label: '来源' },
  { key: 'result', label: '结果' },
  { key: 'hostId', label: '主机' },
];

let state = { category: 'operation', result: '', hostId: '', source: '', command: '', sessionId: '', from: '', to: '', offset: 0, limit: 30, total: 0 };

// 主机 ID → 名称缓存（会话视图加载时填充，命令行显示主机名用）
const hostNames = {};

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
    <div class="audit-toolbar">
      ${filterBoxHtml()}
      <button class="btn" id="audit-export">导出</button>
      ${infoTipHtml(NOTE.operation)}
    </div>
    <div class="audit-list audit-table">
      <div class="audit-head audit-head-op">
        <span>时间</span><span>事件</span><span>设备 ID</span><span>状态</span><span>操作</span>
      </div>
      <div id="audit-list-body"><div class="placeholder-box">加载中…</div></div>
    </div>
    <div class="audit-pager">
      <button class="btn" id="audit-prev">上一页</button>
      <span id="audit-page-info" class="audit-page-info"></span>
      <button class="btn" id="audit-next">下一页</button>
    </div>`;

  // 统一筛选框：点击「+ 添加筛选」选择条件，值以 chip 聚合在搜索框内
  const filter = setupFilter(el, ['time', 'sessionId', 'source', 'result', 'hostId'], () => load(el));

  // 点击记录中的「会话:s_…」→ 自动填入会话 ID 并查询该会话全部事件
  el.querySelector('#audit-list-body').addEventListener('click', (e) => {
    const sid = e.target.closest('.audit-sid-link');
    if (!sid) return;
    state.sessionId = sid.dataset.sid;
    state.offset = 0;
    filter.renderChips();
    load(el);
  });

  el.querySelector('#audit-export').addEventListener('click', () => {
    const p = new URLSearchParams();
    if (state.source) p.set('source', state.source);
    downloadAuditExport(p);
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

/** 统一筛选框骨架：搜索图标 + chip 区 + 「+ 添加筛选」入口（条件菜单/编辑器挂在入口下） */
function filterBoxHtml() {
  return `
    <div class="af-box" id="af-box">
      ${icon('search', 13)}
      <span class="af-chips" id="af-chips"></span>
      <span class="af-entry">
        <button class="af-add" id="af-add" type="button">${icon('plus', 11)} 添加筛选</button>
        <span class="af-menu" id="af-menu" hidden></span>
        <span class="af-editor" id="af-editor" hidden></span>
      </span>
    </div>`;
}

/** 说明气泡：感叹号图标，悬停/聚焦展开 */
function infoTipHtml(note) {
  return `
    <span class="audit-info" tabindex="0" role="note" aria-label="页面说明">
      ${icon('info', 15)}
      <span class="audit-info-tip">${note}</span>
    </span>`;
}

/**
 * 统一筛选框：把原先分散的搜索/时间/下拉控件聚合为一个搜索框。
 * 点击「+ 添加筛选」选择条件（时间/会话 ID/来源/结果/主机），弹出对应编辑器；
 * 已生效的条件以 chip 形式呈现在框内——点击 chip 再编辑，× 移除该条件。
 * @param {HTMLElement} el 页签容器
 * @param {string[]} condKeys 该视图可用的条件（CONDS 的子集）
 * @param {() => void} reload 条件变化后的重新加载
 * @returns {{ renderChips: () => void }} 供「会话:s_…」快捷筛选后刷新 chip
 */
function setupFilter(el, condKeys, reload) {
  const box = el.querySelector('#af-box');
  const chipsEl = el.querySelector('#af-chips');
  const addBtn = el.querySelector('#af-add');
  const menu = el.querySelector('#af-menu');
  const editor = el.querySelector('#af-editor');
  const conds = CONDS.filter((c) => condKeys.includes(c.key));
  const condLabel = Object.fromEntries(conds.map((c) => [c.key, c.label]));
  const hostMap = {};

  menu.innerHTML = conds.map((c) => `<button type="button" data-cond="${c.key}">${c.label}</button>`).join('');

  // 主机选项（hostId 条件下拉与 chip 名称显示）
  fetch(apiUrl('hosts'))
    .then((r) => r.json())
    .then((hosts) => {
      for (const h of hosts) hostMap[h.id] = h.name;
      renderChips();
    })
    .catch(() => {});

  const fmtShort = (iso) =>
    new Date(iso).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const toLocalInput = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  function chipText(key) {
    switch (key) {
      case 'time': {
        if (!state.from && !state.to) return '';
        return `时间 ${state.from ? fmtShort(state.from) : '…'} ~ ${state.to ? fmtShort(state.to) : '…'}`;
      }
      case 'sessionId': return state.sessionId ? `会话 ${state.sessionId}` : '';
      case 'source': return state.source ? `来源 ${state.source === 'user' ? '人工操作' : 'MCP 令牌'}` : '';
      case 'result': return state.result ? `结果 ${RESULT_LABEL[state.result] ?? state.result}` : '';
      case 'hostId': return state.hostId ? `主机 ${hostMap[state.hostId] ?? state.hostId}` : '';
      default: return '';
    }
  }

  function renderChips() {
    chipsEl.innerHTML = conds
      .map((c) => {
        const text = chipText(c.key);
        if (!text) return '';
        return `<span class="af-chip" data-cond="${c.key}" title="点击编辑该条件">${escapeHtml(text)}<button class="af-chip-x" data-remove="${c.key}" type="button" title="移除条件">${icon('x', 9)}</button></span>`;
      })
      .join('');
  }

  function commit() {
    state.offset = 0;
    renderChips();
    reload();
  }

  function closeEditor() {
    editor.hidden = true;
    editor.innerHTML = '';
  }

  function openEditor(key) {
    menu.hidden = true;
    editor.hidden = false;
    editor.dataset.cond = key;
    if (key === 'time') {
      editor.innerHTML = `
        <input type="datetime-local" class="af-time" value="${toLocalInput(state.from)}" title="起始时间（含）" />
        <span class="af-sep">至</span>
        <input type="datetime-local" class="af-time" value="${toLocalInput(state.to)}" title="结束时间（含）" />
        <button class="af-done" type="button">完成</button>`;
      const [fromIn, toIn] = editor.querySelectorAll('input');
      fromIn.addEventListener('change', () => {
        state.from = fromIn.value ? new Date(fromIn.value).toISOString() : '';
        commit();
      });
      toIn.addEventListener('change', () => {
        state.to = toIn.value ? new Date(toIn.value).toISOString() : '';
        commit();
      });
      editor.querySelector('.af-done').addEventListener('click', closeEditor);
    } else if (key === 'sessionId') {
      editor.innerHTML = `<input type="search" class="af-text" autocomplete="off"
        placeholder="输入会话 ID，回车确认" value="${escapeHtml(state.sessionId)}" />`;
      const input = editor.querySelector('input');
      let timer = null;
      const apply = () => {
        state.sessionId = input.value.trim();
        commit();
      };
      input.addEventListener('input', () => {
        clearTimeout(timer);
        if (input.value.trim() === '') {
          apply();
          closeEditor();
        } else {
          timer = setTimeout(apply, 300);
        }
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          clearTimeout(timer);
          apply();
          closeEditor();
        }
        if (e.key === 'Escape') closeEditor();
      });
      input.focus();
    } else {
      // 枚举条件：来源 / 结果 / 主机
      const options = {
        source: [
          ['user', '人工操作'],
          ['mcp', 'MCP 令牌调用'],
        ],
        result: [
          ['success', '成功'],
          ['error', '失败'],
          ['denied', '拒绝'],
        ],
        hostId: Object.entries(hostMap),
      }[key];
      editor.innerHTML = `<select class="af-select">
        <option value="">全部${condLabel[key]}</option>
        ${options.map(([v, l]) => `<option value="${escapeHtml(v)}"${state[key] === v ? ' selected' : ''}>${escapeHtml(l)}</option>`).join('')}
      </select>`;
      const sel = editor.querySelector('select');
      sel.addEventListener('change', () => {
        state[key] = sel.value;
        commit();
        closeEditor();
      });
      sel.focus();
    }
  }

  addBtn.addEventListener('click', () => {
    closeEditor();
    menu.hidden = !menu.hidden;
  });
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-cond]');
    if (b) openEditor(b.dataset.cond);
  });
  chipsEl.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      const key = rm.dataset.remove;
      if (key === 'time') {
        state.from = '';
        state.to = '';
      } else {
        state[key] = '';
      }
      commit();
      return;
    }
    const chip = e.target.closest('.af-chip');
    if (chip) openEditor(chip.dataset.cond);
  });
  // 点击筛选框外部时收起菜单/编辑器；元素销毁后自动解绑
  const onDocDown = (e) => {
    if (!box.isConnected) {
      document.removeEventListener('mousedown', onDocDown, true);
      return;
    }
    if (!box.contains(e.target)) {
      menu.hidden = true;
      closeEditor();
    }
  };
  document.addEventListener('mousedown', onDocDown, true);

  renderChips();
  return { renderChips };
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
    const res = await apiFetch(`audit?${params}`);
    // 引导页渲染整个面板（覆盖工具栏），验证成功后重建审计视图
    if (twofaGateOrNot(res, el, () => renderAudit(el, state.category))) return;
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
      ? (ev.tokenId ? `<span class="audit-sub">令牌:${escapeHtml(ev.tokenId)}</span>` : '') + (ev.sessionId ? sidLink(ev) : '')
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

  // 操作审计：事件列副文本（快捷命令名 / 时长 / 原因 / 令牌主体 / 会话）
  const subs = [];
  if (ev.event === 'quick-exec' && ev.quickName) subs.push(`快捷命令:${escapeHtml(ev.quickName)}`);
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
  // 快捷命令（quick-exec）：展示备注名而非命令原文（历史记录无 quickName 时回退原文）
  const isQuick = ev.event === 'quick-exec' && !!ev.quickName;
  const cmdTitle = isQuick ? '快捷命令' : '命令原文';
  const cmdText = isQuick ? ev.quickName : ev.command;
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
      ${cmdText ? `
      <div class="detail-block">
        <div class="block-title">${cmdTitle}<button class="detail-copy" data-copy="command" type="button">复制</button></div>
        <pre class="detail-code"><code>${escapeHtml(cmdText)}</code></pre>
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
      const text = b.dataset.copy === 'command' ? cmdText : ev.outputDigest;
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
    <div class="audit-toolbar">
      ${filterBoxHtml()}
      <button class="btn" id="audit-export">导出</button>
      ${infoTipHtml(NOTE.sessions)}
    </div>
    <div class="audit-list" id="session-list"><div class="placeholder-box">加载中…</div></div>`;

  // 统一筛选框：会话视图仅支持时间范围与主机
  setupFilter(el, ['time', 'hostId'], () => loadSessions(el));

  el.querySelector('#audit-export').addEventListener('click', () => {
    downloadAuditExport(new URLSearchParams({ source: 'user' }));
  });

  await loadSessions(el);
}

async function loadSessions(el) {
  const list = el.querySelector('#session-list');
  // 命令行需显示主机名：先填充 ID → 名称映射（失败不阻塞列表加载）
  fetch(apiUrl('hosts'))
    .then((r) => r.json())
    .then((hs) => {
      for (const h of hs) hostNames[h.id] = h.name;
    })
    .catch(() => {});
  const params = new URLSearchParams();
  if (state.from) params.set('from', state.from);
  if (state.to) params.set('to', state.to);
  if (state.hostId) params.set('hostId', state.hostId);

  let body;
  try {
    const res = await apiFetch(`audit/sessions?${params}`);
    if (twofaGateOrNot(res, el, () => renderAudit(el, 'commands'))) return;
    body = await res.json();
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
    SESSION_HEAD +
    sessions
      .map((s) => {
        const isMcp = s.source === 'mcp';
        const statusTag = isMcp
          ? '<span class="tag" title="AI Agent 经 MCP 令牌发起的会话">MCP</span>'
          : `<span class="tag ${s.online ? 'ok' : 'closed'}">${s.online ? '在线' : '已关闭'}</span>`;
        // 主机列：人工会话显示主机名；MCP 会话显示涉及的主机数（悬停列出全部主机）
        const hostTitle = isMcp
          ? (s.hostIds ?? []).map((id) => hostNames[id] ?? id).join(' · ')
          : s.hostAddress ?? '';
        const hostCell = isMcp
          ? `<span class="session-host" title="${escapeHtml(hostTitle)}">${s.hostCount ? `${s.hostCount}台主机` : '-'}</span>`
          : `<span class="session-host" title="${escapeHtml(hostTitle)}">${escapeHtml(s.hostId ?? '-')}</span>`;
        const flags = isMcp
          ? (s.tokenId ? `<span class="tag" title="令牌 ${escapeHtml(s.tokenId)}">令牌调用</span>` : '')
          : `${s.failed ? '<span class="tag warn">连接失败</span>' : ''}${
              localTabOf(s)?.bg ? '<span class="tag warn">后台运行</span>' : ''
            }`;
        return `<div class="session-item" data-sid="${escapeHtml(s.sessionId)}">
          <div class="session-row">
            <span class="session-toggle">${icon('chevron', 13)}</span>
            ${statusTag}
            <span class="session-sid" title="会话 ID">${escapeHtml(s.sessionId)}</span>
            ${hostCell}
            <span class="session-time">${formatTime(s.createdAt)} 创建</span>
            <span class="session-flags">${flags}</span>
            <span class="session-count">${s.commandCount} 条命令</span>
            ${sessionActionHtml(s)}
          </div>
          <div class="session-cmds" hidden></div>
        </div>`;
      })
      .join('') +
    // MCP 令牌调用（无会话）归入末尾虚拟组
    `<div class="session-item" data-sid="__mcp__">
      <div class="session-row mcp">
        <span class="session-toggle">${icon('chevron', 13)}</span>
        <span class="tag">MCP</span>
        <span class="session-host">MCP 令牌调用（无会话）</span>
        <span class="session-count"></span>
      </div>
      <div class="session-cmds" hidden></div>
    </div>`;

  // 「继续连接 / 转到会话 / 重新连接」：把审计里的会话接回终端区（FR-058）
  list.querySelectorAll('.session-act[data-act]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation(); // 行点击是展开命令列表，操作按钮不触发展开
      if (b.dataset.act === 'goto') resumeSession(b.dataset.sid, b.dataset.host);
    });
  });

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

/** 在线会话才可能与本页会话卡对应；已结束的会话一律走「重新连接」 */
function localTabOf(s) {
  return s.online ? findLocalTab(s.sessionId, s.hostId) : null;
}

/** 会话行操作按钮：MCP 会话无终端现场；仅本页还在的会话可「继续连接/转到会话」；已结束的会话不可恢复 */
function sessionActionHtml(s) {
  if (s.source === 'mcp') {
    return '<span class="session-act disabled" title="AI Agent 会话（MCP），无终端现场可恢复">AI 会话</span>';
  }
  const tab = localTabOf(s);
  if (tab) {
    const bg = Boolean(tab.bg);
    return `<button class="audit-view session-act" type="button" data-act="goto" data-sid="${escapeHtml(s.sessionId)}" data-host="${escapeHtml(s.hostId ?? '')}"
      title="${bg ? '该会话正在后台运行：恢复到会话条并继续操作' : '切换到该会话'}">${bg ? '继续连接' : '转到会话'}</button>`;
  }
  if (s.online) {
    return `<span class="session-act disabled" title="该会话不在当前页面（其他标签页或设备），无法在此接入">其他页面</span>`;
  }
  return '<span class="session-act disabled" title="会话已结束，现场不可恢复">已结束</span>';
}

/** 回到终端：后台会话恢复、前台会话直接激活，并关闭设置弹窗露出终端 */
function resumeSession(sid, hostId) {
  const tab = findLocalTab(sid, hostId);
  if (!tab) return;
  if (tab.bg) restoreTab(tab.id);
  else activateTab(tab.id);
  closeModal();
}

/** 展开会话：加载该会话执行的命令（倒序）；MCP 会话（m_*）按会话+来源过滤，无会话组加载全部令牌命令 */
async function loadSessionCommands(panel, sid) {
  panel.innerHTML = '<div class="placeholder-box" style="padding:12px 0">加载中…</div>';
  const path =
    sid === '__mcp__'
      ? `audit?category=commands&source=mcp&limit=500`
      : sid.startsWith('m_')
        ? `audit?category=commands&source=mcp&sessionId=${encodeURIComponent(sid)}&limit=500`
        : `audit?category=commands&sessionId=${encodeURIComponent(sid)}&limit=500`;
  let body;
  try {
    const res = await apiFetch(path);
    if (twofaGateOrNot(res, panel, () => loadSessionCommands(panel, sid))) return;
    body = await res.json();
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
            <span class="cmd-host" title="${escapeHtml(ev.hostId ?? '')}">${escapeHtml(ev.hostId ? (hostNames[ev.hostId] ?? ev.hostId) : '-')}</span>
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

/**
 * 审计导出下载：走 apiFetch（受 2FA 保护，必要时自动弹码），
 * 拿 blob 后经 <a download> 触发保存（window.open 无法携带 X-2FA-Ticket 头）。
 */
async function downloadAuditExport(params) {
  try {
    // 用户主动点击导出：forcePrompt 无视偏好直接弹码
    const res = await apiFetch(`audit/export?${params}`, { forcePrompt: true });
    if (res._twofaCancelled) return; // 用户取消验证：静默放弃导出
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      alert(`导出失败：${err?.error?.message ?? res.statusText}`);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `webssh-audit-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {
    alert('导出失败，请重试');
  }
}

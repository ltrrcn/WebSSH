// 终端页（US1）：主机清单 → 点击打开远程终端
// xterm.js vendored UMD（Terminal / FitAddon 全局）
import { FrameType, encodeDataFrame, PROTOCOL_VERSION } from './protocol/frames.js';

const { Terminal } = window;
const FitAddonCtor = window.FitAddon?.FitAddon ?? window.FitAddon;

let active = null; // { term, ws, fitAddon, onResize }

export async function render(el) {
  disposeActive();
  el.innerHTML = '<div class="placeholder">加载主机清单…</div>';
  let hosts = [];
  try {
    const res = await fetch('/api/hosts');
    if (res.ok) hosts = await res.json();
  } catch {
    /* 网络异常时保持空清单 */
  }
  if (!hosts.length) {
    el.innerHTML =
      '<div class="placeholder">暂无主机。请先在「主机」页添加（US2 交付），或检查服务是否可达。</div>';
    return;
  }

  const groups = new Map();
  for (const h of hosts) {
    const g = h.group ?? '默认';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(h);
  }
  el.innerHTML = `<div class="host-picker">
    ${[...groups.entries()]
      .map(
        ([g, list]) => `<div class="host-group">
          <div class="host-group-title">${escapeHtml(g)}</div>
          ${list
            .map(
              (h) => `<button class="host-item" data-id="${escapeHtml(h.id)}">
                <span class="host-name">${escapeHtml(h.name)}</span>
                <span class="host-meta">${escapeHtml(h.username)}@${escapeHtml(h.host)}:${h.port}</span>
                ${h.fingerprintConfirmed ? '' : '<span class="host-warn" title="首次连接需确认指纹">指纹待确认</span>'}
              </button>`
            )
            .join('')}
        </div>`
      )
      .join('')}
  </div>`;
  el.querySelectorAll('.host-item').forEach((btn) =>
    btn.addEventListener('click', () => {
      const host = hosts.find((h) => h.id === btn.dataset.id);
      if (host) openTerminal(el, host);
    })
  );
}

async function openTerminal(el, host) {
  disposeActive();
  el.innerHTML = `
    <div class="term-wrap">
      <div class="term-bar">
        <span class="term-title">${escapeHtml(host.name)} — ${escapeHtml(host.username)}@${escapeHtml(host.host)}</span>
        <span class="term-actions">
          <button id="term-interrupt" title="向远端发送 SIGINT">中断</button>
          <button id="term-close">关闭</button>
        </span>
      </div>
      <div id="term-container"></div>
      <div id="term-status" class="term-status"></div>
    </div>`;

  const term = new Terminal({ cursorBlink: true, fontFamily: 'Menlo, Monaco, monospace', fontSize: 13 });
  let fitAddon = null;
  if (FitAddonCtor) {
    fitAddon = new FitAddonCtor();
    term.loadAddon(fitAddon);
  }
  term.open(document.getElementById('term-container'));
  if (fitAddon) fitAddon.fit();

  const status = document.getElementById('term-status');
  const setStatus = (text, isErr) => {
    status.textContent = text;
    status.classList.toggle('err', Boolean(isErr));
  };
  setStatus('连接中…');

  const url =
    (location.protocol === 'https:' ? 'wss://' : 'ws://') +
    location.host +
    `/ws/terminal?hostId=${encodeURIComponent(host.id)}&version=${PROTOCOL_VERSION}`;
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  // —— 输出分片节流（FR-021）：每帧最多渲染一批，大输出保持界面可响应 ——
  const queue = [];
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    if (!queue.length) return;
    term.write(queue.splice(0, queue.length).join(''));
  };
  const enqueue = (text) => {
    queue.push(text);
    if (!scheduled) {
      scheduled = true;
      setTimeout(flush, 16);
    }
  };

  ws.onmessage = (e) => {
    const buf = new Uint8Array(e.data);
    if (buf[0] === FrameType.DATA) {
      enqueue(new TextDecoder().decode(buf.subarray(1)));
    }
  };

  ws.onopen = () => setStatus('');

  ws.onclose = (e) => {
    const map = {
      4003: '主机不在授权范围',
      4004: '超出并发会话上限',
      4005: '主机指纹未确认：请先在主机页完成指纹确认',
      4006: `连接失败（${e.reason || e.code}）`,
      4010: '会话空闲超时，已自动断开',
      4011: '执行超时，已终止',
    };
    const msg = map[e.code] ?? `连接已关闭（${e.reason || e.code}）`;
    setStatus(msg, true);
    term.write(`\r\n\x1b[31m—— ${msg} ——\x1b[0m\r\n`);
  };

  // —— 上行：键盘输入（含 Ctrl+C 作为数据帧透传）——
  term.onData((d) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(encodeDataFrame(d));
  });

  // —— resize 同步（FR-003）——
  const onResize = () => {
    if (!fitAddon) return;
    fitAddon.fit();
    if (ws.readyState === WebSocket.OPEN && term.cols > 0 && term.rows > 0) {
      const payload = new TextEncoder().encode(JSON.stringify({ cols: term.cols, rows: term.rows }));
      ws.send(new Uint8Array([FrameType.RESIZE, ...payload]));
    }
  };
  window.addEventListener('resize', onResize);

  // —— 显式中断按钮：0x02 信号帧 ——
  document.getElementById('term-interrupt').addEventListener('click', () => {
    if (ws.readyState === WebSocket.OPEN) {
      const payload = new TextEncoder().encode(JSON.stringify({ signal: 'INT' }));
      ws.send(new Uint8Array([FrameType.SIGNAL, ...payload]));
    }
  });
  document.getElementById('term-close').addEventListener('click', () => {
    ws.close(1000);
    render(el);
  });

  active = { term, ws, fitAddon, onResize };
}

export function disposeActive() {
  if (!active) return;
  window.removeEventListener('resize', active.onResize);
  try {
    if (active.ws.readyState === WebSocket.OPEN) active.ws.close(1000);
  } catch {
    /* 忽略 */
  }
  try {
    active.term.dispose();
  } catch {
    /* 忽略 */
  }
  active = null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

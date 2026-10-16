// MCP 管理页签组：配置指引（MCP 接入 mcp.json）+ 高级设置（机器直连端口）+ 权限策略（目录矩阵 + 敏感路径）
// 数据源 GET /api/tokens/defaults、GET /api/mcp-direct；结构与审计/令牌页一致（audit-toolbar / audit-list / audit-row）
// 全局默认矩阵由管理员在配置文件维护，页面只读展示（FR-040：令牌只能收紧）
import { apiUrl } from './base.js';
import { icon } from './icons.js';

const PERM_LABEL = { read: '读', write: '写', modify: '修改' };

/**
 * 通用 mcp.json：Workbuddy（~/.workbuddy/mcp.json）、Claude Code（项目 .mcp.json）、
 * Cursor / Cline 等支持远程 MCP（Streamable HTTP）的客户端均按此结构接入。
 */
export function buildMcpJson(endpoint, token) {
  return JSON.stringify(
    {
      mcpServers: {
        webssh: {
          type: 'http',
          url: endpoint,
          headers: { Authorization: `Bearer ${token || '<令牌明文>'}` },
        },
      },
    },
    null,
    2
  );
}

/** JSON 语法高亮（轻量）：键名蓝色、字符串值绿色；输入需先 escapeHtml 转义的文本 */
export function highlightJson(escaped) {
  return escaped
    .replace(/(&quot;.*?&quot;)(\s*:)/g, '<span class="j-key">$1</span>$2')
    .replace(/(:\s*)(&quot;.*?&quot;)/g, '$1<span class="j-str">$2</span>');
}

/** 轻量 toast（右下角浮出，替代 alert 打断式反馈）；type: ok | err */
export function showToast(message, type = 'ok') {
  let host = document.querySelector('.tc-toast-host');
  if (!host) {
    host = document.createElement('div');
    host.className = 'tc-toast-host';
    document.body.appendChild(host);
  }
  const t = document.createElement('div');
  t.className = `tc-toast ${type}`;
  t.innerHTML = `${icon(type === 'ok' ? 'check' : 'info', 13)}<span>${escapeHtml(message)}</span>`;
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 250);
  }, 2400);
}

/** 配置指引（个人设置 → MCP 管理 → 配置指引）：mcp.json 实时生成 + 一键复制 */
export async function renderTokenConfig(el) {
  el.innerHTML = '<div class="placeholder-box">加载中…</div>';
  let d = null;
  let direct = null;
  try {
    const [resDefaults, resDirect] = await Promise.all([
      fetch(apiUrl('tokens/defaults')),
      fetch(apiUrl('mcp-direct')),
    ]);
    if (resDefaults.ok) d = await resDefaults.json();
    if (resDirect.ok) direct = await resDirect.json();
  } catch {
    /* 网络异常 */
  }
  if (!d) {
    el.innerHTML = '<div class="placeholder-box">加载失败，请稍后重试。</div>';
    return;
  }

  const rate = d.limits?.tokenRateLimitPerMinute ?? 60;
  const execSec = Math.round((d.limits?.execTimeoutMs ?? 60000) / 1000);

  el.innerHTML = `
    <div class="tc-card">
      <div class="tc-card-title">${icon('plug', 15)} MCP 接入 <span class="tag">mcp.json</span></div>
      <div class="tc-card-desc">保存为 AI 客户端的 mcp.json 即完成接入（Workbuddy：<code>~/.workbuddy/mcp.json</code>；Claude Code：项目 <code>.mcp.json</code>；Cursor / Cline 等支持远程 MCP 的客户端按相同字段填写）。填入令牌明文后一键复制即用。</div>
      <div class="tc-mcp-grid">
        <div class="tc-field">
          <label>接入端点</label>
          <div class="tc-endpoint">
            <code id="tc-endpoint"></code>
            <button class="icon-btn" id="tc-endpoint-copy" title="复制端点地址">${icon('list', 13)}</button>
          </div>
        </div>
        <div class="tc-field">
          <label>令牌明文</label>
          <div class="tc-input-wrap">
            <input type="password" id="tc-token-input" class="pref-input" placeholder="粘贴令牌明文（mcp_ 开头，在「MCP 令牌」页创建）" autocomplete="off" spellcheck="false" />
            <button class="icon-btn tc-input-eye" id="tc-token-eye" title="显示 / 隐藏令牌">${icon('eye', 13)}</button>
          </div>
        </div>
      </div>
      <div class="tc-code-win">
        <div class="tc-code-bar">
          <span class="tc-dots"><i class="red"></i><i class="yellow"></i><i class="green"></i></span>
          <span class="tc-code-title">mcp.json</span>
          <span class="tag" id="tc-token-state">待填令牌</span>
          <span class="tc-flex-gap"></span>
          <button class="tc-bar-link" id="tc-token-goto">去创建令牌 →</button>
          <button class="tc-bar-btn" id="mcp-conf-copy">复制</button>
        </div>
        <pre class="tc-conf" id="mcp-conf"></pre>
      </div>
      <div class="tc-meta">
        <span class="tc-meta-chip">认证：Bearer 令牌</span>
        <span class="tc-meta-chip">限流：每令牌 ${rate} 次/分钟，超额返回 rate_limited</span>
        <span class="tc-meta-chip">命令超时：${execSec} 秒，超时强制终止</span>
      </div>
    </div>`;

  // —— mcp.json 实时生成（令牌输入 → 配置即时更新）——
  const tokenInput = el.querySelector('#tc-token-input');
  const confPre = el.querySelector('#mcp-conf');
  const tokenState = el.querySelector('#tc-token-state');
  const endpointEl = el.querySelector('#tc-endpoint');

  // 端点优先级：自定义地址（反代）> 直连端口（用浏览器当前访问的主机名拼真实地址）> 页面 origin
  const currentEndpoint = () =>
    direct?.customEndpoint
      ? direct.customEndpoint
      : direct?.enabled
        ? `http://${location.hostname}:${direct.port ?? 8422}/mcp`
        : `${location.origin}/mcp`;

  const renderConf = () => {
    const ep = currentEndpoint();
    endpointEl.textContent = ep;
    const token = tokenInput.value.trim();
    confPre.innerHTML = highlightJson(escapeHtml(buildMcpJson(ep, token)));
    if (token) {
      tokenState.textContent = '令牌已填入';
      tokenState.className = 'tag ok';
    } else {
      tokenState.textContent = '待填令牌';
      tokenState.className = 'tag warn';
    }
  };
  tokenInput.addEventListener('input', renderConf);

  // 令牌明文显示 / 隐藏切换
  const eyeBtn = el.querySelector('#tc-token-eye');
  eyeBtn.addEventListener('click', () => {
    const show = tokenInput.type === 'password';
    tokenInput.type = show ? 'text' : 'password';
    eyeBtn.classList.toggle('on', show);
    tokenInput.focus();
  });

  // 一键复制 mcp.json
  const copyBtn = el.querySelector('#mcp-conf-copy');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(confPre.textContent);
      copyBtn.textContent = '已复制';
      setTimeout(() => (copyBtn.textContent = '复制'), 1200);
    } catch {
      // 剪贴板不可用（如非安全上下文）：选中文本让用户手动复制
      const r = document.createRange();
      r.selectNode(confPre);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      showToast('剪贴板不可用，已选中配置内容，请手动复制', 'err');
    }
  });

  // 复制端点
  el.querySelector('#tc-endpoint-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(endpointEl.textContent);
      showToast('端点地址已复制');
    } catch {
      showToast('剪贴板不可用', 'err');
    }
  });

  // 直达「MCP 令牌」页创建令牌（切换设置弹窗页签）
  el.querySelector('#tc-token-goto').addEventListener('click', () => {
    el.closest('.settings-layout')?.querySelector('.settings-nav [data-pane="tokens"]')?.click();
  });

  renderConf();
}

/** 高级设置（个人设置 → MCP 管理 → 高级设置）：机器直连端口（统一脏检测 + 单保存） */
export async function renderTokenAdvanced(el) {
  el.innerHTML = '<div class="placeholder-box">加载中…</div>';
  let direct = null;
  try {
    const res = await fetch(apiUrl('mcp-direct'));
    if (res.ok) direct = await res.json();
  } catch {
    /* 网络异常 */
  }
  if (!direct) {
    el.innerHTML = '<div class="placeholder-box">加载失败，请稍后重试。</div>';
    return;
  }

  const defaultPort = direct.port ?? 8422;
  el.innerHTML = `
    <div class="tc-card">
      <div class="tc-card-title">${icon('tunnel', 15)} 机器直连端口
        <span class="tag ${direct.running ? 'ok' : ''}" id="tc-direct-state">${direct.running ? '运行中' : '未启用'}</span>
      </div>
      <div class="tc-card-desc">开启后监听独立 TCP 端口，仅提供 /mcp（令牌鉴权 + 限流 + 审计），不暴露 Web 界面与 REST/WS，供 AI 客户端（MCP 客户端）直连；关闭立即停止监听。未开启时也可经当前页面地址接入（见「配置指引」）。</div>
      <div class="tc-rows">
        <div class="tc-row">
          <div class="tc-row-main">
            <div class="tc-row-label">启用直连端口</div>
          </div>
          <label class="switch"><input type="checkbox" id="tc-mcp-on" ${direct.enabled ? 'checked' : ''} /><span></span></label>
        </div>
        <div class="tc-row tc-row-field" id="tc-mcp-port-row" style="${direct.enabled ? '' : 'display:none'}">
          <div class="tc-row-main"><div class="tc-row-label">端口</div></div>
          <div class="tc-row-ctrl col">
            <input type="number" id="tc-mcp-port" class="pref-input tc-port-input" min="1" max="65535" value="${defaultPort}" />
            <span class="tc-row-desc" id="tc-mcp-hint">${direct.running ? `当前监听 ${direct.bind ?? '0.0.0.0'}:${direct.port}` : '保存后开始监听'}</span>
          </div>
        </div>
        <div class="tc-row tc-row-field">
          <div class="tc-row-main"><div class="tc-row-label">自定义地址</div></div>
          <div class="tc-row-ctrl col">
            <input type="text" id="tc-mcp-custom" class="pref-input tc-custom-input" placeholder="https://example.com/mcp（留空使用直连端口）" value="${escapeHtml(direct.customEndpoint ?? '')}" spellcheck="false" />
            <span class="tc-row-desc">反向代理场景填写（如 <code>https://example.com/mcp</code>），保存后接入端点以该地址为准，优先级最高</span>
          </div>
        </div>
      </div>
      <div class="tc-card-foot">
        <span class="tc-dirty-note" id="tc-direct-msg" hidden>有未保存的修改</span>
        <button class="btn primary" id="tc-mcp-save" disabled>保存</button>
      </div>
    </div>`;

  const onEl = el.querySelector('#tc-mcp-on');
  const portRow = el.querySelector('#tc-mcp-port-row');
  const portEl = el.querySelector('#tc-mcp-port');
  const hintEl = el.querySelector('#tc-mcp-hint');
  const customEl = el.querySelector('#tc-mcp-custom');
  const saveBtn = el.querySelector('#tc-mcp-save');
  const msgEl = el.querySelector('#tc-direct-msg');
  const stateTag = el.querySelector('#tc-direct-state');

  const snapshot = () => ({
    enabled: onEl.checked,
    port: Number(portEl.value),
    custom: customEl.value.trim(),
  });
  let saved = snapshot();

  const portValid = () => {
    const p = Number(portEl.value);
    return Number.isInteger(p) && p >= 1 && p <= 65535;
  };

  const refresh = () => {
    portRow.style.display = onEl.checked ? '' : 'none';
    const ok = !onEl.checked || portValid();
    portEl.classList.toggle('tc-input-error', !ok);
    const isDirty = ok && JSON.stringify(snapshot()) !== JSON.stringify(saved);
    saveBtn.disabled = !isDirty;
    msgEl.hidden = !isDirty;
    msgEl.textContent = '有未保存的修改';
    msgEl.classList.remove('tc-error');
  };
  [onEl, portEl, customEl].forEach((i) =>
    ['change', 'input'].forEach((ev) => i.addEventListener(ev, refresh))
  );

  const save = async () => {
    if (!portValid()) {
      msgEl.hidden = false;
      msgEl.textContent = '端口必须为 1–65535 的整数';
      msgEl.classList.add('tc-error');
      portEl.focus();
      return;
    }
    const payload = snapshot();
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    try {
      const res = await fetch(apiUrl('mcp-direct'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: payload.enabled, port: payload.port, customEndpoint: payload.custom }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        msgEl.hidden = false;
        msgEl.textContent = body?.error?.message ?? `保存失败（${res.status}）`;
        msgEl.classList.add('tc-error');
        showToast('保存失败', 'err');
      } else {
        // 用服务端返回的权威状态回填（含运行标记）
        Object.assign(direct, body);
        onEl.checked = body.enabled;
        portEl.value = body.port ?? 8422;
        customEl.value = body.customEndpoint ?? '';
        saved = snapshot();
        stateTag.textContent = body.running ? '运行中' : '未启用';
        stateTag.className = `tag ${body.running ? 'ok' : ''}`;
        hintEl.textContent = body.running
          ? `当前监听 ${body.bind ?? '0.0.0.0'}:${body.port}`
          : '保存后开始监听';
        if (body.saved === false) {
          showToast('端口已生效，但配置文件保存失败，重启后可能回退', 'err');
        } else {
          showToast(body.running ? `直连端口已监听 ${body.bind ?? '0.0.0.0'}:${body.port}` : '直连端口已停止监听');
        }
      }
    } catch (e) {
      msgEl.hidden = false;
      msgEl.textContent = `网络错误：${e.message}`;
      msgEl.classList.add('tc-error');
      showToast('网络错误', 'err');
    } finally {
      saveBtn.textContent = '保存';
      refresh();
    }
  };
  saveBtn.addEventListener('click', save);
  [portEl, customEl].forEach((i) =>
    i.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!saveBtn.disabled) save();
      }
    })
  );
}

/** 权限策略页（设置 → 权限策略）：全局默认目录矩阵 + 系统敏感路径（独立页签） */
export async function renderPermPolicy(el) {
  el.innerHTML = '<div class="placeholder-box">加载中…</div>';
  let d = null;
  try {
    const res = await fetch(apiUrl('tokens/defaults'));
    if (res.ok) d = await res.json();
  } catch {
    /* 网络异常 */
  }
  if (!d) {
    el.innerHTML = '<div class="placeholder-box">加载失败，请稍后重试。</div>';
    return;
  }
  const perms = d.defaultPermissions ?? [];
  const sensitive = d.sensitivePaths ?? [];

  el.innerHTML = `
    <div class="audit-toolbar">
      <span style="font-size:12px;color:var(--text-faint)">由管理员在配置文件维护（defaultPermissions / sensitivePaths），修改后重启生效；新令牌以默认矩阵初始化且只能收紧</span>
    </div>

    <div class="tc-title">全局默认目录矩阵 <span class="tag">${perms.length} 条</span></div>
    ${
      perms.length
        ? `<div class="audit-list">${perms
            .map(
              (p) => `<div class="audit-row">
                <span class="tc-mono">${escapeHtml(p.prefix)}</span>
                <span class="audit-detail">${p.source === 'global-default' ? '全局默认' : ''}</span>
                <span>${(p.allow ?? [])
                  .map((a) => `<span class="tag ok">${PERM_LABEL[a] ?? a}</span>`)
                  .join(' ')}</span>
              </div>`
            )
            .join('')}</div>`
        : '<div class="placeholder-box">未配置默认矩阵（令牌将没有任何路径权限，需在配置文件中设置 defaultPermissions）。</div>'
    }

    <div class="tc-title">系统敏感路径 <span class="tag danger">${sensitive.length} 条</span></div>
    ${
      sensitive.length
        ? `<div class="audit-list">${sensitive
            .map(
              (p) => `<div class="audit-row">
                <span class="tc-mono">${escapeHtml(p)}</span>
                <span class="audit-detail">恒定拒绝，任何令牌级别与目录矩阵均不可放行</span>
                <span class="tag danger">拒绝</span>
              </div>`
            )
            .join('')}</div>`
        : '<div class="placeholder-box">未配置（建议在配置文件 security.sensitivePaths 中维护）。</div>'
    }`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

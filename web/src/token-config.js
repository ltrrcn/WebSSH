// 令牌配置页（设置 → 令牌配置）：MCP 接入（按客户端预设单选）+ 机器直连端口开关 + 全局默认目录矩阵 + 敏感路径
// 数据源 GET /api/tokens/defaults、GET /api/mcp-direct；结构与审计/令牌页一致（audit-toolbar / audit-list / audit-row）
// 全局默认矩阵由管理员在配置文件维护，页面只读展示（FR-040：令牌只能收紧）
import { apiUrl } from './base.js';
import { icon } from './icons.js';

const PERM_LABEL = { read: '读', write: '写', modify: '修改' };

/** MCP 客户端接入预设：单选切换，展示对应客户端的配置方法（端点/令牌动态填入） */
const CLIENT_PRESETS = [
  {
    id: 'workbuddy',
    label: 'Workbuddy 配置',
    note: '在 Workbuddy 的 MCP 服务器设置中粘贴以下 JSON（或按相同字段填写）。',
    lang: 'json',
    build: (ep) =>
      JSON.stringify(
        {
          mcpServers: {
            webssh: {
              type: 'http',
              url: ep,
              headers: { Authorization: 'Bearer <令牌明文>' },
            },
          },
        },
        null,
        2
      ),
  },
  {
    id: 'codex',
    label: 'Codex 配置',
    note: '编辑 ~/.codex/config.toml，追加以下配置（需较新版本 Codex，已默认启用 streamable HTTP MCP）。',
    lang: 'toml',
    build: (ep) => {
      const m = /^(\w+:\/\/)([^/]+)(.*)$/.exec(ep);
      const url = m ? `${m[1]}<主机地址>${m[3]}` : ep;
      return [
        '[mcp_servers.webssh]',
        `url = "${url}"`,
        'bearer_token = "<令牌明文>"',
      ].join('\n');
    },
  },
  {
    id: 'other',
    label: '其他 AI 工具',
    note: '适用于 Claude Desktop、Cursor、Cline 等支持远程 MCP（Streamable HTTP）的客户端：服务器 URL 填端点，鉴权头填 Bearer 令牌。',
    lang: 'json',
    build: (ep) =>
      JSON.stringify(
        {
          mcpServers: {
            webssh: {
              type: 'http',
              url: ep,
              headers: { Authorization: 'Bearer <令牌明文>' },
            },
          },
        },
        null,
        2
      ),
  },
];

const PRESET_KEY = 'webssh-mcp-preset';

export async function renderTokenConfig(el) {
  await load(el);
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
      <button class="btn" id="pp-refresh">刷新</button>
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
  el.querySelector('#pp-refresh').addEventListener('click', () => renderPermPolicy(el));
}

async function load(el) {
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

  // 机器直连端口开关（双模式通用）：AI 客户端不持有登录态（fnOS 网关）/主服务回环绑定（standalone），经此端口接入
  const isFnos = direct?.mode === 'fnos';
  const directSection = direct
    ? `
    <div class="tc-title">机器直连端口 <span class="tag ${direct.running ? 'ok' : ''}">${direct.running ? '运行中' : '未启用'}</span></div>
    <div class="audit-list">
      <div class="audit-row" style="flex-wrap:wrap">
        <span class="audit-event" style="min-width:72px">启用</span>
        <span class="audit-detail" style="flex:1">开启后监听独立 TCP 端口（默认 0.0.0.0），仅提供 /mcp（令牌鉴权 + 限流 + 审计），不暴露 Web 界面与 REST/WS，供 AI 工具（MCP 客户端）直连；关闭立即停止监听</span>
        <label class="switch"><input type="checkbox" id="tc-mcp-on" ${direct.enabled ? 'checked' : ''} /><span></span></label>
      </div>
      <div class="audit-row" id="tc-mcp-port-row" style="${direct.enabled ? '' : 'display:none'}">
        <span class="audit-event" style="min-width:72px">端口</span>
        <span class="pref-inline" style="flex:1">
          <input type="number" id="tc-mcp-port" class="pref-input" style="width:100px" min="1" max="65535" value="${direct.port ?? 8422}" />
          <span class="pref-desc" id="tc-mcp-hint">${direct.running ? `当前监听 ${direct.bind ?? '0.0.0.0'}:${direct.port}` : '保存后开始监听'}</span>
        </span>
        <button class="btn primary" id="tc-mcp-save">保存</button>
      </div>
      <div class="audit-row" style="flex-wrap:wrap">
        <span class="audit-event" style="min-width:72px">自定义地址</span>
        <span class="pref-inline" style="flex:1;min-width:240px">
          <input type="text" id="tc-mcp-custom" class="pref-input" style="flex:1" placeholder="https://example.com/mcp（反向代理地址）" value="${escapeHtml(direct.customEndpoint ?? '')}" />
        </span>
        <button class="btn primary" id="tc-mcp-custom-save">保存</button>
      </div>
    </div>
    <p class="form-note" style="margin-top:8px">提示：直连端口为 HTTP 明文（内网可用），客户端配置 <code>http://&lt;${isFnos ? 'NAS IP' : '主机 IP'}&gt;:${direct.port ?? 8422}/mcp</code> + Bearer 令牌。若配置了自定义 MCP 地址（反向代理），接入配置将以该地址为准。</p>`
    : '';

  // MCP 接入端点优先级：自定义地址（反代）> 直连端口 > 当前页面 origin
  const mcpEndpoint = direct?.customEndpoint
    ? direct.customEndpoint
    : direct?.enabled
      ? `http://<${isFnos ? 'NAS IP' : '主机 IP'}>:${direct.port ?? 8422}/mcp`
      : `${location.origin}/mcp`;

  el.innerHTML = `
    <div class="audit-toolbar">
      <span style="font-size:12px;color:var(--text-faint)">新令牌以全局默认矩阵初始化，创建时只能收紧；修改默认需编辑配置文件后重启</span>
      <button class="btn" id="tc-refresh">刷新</button>
    </div>

    ${directSection}

    <div class="tc-title">MCP 接入</div>
    <div class="mcp-preset-row">
      ${CLIENT_PRESETS.map(
        (p) => `<button type="button" class="mcp-preset" data-preset="${p.id}">${escapeHtml(p.label)}</button>`
      ).join('')}
    </div>
    <div class="audit-list" id="mcp-preset-panel"></div>
    <div class="audit-list" style="margin-top:8px">
      <div class="audit-row"><span class="audit-event">认证方式</span><span class="tc-mono">Authorization: Bearer &lt;令牌明文&gt;</span></div>
      <div class="audit-row"><span class="audit-event">限流</span><span class="audit-detail">每令牌 ${rate} 次/分钟，超额返回 rate_limited，不影响其他令牌与人工会话</span></div>
      <div class="audit-row"><span class="audit-event">命令超时</span><span class="audit-detail">${execSec} 秒，超时强制终止并返回已产生的输出摘要</span></div>
    </div>`;

  el.querySelector('#tc-refresh').addEventListener('click', () => load(el));

  // —— MCP 客户端预设单选：切换展示对应配置（选中项持久化到 localStorage）——
  const presetBtns = el.querySelectorAll('.mcp-preset');
  const presetPanel = el.querySelector('#mcp-preset-panel');
  const savedPreset = localStorage.getItem(PRESET_KEY);
  let activePreset = CLIENT_PRESETS.some((p) => p.id === savedPreset) ? savedPreset : CLIENT_PRESETS[0].id;

  const renderPreset = () => {
    const p = CLIENT_PRESETS.find((x) => x.id === activePreset);
    presetBtns.forEach((b) => b.classList.toggle('selected', b.dataset.preset === activePreset));
    const conf = p.build(mcpEndpoint);
    presetPanel.innerHTML = `
      <div class="audit-row" style="flex-direction:column;align-items:stretch;gap:8px">
        <div class="pref-row" style="justify-content:space-between;align-items:center">
          <span class="pref-desc" style="flex:1">${escapeHtml(p.note)}</span>
          <button class="btn" id="mcp-conf-copy">复制配置</button>
        </div>
        <pre class="mcp-conf">${escapeHtml(conf)}</pre>
        <div class="pref-desc">端点：<code>${escapeHtml(mcpEndpoint)}</code>　令牌明文在「令牌管理」创建令牌时一次性显示，请先创建再填入。</div>
      </div>`;
    presetPanel.querySelector('#mcp-conf-copy').addEventListener('click', () => {
      navigator.clipboard?.writeText(conf).then(() => {
        const b = presetPanel.querySelector('#mcp-conf-copy');
        b.textContent = '已复制';
        setTimeout(() => (b.textContent = '复制配置'), 1200);
      });
    });
  };
  presetBtns.forEach((b) =>
    b.addEventListener('click', () => {
      activePreset = b.dataset.preset;
      localStorage.setItem(PRESET_KEY, activePreset);
      renderPreset();
    })
  );
  renderPreset();

  if (direct) {
    const onEl = el.querySelector('#tc-mcp-on');
    const portRow = el.querySelector('#tc-mcp-port-row');
    const portEl = el.querySelector('#tc-mcp-port');
    const hintEl = el.querySelector('#tc-mcp-hint');
    const saveBtn = el.querySelector('#tc-mcp-save');
    onEl.addEventListener('change', () => {
      portRow.style.display = onEl.checked ? '' : 'none';
    });
    const save = async () => {
      const port = Number(portEl.value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        alert('端口必须为 1–65535 的整数');
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = '保存中…';
      try {
        const res = await fetch(apiUrl('mcp-direct'), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: onEl.checked, port, customEndpoint: el.querySelector('#tc-mcp-custom')?.value ?? '' }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          alert(body?.error?.message ?? `保存失败（${res.status}）`);
        } else if (body.saved === false) {
          alert('端口已生效，但配置文件保存失败（详见服务端日志），重启后可能回退');
        }
        await load(el); // 重新拉取状态（含运行中标记）
      } catch (e) {
        alert(`网络错误：${e.message}`);
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = '保存';
      }
    };
    saveBtn.addEventListener('click', save);
    portEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
    });
    void hintEl;

    // 自定义 MCP 地址（反代）独立保存：只更新端点，不触碰端口开关状态
    const customBtn = el.querySelector('#tc-mcp-custom-save');
    const customEl = el.querySelector('#tc-mcp-custom');
    const saveCustom = async () => {
      const v = customEl.value.trim();
      if (v && !/^https?:\/\/.+/.test(v)) {
        return alert('自定义地址必须以 http:// 或 https:// 开头');
      }
      customBtn.disabled = true;
      customBtn.textContent = '保存中…';
      try {
        const res = await fetch(apiUrl('mcp-direct'), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: onEl.checked, customEndpoint: v }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          alert(body?.error?.message ?? `保存失败（${res.status}）`);
        } else {
          await load(el); // 重渲：MCP 接入预设端点立即切换为自定义地址
        }
      } catch (e) {
        alert(`网络错误：${e.message}`);
      } finally {
        customBtn.disabled = false;
        customBtn.textContent = '保存';
      }
    };
    customBtn.addEventListener('click', saveCustom);
    customEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveCustom();
    });
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

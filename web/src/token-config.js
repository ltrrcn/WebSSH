// 令牌配置页（设置 → 令牌配置）：MCP 接入信息 + 机器直连端口开关 + 全局默认目录矩阵 + 敏感路径
// 数据源 GET /api/tokens/defaults、GET /api/mcp-direct；结构与审计/令牌页一致（audit-toolbar / audit-list / audit-row）
// 全局默认矩阵由管理员在配置文件维护，页面只读展示（FR-040：令牌只能收紧）
import { apiUrl } from './base.js';

const PERM_LABEL = { read: '读', write: '写', modify: '修改' };

export async function renderTokenConfig(el) {
  await load(el);
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

  const endpoint = `${location.origin}/mcp`;
  const perms = d.defaultPermissions ?? [];
  const sensitive = d.sensitivePaths ?? [];
  const rate = d.limits?.tokenRateLimitPerMinute ?? 60;
  const execSec = Math.round((d.limits?.execTimeoutMs ?? 60000) / 1000);

  // fnOS 模式：显示机器直连端口开关（AI 客户端不持有 fnOS 登录态，无法过网关）
  const isFnos = direct?.mode === 'fnos';
  const directSection = isFnos
    ? `
    <div class="tc-title">机器直连端口 <span class="tag ${direct.running ? 'ok' : ''}">${direct.running ? '运行中' : '未启用'}</span></div>
    <div class="audit-list">
      <div class="audit-row" style="flex-wrap:wrap">
        <span class="audit-event" style="min-width:72px">启用</span>
        <span class="audit-detail" style="flex:1">开启后本机监听独立 TCP 端口，仅提供 /mcp（令牌鉴权），不经过 fnOS 网关，供 AI 工具（MCP 客户端）直连；关闭立即停止监听</span>
        <label class="switch"><input type="checkbox" id="tc-mcp-on" ${direct.enabled ? 'checked' : ''} /><span></span></label>
      </div>
      <div class="audit-row" id="tc-mcp-port-row" style="${direct.enabled ? '' : 'display:none'}">
        <span class="audit-event" style="min-width:72px">端口</span>
        <span class="pref-inline" style="flex:1">
          <input type="number" id="tc-mcp-port" class="pref-input" style="width:100px" min="1" max="65535" value="${direct.port ?? 8422}" />
          <span class="pref-desc" id="tc-mcp-hint">${direct.running ? `当前监听 0.0.0.0:${direct.port}` : '保存后开始监听'}</span>
        </span>
        <button class="btn primary" id="tc-mcp-save">保存</button>
      </div>
    </div>
    <p class="form-note" style="margin-top:8px">提示：直连端口为 HTTP 明文（内网可用），客户端配置 <code>http://&lt;NAS IP&gt;:${direct.port ?? 8422}/mcp</code> + Bearer 令牌。</p>`
    : '';

  el.innerHTML = `
    <div class="audit-toolbar">
      <span style="font-size:12px;color:var(--text-faint)">新令牌以全局默认矩阵初始化，创建时只能收紧；修改默认需编辑配置文件后重启</span>
      <button class="btn" id="tc-refresh">刷新</button>
    </div>

    <div class="tc-title">MCP 接入</div>
    <div class="audit-list">
      <div class="audit-row"><span class="audit-event">端点</span><span class="tc-mono">${escapeHtml(endpoint)}</span></div>
      <div class="audit-row"><span class="audit-event">认证</span><span class="tc-mono">Authorization: Bearer &lt;令牌明文&gt;</span></div>
      <div class="audit-row"><span class="audit-event">限流</span><span class="audit-detail">每令牌 ${rate} 次/分钟，超额返回 rate_limited，不影响其他令牌与人工会话</span></div>
      <div class="audit-row"><span class="audit-event">命令超时</span><span class="audit-detail">${execSec} 秒，超时强制终止并返回已产生的输出摘要</span></div>
    </div>

    ${directSection}

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

  el.querySelector('#tc-refresh').addEventListener('click', () => load(el));

  if (isFnos) {
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
          body: JSON.stringify({ enabled: onEl.checked, port }),
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
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

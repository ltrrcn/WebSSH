// 令牌配置页（设置 → 令牌配置）：MCP 接入信息 + 全局默认目录矩阵 + 敏感路径 + 限制参数
// 数据源 GET /api/tokens/defaults；全局默认矩阵由管理员在配置文件维护，页面只读展示（FR-040：令牌只能收紧）
import { apiUrl } from './base.js';

const PERM_LABEL = { read: '读', write: '写', modify: '修改' };

export async function renderTokenConfig(el) {
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

  const endpoint = `${location.origin}/mcp`;
  const perms = d.defaultPermissions ?? [];
  const sensitive = d.sensitivePaths ?? [];

  el.innerHTML = `
    <div class="tc-section">
      <h4>MCP 接入</h4>
      <div class="tc-kv"><span class="tc-k">端点</span><code class="tc-v">${escapeHtml(endpoint)}</code></div>
      <div class="tc-kv"><span class="tc-k">认证</span><code class="tc-v">Authorization: Bearer &lt;令牌明文&gt;</code></div>
      <div class="tc-kv"><span class="tc-k">限流</span><span class="tc-v">每令牌 ${d.limits?.tokenRateLimitPerMinute ?? 60} 次/分钟</span></div>
      <div class="tc-kv"><span class="tc-k">命令超时</span><span class="tc-v">${Math.round((d.limits?.execTimeoutMs ?? 60000) / 1000)} 秒（超时强制终止并返回已产生摘要）</span></div>
      <p class="form-note">在「令牌」页创建令牌后，将端点与令牌明文填入 AI 工具的 MCP 服务器配置（transport 类型选 streamable-http / URL）。</p>
    </div>

    <div class="tc-section">
      <h4>全局默认目录矩阵 <span class="tag">${perms.length} 条</span></h4>
      <p class="form-note">新令牌以此矩阵初始化，创建时只能收紧（缩小前缀或减少权限），不得放开。修改默认矩阵：编辑配置文件中 <code>defaultPermissions</code> 后重启服务。</p>
      ${
        perms.length
          ? `<div class="tc-matrix">${perms
              .map(
                (p) => `<div class="tc-matrix-row">
                  <code>${escapeHtml(p.prefix)}</code>
                  <span class="tc-perms">${(p.allow ?? [])
                    .map((a) => `<span class="tag ok">${PERM_LABEL[a] ?? a}</span>`)
                    .join('')}</span>
                </div>`
              )
              .join('')}</div>`
          : '<div class="placeholder-box">未配置默认矩阵（令牌将没有任何路径权限，需在配置文件中设置 defaultPermissions）。</div>'
      }
    </div>

    <div class="tc-section">
      <h4>系统敏感路径 <span class="tag danger">${sensitive.length} 条</span></h4>
      <p class="form-note">以下路径对令牌恒定拒绝，任何级别与矩阵均不可放行。</p>
      ${
        sensitive.length
          ? `<div class="tc-sensitive">${sensitive.map((p) => `<code>${escapeHtml(p)}</code>`).join('')}</div>`
          : '<div class="placeholder-box">未配置（建议在配置文件 security.sensitivePaths 中维护）。</div>'
      }
    </div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

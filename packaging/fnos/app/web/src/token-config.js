// 令牌配置页（设置 → 令牌配置）：MCP 接入信息 + 全局默认目录矩阵 + 敏感路径
// 数据源 GET /api/tokens/defaults；结构与审计/令牌页一致（audit-toolbar / audit-list / audit-row）
// 全局默认矩阵由管理员在配置文件维护，页面只读展示（FR-040：令牌只能收紧）
import { apiUrl } from './base.js';

const PERM_LABEL = { read: '读', write: '写', modify: '修改' };

export async function renderTokenConfig(el) {
  await load(el);
}

async function load(el) {
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
  const rate = d.limits?.tokenRateLimitPerMinute ?? 60;
  const execSec = Math.round((d.limits?.execTimeoutMs ?? 60000) / 1000);

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
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

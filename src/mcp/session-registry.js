// MCP 会话粘性注册表（服务端归组辅助）：
// Streamable HTTP 规范下会话 ID 由 initialize 经响应头返回、客户端后续经
// Mcp-Session-Id 请求头回传。但部分 AI 客户端（经自身代理转发）不透传该头，
// 其命令会全部落入审计的「MCP 令牌调用（无会话）」组。
// 注册表按令牌维护「当前活跃会话」，使归组不依赖客户端配合：
//   - initialize 建新会话 → 绑定为该令牌的当前会话
//   - 带有效会话头的调用 → 尊重客户端回传，并刷新为当前会话
//   - 无头/非法头调用 → 归入该令牌的当前活跃会话；静默超过窗口视为会话结束，下次调用开新会话
// 内存态：重启即清空（MCP 会话本就无状态，仅影响归组连续性，不影响功能）。
import { randomUUID } from 'node:crypto';

/** MCP 会话 ID：m_ 前缀 + 12 位 hex（与用户终端会话 s_ 前缀区分） */
export function newMcpSessionId() {
  return `m_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

const DEFAULT_WINDOW_MS = 30 * 60 * 1000;

/**
 * 创建注册表。
 * @param {{getWindowMs?: () => number}} [opts] 静默窗口（0 = 关闭粘性，维持「无头即无会话」原语义）
 */
export function createSessionRegistry(opts = {}) {
  const active = new Map(); // tokenId -> { sid, lastSeen }

  const windowMs = () => {
    const v = typeof opts.getWindowMs === 'function' ? Number(opts.getWindowMs()) : DEFAULT_WINDOW_MS;
    return Number.isFinite(v) && v >= 0 ? v : DEFAULT_WINDOW_MS;
  };

  /**
   * 解析本次调用归属的会话 ID。
   * @param {string} tokenId 令牌 ID（粘性维度：每令牌一个当前会话）
   * @param {string|null} clientSessionId 请求头中经校验的会话 ID（无/非法 → null）
   * @returns {string|null} 归档用会话 ID（关闭粘性且无头 → null）
   */
  function resolve(tokenId, clientSessionId, now = Date.now()) {
    if (windowMs() === 0) return clientSessionId ?? null;
    if (clientSessionId) {
      active.set(tokenId, { sid: clientSessionId, lastSeen: now });
      return clientSessionId;
    }
    const cur = active.get(tokenId);
    if (cur && now - cur.lastSeen < windowMs()) {
      cur.lastSeen = now;
      return cur.sid;
    }
    const sid = newMcpSessionId();
    active.set(tokenId, { sid, lastSeen: now });
    return sid;
  }

  /** initialize 生成新会话后绑定（该令牌的后续无头调用归入此会话） */
  function bind(tokenId, sid, now = Date.now()) {
    active.set(tokenId, { sid, lastSeen: now });
  }

  /** 客户端主动结束会话（DELETE /mcp）：解除粘性，下次调用开新会话 */
  function end(tokenId) {
    active.delete(tokenId);
  }

  return { resolve, bind, end, size: () => active.size };
}

// 按令牌维度的窗口限流（FR-028）：窗口内请求数超限即拒绝，互不影响其他令牌与人工会话
const buckets = new Map(); // tokenId -> {count, windowStart}

export function checkRateLimit(tokenId, limitPerMinute, now = Date.now()) {
  if (!Number.isFinite(limitPerMinute) || limitPerMinute <= 0) return true;
  const WINDOW = 60 * 1000;
  let b = buckets.get(tokenId);
  if (!b || now - b.windowStart >= WINDOW) {
    b = { count: 0, windowStart: now };
    buckets.set(tokenId, b);
  }
  b.count += 1;
  if (b.count > limitPerMinute) return false;
  return true;
}

/** 测试辅助：清空限流状态 */
export function resetRateLimit() {
  buckets.clear();
}

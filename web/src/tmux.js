// tmux 会话模式（R001）：纯逻辑模块，无 DOM 依赖，可被 node --test 直接单测
// 设计：连接后先静默探测远端 tmux 是否可用，可用则自动 attach 保活会话。
// 探测命令与 attach 命令均以普通键盘输入发送（DATA 帧），服务端零感知、审计天然留痕。

/** 默认 tmux 会话名：同一主机所有 tmux 模式标签 attach 同一会话，实现屏幕同步 */
export const DEFAULT_TMUX_SESSION = 'webssh';

/**
 * 净化 tmux 会话名：tmux 会话名语法不允许 `:` 与 `.`（与 target 语法冲突），
 * 空格会使命令行拆分。白名单 [a-zA-Z0-9_-]，净化后为空则回退默认名。
 */
export function sanitizeTmuxSessionName(name) {
  const cleaned = String(name ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
  return cleaned || DEFAULT_TMUX_SESSION;
}

/** 探测命令：`tmux -V` 输出版本号；回显行是命令本身（不含数字版本），不会误判 */
export function buildTmuxProbeCommand() {
  return 'tmux -V';
}

/** 进入/复用会话命令：存在则 attach，不存在则创建（-A） */
export function buildTmuxAttachCommand(sessionName) {
  return `tmux new -A -s ${sanitizeTmuxSessionName(sessionName)}`;
}

/**
 * 探测输出状态机：跨 chunk 喂入终端输出，判定远端 tmux 可用性。
 * @returns {function(string): null | 'found' | 'missing'} feed 函数
 *   - 'found'：输出版本号（如 `tmux 3.3a`）
 *   - 'missing'：shell 报 command not found（含中英文常见文案）
 *   - null：尚无结论（输出可能分片到达）
 */
export function createTmuxDetector() {
  let buf = '';
  return function feed(chunk) {
    buf += chunk;
    // 版本输出形如 "tmux 3.3a" / "tmux next-3.4"；命令回显 "tmux -V" 的 - 不匹配 \d，安全。
    // 不用 \b：截断窗口可能把分隔符切掉导致 "xxxxtmux 3" 紧贴（漏判仅走 4s 超时兜底，误判无害）
    if (/tmux\s+\d[\w.]*/.test(buf)) return 'found';
    if (/not found|not installed|command not found|未找到命令|命令未找到|无法识别/i.test(buf)) {
      return 'missing';
    }
    // 防膨胀：只保留尾部窗口（结论标记不会超过 1KB）
    if (buf.length > 4096) buf = buf.slice(-1024);
    return null;
  };
}

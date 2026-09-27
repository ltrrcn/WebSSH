// 路径与命令安全策略（FR-030 ~ FR-040）
// 本文件在 Phase 2 只实现【路径判定】部分；命令三层判定在 US6（T078）补全。

/**
 * 规范化请求路径；含任何 `..` 向上穿越语法即拒绝（Edge Case：不按拼接后的字面路径判定）。
 * @returns {string|null} 规范化后的绝对路径；非法返回 null
 */
export function normalizeRequestPath(input) {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) return null;
  const segments = input.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.includes('..')) return null;
  if (segments.length === 0) return '/';
  return `/${segments.join('/')}`;
}

/** 敏感路径条目匹配：支持单层通配（如「/home/任意段/.ssh」）。条目覆盖其自身及全部子路径。 */
function compileSensitivePattern(entry) {
  const escaped = entry
    .split('*')
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+');
  return new RegExp(`^${escaped}(/.*)?$`);
}

/**
 * 路径访问判定（data-model「判定优先级」）：
 *   1. 系统敏感路径清单 → 恒定拒绝（真实路径优先）
 *   2. 目录矩阵最长前缀匹配 → 该条目的权限位
 *   3. 未覆盖 → 默认拒绝
 * 系统级非敏感路径的「默认可读可修改」由全局默认矩阵条目表达（FR-038）。
 *
 * @param {string} rawPath 请求路径（可能来自外部，不可信）
 * @param {{sensitivePaths: string[], matrix: Array<{prefix:string, read?:boolean, write?:boolean, download?:boolean, modify?:boolean}>}} ctx
 * @param {'read'|'write'|'download'|'modify'} op
 * @param {{realPath?: string}} [opts] 调用方解析出的真实路径（符号链接复核，FR-039）
 * @returns {{allowed: boolean, reason: 'ok'|'invalid-path'|'sensitive-path'|'not-covered'|'denied-by-matrix'}}
 */
export function checkPathAccess(rawPath, ctx, op, opts = {}) {
  const normalized = normalizeRequestPath(rawPath);
  if (!normalized && !opts.realPath) return { allowed: false, reason: 'invalid-path' };

  const sensitivePatterns = (ctx?.sensitivePaths ?? []).map(compileSensitivePattern);
  // 真实路径优先于字面路径判定（FR-039）
  for (const p of [opts.realPath, normalized]) {
    if (!p) continue;
    if (sensitivePatterns.some((re) => re.test(p))) {
      return { allowed: false, reason: 'sensitive-path' };
    }
  }
  if (!normalized) return { allowed: false, reason: 'invalid-path' };

  // 矩阵判定同样以真实路径为准（FR-039：符号链接按解析后的真实路径判定）
  const judgePath = opts.realPath ?? normalized;

  // 最长前缀匹配（可表达「父目录宽、子目录严」的收紧关系，research R13）
  let best = null;
  for (const entry of ctx?.matrix ?? []) {
    const prefix = entry.prefix?.endsWith('/') ? entry.prefix.slice(0, -1) : entry.prefix;
    if (!prefix) continue;
    if (judgePath === prefix || judgePath.startsWith(`${prefix}/`)) {
      if (!best || prefix.length > best.prefix.length) best = entry;
    }
  }
  if (!best) return { allowed: false, reason: 'not-covered' };
  if (best[op] === true) return { allowed: true, reason: 'ok' };
  return { allowed: false, reason: 'denied-by-matrix' };
}

/** 目录矩阵条目校验：token-override 条目只能在全局默认范围内收紧（FR-040） */
export function assertMatrixTightened(matrix, globalDefaults) {
  for (const entry of matrix) {
    if (entry.source !== 'token-override') continue;
    const g = (globalDefaults ?? []).find((d) => d.prefix === entry.prefix);
    if (!g) {
      throw Object.assign(
        new Error(`权限条目 ${entry.prefix} 不存在于全局默认矩阵，不得新增范围`),
        { code: 'permission_out_of_range' }
      );
    }
    for (const op of ['read', 'write', 'download', 'modify']) {
      if (entry[op] === true && g[op] !== true) {
        throw Object.assign(
          new Error(`权限条目 ${entry.prefix} 的 ${op} 超出全局默认范围，只能收紧`),
          { code: 'permission_out_of_range' }
        );
      }
    }
  }
}

/**
 * 命令三层判定（FR-030~034，mcp-tools.md 契约）：
 *   1. 语法预检：拼接/重定向语法（; | & < > ` $()）一律拒绝，不拆分放行（FR-034）
 *   2. 只读命令白名单：readonly 级别仅允许白名单内首个词，默认拒绝（FR-032）
 *   3. 危险命令黑名单：任何级别命中即拒绝（FR-033）
 * 能力隔离（第一层：readonly 不注册命令工具）由工具注册矩阵承担。
 *
 * @param {string} command 命令原文
 * @param {{readOnlyCommands?: string[], dangerousCommands?: string[]}} rules
 * @param {{level?: 'readonly'|'writable'}} [opts]
 * @returns {{allowed: boolean, reason: 'ok'|'syntax_rejected'|'not_in_readonly_whitelist'|'dangerous_command'}}
 */
export function checkCommand(command, rules = {}, opts = {}) {
  const cmd = String(command ?? '');
  if (cmd.length === 0 || cmd.length > 4096) {
    return { allowed: false, reason: 'syntax_rejected' };
  }
  // 第一层：语法预检（&& || 由 & | 覆盖）
  if (/[;|&<>`]|\$\(/.test(cmd)) {
    return { allowed: false, reason: 'syntax_rejected' };
  }
  const first = cmd.trim().split(/\s+/)[0] ?? '';
  // 第二层：只读白名单（仅 readonly 级别参与）
  if (opts.level === 'readonly' && !(rules.readOnlyCommands ?? []).includes(first)) {
    return { allowed: false, reason: 'not_in_readonly_whitelist' };
  }
  // 第三层：危险黑名单（任何级别不放行）
  if ((rules.dangerousCommands ?? []).includes(first)) {
    return { allowed: false, reason: 'dangerous_command' };
  }
  return { allowed: true, reason: 'ok' };
}

// 审计脱敏（FR-042 / SC-021）：检出疑似凭据与私钥内容即以占位符替换，其余内容保留
// research R7：命令原文与输出摘要写入审计前必须过本模块。

// PEM 私钥块（OPENSSH / RSA / EC / ENCRYPTED / PRIVATE KEY 等头）
const PEM_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

// 口令赋值形式：password= / passwd= / pass: / pw: / secret= 等（含 URI/配置风格）
const PASSWORD_ASSIGN = /\b(pass(word)?|passwd|pw|secret)\s*[=:]\s*\S+/gi;

/**
 * 对文本执行脱敏。
 * @param {string} text 命令原文或输出内容
 * @returns {string} 脱敏后的文本
 */
export function redact(text) {
  return String(text)
    .replace(PEM_BLOCK, '[REDACTED PRIVATE KEY]')
    .replace(PASSWORD_ASSIGN, '[REDACTED CREDENTIAL]');
}

/** 判断文本是否包含会被脱敏的内容（用于审计事件 redacted 标记） */
export function needsRedaction(text) {
  return redact(text) !== String(text);
}

/**
 * 输出摘要截断（outputDigestBytes 上限，超长标记 truncated）。
 * @param {string} text
 * @param {number} maxBytes 最大字符数（契约：前若干字节）
 */
export function truncateDigest(text, maxBytes) {
  const s = String(text);
  const content = s.slice(0, maxBytes);
  return { content, truncated: s.length > maxBytes };
}

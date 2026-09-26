// 身份来源适配（宪法 I：只信部署环境注入的身份，禁止信任请求体自带用户 ID）
// fnOS：统一网关注入的 X-Trim-* Header
// standalone：应用自身登录会话（基础版最小访问控制 = 回环绑定 + 本地单用户）

const TRIM_HEADERS = {
  userId: 'x-trim-userid',
  username: 'x-trim-username',
  isAdmin: 'x-trim-isadmin',
};

/**
 * 解析请求身份。
 * @param {import('node:http').IncomingMessage} req
 * @param {{authSource: 'trim-headers' | 'app-session'}} runtime
 * @returns {{id: string, username: string|null, isAdmin: boolean} | null}
 *   fnOS 模式无 X-Trim-Userid → null（未认证）；standalone 基础版返回本地单用户。
 */
export function resolveIdentity(req, runtime) {
  if (runtime.authSource === 'trim-headers') {
    const userId = req.headers[TRIM_HEADERS.userId];
    if (!userId) return null; // 网关未注入 → 视为未认证
    return {
      id: String(userId),
      username: req.headers[TRIM_HEADERS.username]
        ? String(req.headers[TRIM_HEADERS.username])
        : null,
      isAdmin: req.headers[TRIM_HEADERS.isAdmin] === 'true',
    };
  }

  // standalone：基础版不自建用户体系（spec Assumptions）。
  // 最小访问控制 = 仅监听 127.0.0.1，本机即受信使用者。
  return { id: 'local', username: 'local', isAdmin: true };
}

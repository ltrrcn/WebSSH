// 应用配置默认值（与 contracts/storage-schema.md 的 config.json 一致）
export const DEFAULT_CONFIG = {
  version: 1,
  limits: {
    sessionsPerUser: 10,
    connectTimeoutMs: 10000,
    idleTimeoutMs: 1800000,
    // 断线保活：WS 非主动关闭（刷新/关窗口/网络掉线）后会话挂起保留的时长，超时回收
    detachedTtlMs: 600000,
    execTimeoutMs: 60000,
    tokenRateLimitPerMinute: 60,
    outputDigestBytes: 2048,
    // MCP 工具调用（run_command/read_file）的 SSH 连接空闲复用时长：
    // 同主机的连续调用复用同一条连接（单连接多通道），空闲超过该时长自动断开。
    // 0 = 关闭复用（每次调用独立建连）。默认 10s，缓解批量执行时高频建连
    // 触发对端 sshd 并发限制（MaxStartups）导致的连续 ECONNRESET。
    mcpSshIdleMs: 10000,
  },
  audit: {
    retentionDays: 30,
    maxFileBytes: 10485760,
    // 记录 Web 终端命令的输出摘要（脱敏 + 截断）。默认关闭：只记命令与元数据。
    recordTerminalOutput: false,
  },
  security: {
    allowedOrigins: [],
    sensitivePaths: ['/etc/shadow', '/root/.ssh', '/home/*/.ssh'],
    readOnlyCommands: [
      'ls', 'cat', 'head', 'tail', 'grep', 'ps', 'df', 'free', 'uname', 'whoami',
    ],
    dangerousCommands: [
      'rm', 'dd', 'mkfs', 'shutdown', 'reboot', 'halt', 'chmod', 'chown', 'userdel',
    ],
  },
  // 2FA验证（TOTP）：secret 为 AES-256-GCM 加密结构（master.key 派生），
  // recoveryCodes 仅存 SHA-256 哈希；failedAttempts/lockedUntil 为防爆破状态（持久化）。
  // recoveryAttempts：恢复入口累计失败次数（达到 RECOVERY_MAX_ATTEMPTS 触发不可逆清除，
  // 绑定/关闭成功后归零重新计）。
  twofa: {
    enabled: false,
    secret: null,
    confirmedAt: null,
    recoveryCodes: [],
    protectedActions: {
      audit: true, // 命令/操作审计查看与审计设置修改
      tokens: true, // MCP 令牌创建/撤销/删除
    },
    // 验证票据有效期（分钟，1-60）：验证通过后该时长内受保护操作免重复输码。
    // 服务端统一执行（票据存内存，浏览器无法延长），对所有终端生效。
    ticketTtlMinutes: 5,
    failedAttempts: 0,
    lockedUntil: null,
    recoveryAttempts: 0,
  },
  defaultPermissions: [
    {
      prefix: '/var/log',
      read: true,
      write: false,
      download: false,
      modify: false,
      source: 'global-default',
      systemLevel: true,
    },
  ],
  standalone: {
    bind: '127.0.0.1',
    port: 8080,
  },
  // MCP 机器直连端口（双模式通用）：独立 TCP 监听，仅服务 /mcp（Bearer 令牌鉴权
  // + 限流 + 审计），不暴露 REST/WS/静态页。主服务保持回环时，AI 客户端经此端口接入。
  mcpDirect: {
    enabled: false,
    bind: '0.0.0.0',
    port: 8422,
    // 自定义 MCP 地址（反向代理场景）：填写后 MCP 接入配置一律以该地址为准，
    // 优先级高于直连端口与当前页面 origin。空 = 不使用。
    customEndpoint: '',
  },
  fnos: {
    // 旧版键位（fnos 专属）：仍兼容读取，新配置统一写入顶层 mcpDirect
    mcpDirect: {
      enabled: false,
      bind: '0.0.0.0',
      port: 8422,
    },
  },
};

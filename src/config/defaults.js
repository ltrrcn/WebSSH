// 应用配置默认值（与 contracts/storage-schema.md 的 config.json 一致）
export const DEFAULT_CONFIG = {
  version: 1,
  limits: {
    sessionsPerUser: 10,
    connectTimeoutMs: 10000,
    idleTimeoutMs: 1800000,
    execTimeoutMs: 60000,
    tokenRateLimitPerMinute: 60,
    outputDigestBytes: 2048,
  },
  audit: {
    retentionDays: 30,
    maxFileBytes: 10485760,
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
  fnos: {
    // MCP 机器直连端口：绕过统一网关（网关要求 fnOS 登录态，AI 客户端无法持有）。
    // 仅服务 /mcp（Bearer 令牌鉴权 + 限流 + 审计），不暴露 REST/WS/静态页。
    mcpDirect: {
      enabled: false,
      bind: '0.0.0.0',
      port: 8422,
    },
  },
};

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

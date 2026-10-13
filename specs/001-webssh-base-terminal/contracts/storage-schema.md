# Contract: 存储 Schema

**Branch**: `001-webssh-base-terminal`

持久化文件的结构约定。字段语义与校验规则见 [data-model.md](../data-model.md)，本文只固定格式与版本策略。

## 通用约定

- 编码 UTF-8，JSON 使用 2 空格缩进，审计使用 JSONL（一行一条，无缩进）
- 每个 JSON 文件顶层必含 `version`（number）
- 写入流程：写 `.tmp` → `fsync` → `rename`；覆盖前复制一代 `.bak`
- 时间统一为 ISO 8601 字符串；时长统一为毫秒整数

## `hosts.json`

```jsonc
{
  "version": 1,
  "updatedAt": "2026-09-26T10:00:00.000Z",
  "hosts": [
    {
      "id": "h_01J8X",
      "name": "飞牛 NAS",
      "host": "10.165.2.6",
      "port": 22,
      "username": "root",
      "authType": "privateKey",
      "secret": { "alg": "aes-256-gcm", "iv": "…", "tag": "…", "data": "…" },
      "group": "家庭",
      "ownerId": "1000",
      "fingerprint": "SHA256:…",
      "fingerprintConfirmedAt": "2026-09-26T10:00:00.000Z",
      "createdAt": "…", "updatedAt": "…", "lastUsedAt": "…"
    }
  ]
}
```

## `tokens.json`

```jsonc
{
  "version": 1,
  "tokens": [
    {
      "id": "t_01J8Y",
      "name": "只读巡检",
      "ownerId": "1000",
      "tokenHash": "…",
      "tokenHint": "…a1b2",
      "level": "readonly",
      "hostScope": ["h_01J8X"],
      "permissions": [
        { "prefix": "/var/log", "read": true, "write": false, "download": false, "modify": false,
          "source": "token-override", "systemLevel": true }
      ],
      "expiresAt": null,
      "status": "active",
      "rateLimit": null,
      "createdAt": "…", "lastUsedAt": null
    }
  ]
}
```

## `config.json`

```jsonc
{
  "version": 1,
  "limits": {
    "sessionsPerUser": 10,
    "connectTimeoutMs": 10000,
    "idleTimeoutMs": 1800000,
    "detachedTtlMs": 600000,
    "execTimeoutMs": 60000,
    "tokenRateLimitPerMinute": 60,
    "outputDigestBytes": 2048
  },
  "audit": { "retentionDays": 30, "maxFileBytes": 10485760 },
  "security": {
    "allowedOrigins": [],
    "sensitivePaths": ["/etc/shadow", "/root/.ssh", "/home/*/.ssh"],
    "readOnlyCommands": ["ls", "cat", "head", "tail", "grep", "ps", "df", "free", "uname", "whoami"],
    "dangerousCommands": ["rm", "dd", "mkfs", "shutdown", "reboot", "halt", "chmod", "chown", "userdel"]
  },
  "defaultPermissions": [
    { "prefix": "/var/log", "read": true, "write": false, "download": false, "modify": false,
      "source": "global-default", "systemLevel": true }
  ],
  "standalone": { "bind": "127.0.0.1", "port": 8080 }
}
```

`security.sensitivePaths` 为内置清单，恒定拒绝且不可被令牌配置覆盖；`readOnlyCommands` 与 `dangerousCommands` 为内置固定规则，不按令牌自定义。

## `audit-YYYY-MM-DD.jsonl`

每行一条：

```jsonc
{"version":1,"id":"a_01J8Z","ts":"2026-09-26T10:00:00.000Z","actor":"1000","actorType":"token",
 "tokenId":"t_01J8Y","hostId":"h_01J8X","hostAddress":"10.165.2.6","authType":"privateKey",
 "event":"command","result":"denied","reason":"dangerous_command","durationMs":3,
 "command":"rm -rf /tmp/x","outputDigest":null,"path":null,"redacted":false}
```

## `known_hosts`

每行一条：`host:port <算法> <指纹>`，与 OpenSSH 的已知主机格式保持可读兼容，便于人工核对。

## 版本与迁移

| version | 变更 | 迁移动作 |
|---|---|---|
| 1 | 初始 schema | — |

迁移函数按 `version` 逐级升级；迁移前复制 `.bak`，失败则回退并以告警启动。审计 JSONL 的 `version` 只增不改，读取端须兼容旧版本字段缺失。

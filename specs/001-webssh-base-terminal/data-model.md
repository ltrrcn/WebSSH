# Data Model: WebSSH 基础版

**Branch**: `001-webssh-base-terminal` | **Date**: 2026-09-26

基础版全部持久化数据存放在文件系统，无外部数据库。所有 schema 均携带 `version` 字段以支持迁移。

## 存储布局

| 文件 | 内容 | 目录（fnOS / standalone） |
|---|---|---|
| `hosts.json` | 主机条目与加密凭据 | `$TRIM_PKGETC` / `${WEBSSH_HOME}/etc` |
| `tokens.json` | MCP 令牌与目录权限矩阵 | 同上 |
| `config.json` | 应用配置（超时、限流、审计保留等） | 同上 |
| `master.key` | 数据加密主密钥（32 字节，权限 0700） | 同上 |
| `known_hosts` | 主机指纹记录 | 同上 |
| `audit-YYYY-MM-DD.jsonl` | 审计事件（按天滚动） | `$TRIM_PKGVAR/log` / `${WEBSSH_HOME}/var/log` |
| `*.bak` | 上述 JSON 文件的一代备份 | 同各文件目录 |

## 实体

### Host（主机条目）

| 字段 | 类型 | 说明 | 校验规则 |
|---|---|---|---|
| `id` | string | 稳定唯一标识（设备 ID）：取主机名称净化后的值，冲突时追加 `-2`、`-3`… | 非空，全局唯一（不区分归属），创建后不可变 |
| `name` | string | 显示名称 | 1–64 字符，非空 |
| `host` | string | 主机地址 | 非空；仅允许域名或 IP 字面量，禁止含分隔符与空白 |
| `port` | number | SSH 端口 | 1–65535，默认 22 |
| `username` | string | 登录用户名 | 非空 |
| `authType` | enum | `password` \| `privateKey` | 必填 |
| `secret` | object | 加密后的凭据（见 Credential） | 必填，结构见下 |
| `group` | string \| null | 分组标签 | 可选 |
| `ownerId` | string | 归属使用者 | 必填；来自运行模式的身份来源 |
| `fingerprint` | string \| null | 已确认的主机指纹 | 未确认时为 null |
| `fingerprintConfirmedAt` | string \| null | 指纹确认时间 | ISO 8601 |
| `createdAt` / `updatedAt` / `lastUsedAt` | string | 时间戳 | ISO 8601 |

**状态迁移**：`指纹未确认`（`fingerprint = null`）→ 用户显式确认 → `可用`；指纹变更 → `被拒绝`（需重新确认）。

### Credential（凭据，内嵌于 Host）

以 AES-256-GCM 加密后整体存于 `Host.secret`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `alg` | string | 固定 `aes-256-gcm` |
| `iv` | string | base64，12 字节 |
| `tag` | string | base64，GCM 认证标签 |
| `data` | string | base64，密文；解密后为 `{ password }` 或 `{ privateKey, passphrase }` |

**校验规则**：明文永不出现在任何响应、日志与错误信息中；解密失败必须视为配置损坏而非回退明文。

### Session（会话，仅内存）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 会话唯一标识（会话 ID）：`S` + 连接时刻 `YYYYMMDDHHmmss`，同秒冲突追加 `-2`… |
| `ownerId` | string | 归属使用者 |
| `hostId` | string | 目标主机 |
| `state` | enum | `connecting` → `ready` → `closing` → `closed`；异常态 `failed`；断线保活态 `detached`（保留 SSH 连接等待接管，FR-059） |
| `startedAt` / `endedAt` | string \| null | 起止时间 |
| `endReason` | enum \| null | `user` \| `network` \| `idle-timeout` \| `exec-timeout` \| `detach-timeout` \| `error` |

**状态迁移**：`connecting` → `ready` | `failed`；`ready` → `closing`（收到关闭、网络断开、空闲超时、执行超时）→ `closed`。**进入 `closed` 必须释放全部资源**（对应 SC-005：残留进程数为 0）。

**并发约束**：单使用者并发会话数上限由 `config.json` 控制，超出即拒绝（FR-019）。

### AuditEvent（审计事件）

| 字段 | 类型 | 说明 |
|---|---|---|
| `version` | number | schema 版本，当前 `1` |
| `id` | string | 事件唯一标识 |
| `ts` | string | 发生时间（ISO 8601，服务端时间） |
| `actor` | string | 操作者标识 |
| `actorType` | enum | `user` \| `token` |
| `tokenId` | string \| null | 经由令牌时填写（FR-027） |
| `hostId` / `hostAddress` | string | 目标主机 |
| `authType` | string | 认证方式 |
| `event` | enum | `connect-attempt` \| `connect-success` \| `connect-failure` \| `command` \| `file-read` \| `file-write` \| `disconnect` \| `detach` \| `resume` |
| `result` | enum | `success` \| `denied` \| `error` |
| `reason` | string \| null | 失败/拒绝/断开原因 |
| `durationMs` | number \| null | 时长 |
| `command` | string \| null | 完整命令原文（仅令牌或需留痕场景，FR-041） |
| `outputDigest` | string \| null | 输出摘要（前若干字节，超长标记截断） |
| `path` | string \| null | 涉及的文件路径 |
| `redacted` | boolean | 是否已执行脱敏（FR-042） |

**校验规则**：明文凭据与私钥内容出现次数必须为 0（SC-010 / SC-021）；`command` 与 `outputDigest` 写入前必须过脱敏。

### MCPToken（MCP 令牌）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 令牌标识 |
| `name` | string | 显示名称 |
| `ownerId` | string | 归属使用者 |
| `tokenHash` | string | 令牌明文的不可逆摘要（明文不保存） |
| `tokenHint` | string | 展示用的末几位，便于识别 |
| `level` | enum | `readonly` \| `writable` |
| `hostScope` | string[] | 授权主机 ID 列表 |
| `permissions` | DirectoryPermission[] | 目录权限矩阵（见下） |
| `expiresAt` | string \| null | 有效期，null 表示不自动过期 |
| `status` | enum | `active` \| `revoked` \| `expired` |
| `rateLimit` | object \| null | 覆盖默认限流（可选） |
| `createdAt` / `lastUsedAt` | string | 时间戳 |

**状态迁移**：创建 → `active`；用户撤销 → `revoked`（立即生效）；超过 `expiresAt` → `expired`（自动）。`revoked` 与 `expired` 不可逆。

**校验规则**：`level = readonly` 时不得注册「执行任意命令」能力（FR-031）；`permissions` 条目不得超出全局默认范围（FR-040）。

### DirectoryPermission（目录权限条目）

| 字段 | 类型 | 说明 |
|---|---|---|
| `prefix` | string | 路径前缀（规范化后的绝对路径） |
| `read` / `write` / `download` / `modify` | boolean | 四类权限开关 |
| `source` | enum | `global-default` \| `token-override` |
| `systemLevel` | boolean | 是否系统级路径 |

**校验规则**：`token-override` 条目只能在同名 `global-default` 条目的权限范围内收紧，不得放开任何一类权限；系统敏感路径不产生可放行条目，即使被显式配置也以内置清单优先（FR-036）。

### 全局默认矩阵（config.json 内）

| 字段 | 类型 | 说明 |
|---|---|---|
| `sensitivePaths` | string[] | 内置系统敏感路径前缀，恒定拒绝，不可配置放行 |
| `defaultPermissions` | DirectoryPermission[] | 新令牌的初始矩阵；系统级非敏感路径默认 `read = true`、`modify = true` |

## 判定优先级（运行时）

1. 系统敏感路径清单 → 命中即拒绝（最高优先级，配置不可覆盖）
2. 令牌目录权限矩阵 → 最长前缀匹配
3. 系统级非敏感路径默认值 → 可读、可修改（可被令牌收紧）
4. 未覆盖路径 → 默认拒绝

命令类请求另有三层判定：能力隔离 → 只读命令白名单（默认拒绝）→ 危险命令黑名单（任何级别均不放行）；含拼接/重定向语法者在进入白名单比对前即被拒绝。

## 迁移策略

- 各文件顶层 `version` 变化时，启动时执行迁移函数并记录结果；迁移前自动复制原文件为 `.bak`。
- 迁移失败或文件损坏时，回退到 `.bak` 启动并在日志中告警（FR-017）。
- 审计 JSONL 的 `version` 只增不改，读取端需兼容旧版本字段缺失。

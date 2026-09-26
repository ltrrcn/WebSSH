# Contract: MCP 工具与令牌鉴权

**Version**: 1 | **Branch**: `001-webssh-base-terminal`

MCP 端点挂载在同一 HTTP 服务上（路径 `/mcp`），不新开端口。

## 鉴权

- 外部工具必须在请求中携带 Bearer 令牌（MCP 令牌明文）
- 服务端以不可逆摘要比对；撤销或过期后请求立即被拒绝
- 令牌归属的使用者即为该次操作的审计主体（`actorType = token`）
- 令牌只能访问其 `hostScope` 内的主机，范围外请求返回错误

## 能力隔离（第一层判定）

| 工具 | `readonly` 令牌 | `writable` 令牌 |
|---|---|---|
| `list_hosts` | ✅ 注册 | ✅ 注册 |
| `read_file` | ✅ 注册（受目录矩阵限制） | ✅ 注册 |
| `run_command` | ❌ **不注册** | ✅ 注册 |
| `write_file` | ❌ **不注册** | ✅ 注册 |

只读令牌根本不注册命令与写入类工具，调用方无从调用（对应 FR-031）。

## 工具定义

### `list_hosts`

- 入参：无
- 返回：`[{ id, name, host, port, username, group }]`，仅包含令牌授权范围内的主机
- 失败：令牌无效 / 过期 / 已撤销

### `read_file`

- 入参：`{ hostId, path }`
- 判定顺序：主机授权 → 路径规范化与穿越拒绝 → 系统敏感路径清单 → 令牌目录矩阵（`read`）→ 符号链接真实路径复核
- 返回：`{ content, truncated }`
- 失败：`path_denied`（未授权或敏感路径）、`host_not_allowed`

### `run_command`

- 入参：`{ hostId, command }`
- 判定顺序：主机授权 → 拼接/重定向语法拒绝 → 只读命令白名单不参与（本工具属可变更能力）→ **危险命令黑名单**（命中即拒绝，任何级别不放行）→ 目录矩阵（涉及路径时）
- 返回：`{ exitCode, stdoutDigest, truncated, timedOut }`
- 执行时长上限由配置决定，超时强制终止并返回已产生的摘要（对应 FR-043）
- 失败：`command_denied`、`path_denied`、`host_not_allowed`

### `write_file`

- 入参：`{ hostId, path, content }`
- 判定顺序：主机授权 → 路径规范化 → 敏感路径清单 → 目录矩阵（`write` 与 `modify`）
- 返回：`{ ok }`
- 失败：`path_denied`、`host_not_allowed`

## 命令判定规则（第二、三层）

1. **语法预检**：命令中出现 `;`、`&&`、`||`、`|`、`$()`、反引号、`<`、`>` 时直接拒绝，不拆分放行（FR-034）
2. **白名单**：取首个词比对内置只读命令清单；未列入者默认拒绝（FR-032）
3. **黑名单**：比对内置危险命令清单；命中即拒绝，与令牌级别无关（FR-033）

## 限流

- 默认按令牌维度限流（窗口内请求数上限，配置可调）
- 超额返回 `rate_limited`，不影响其他令牌与人工会话

## 审计

每次工具调用产生一条 `AuditEvent`，含 `tokenId`、`command`（原文，脱敏后）、`outputDigest`（截断）、`path`、`result`、`reason`（FR-041 / FR-042）。

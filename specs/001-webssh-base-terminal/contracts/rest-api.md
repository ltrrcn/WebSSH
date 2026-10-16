# Contract: REST API

**Version**: 1 | **Branch**: `001-webssh-base-terminal`

所有接口返回 `application/json`；错误统一为 `{"error":{"code":<string>,"message":<string>}}`。所有响应**不得**包含明文凭据、私钥或令牌明文。

## 约定

- 身份：fnOS 模式取自 `X-Trim-Userid`；standalone 模式取自登录会话
- 越权访问返回 `403`，且不暴露资源是否存在
- 全部写操作走原子写并留一代备份

## 主机

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/hosts` | 列出当前用户的主机；凭据字段只返回 `hasSecret: boolean` |
| `POST` | `/api/hosts` | 新建主机；请求体含名称、地址、端口、用户名、认证方式、凭据 |
| `GET` | `/api/hosts/{id}` | 获取单个主机 |
| `PUT` | `/api/hosts/{id}` | 更新主机；不传凭据表示保持不变 |
| `DELETE` | `/api/hosts/{id}` | 删除主机及其凭据 |
| `POST` | `/api/hosts/{id}/verify-hostkey` | 确认主机指纹；请求体含 `fingerprint` |
| `POST` | `/api/hosts/{id}/duplicate` | 复制该连接的完整记录（含加密凭据密文原样复制），生成独立新条目「原名 副本」（FR-056） |

**校验**：`host` 禁止包含分隔符与空白；`port` 1–65535；`authType` 为 `password` 或 `privateKey`。

## 分组

分组不是独立实体，是主机条目 `group` 字段（可空字符串，`null` 归入前端「默认」分组）的集合视图。分组操作均为**集合批量更新**，作用于 `ownerId` 范围内的主机。

| 方法 | 路径 | 说明 |
|---|---|---|
| `PUT` | `/api/groups/{name}` | 重命名分组：将该分组内全部主机的 `group` 改为请求体 `newName`；目标名已存在则**合并**（两组主机并入同一分组）。「默认」分组（`null`）不可重命名 |
| `DELETE` | `/api/groups/{name}` | 删除分组：组内全部主机的 `group` 置回 `null`（回到「默认」分组），**主机与加密凭据完整保留，绝不连带删除**。「默认」分组（`null`）不可删除 |

- 两者均返回 `{ ok: true, moved: <受影响主机数> }`；操作 0 台主机时幂等成功（`moved: 0`）。
- `name` 为空或 URL 解码后为空字符串 → 400/422。
- 审计：产生 `group_rename` / `group_delete` 事件，含分组名与受影响数量。

## 会话

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/sessions` | 当前用户的活动会话列表（id、hostId、hostAddress、startedAt、state）；`state=detached` 为断线保活中、可接管的会话（FR-059） |
| `DELETE` | `/api/sessions/{id}` | 终止指定会话并释放资源 |

## MCP 令牌

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/tokens` | 列出令牌（不含明文） |
| `POST` | `/api/tokens` | 创建令牌；**响应中一次性返回明文**，此后不再可获取 |
| `DELETE` | `/api/tokens/{id}` | 撤销令牌，立即生效（记录保留供审计） |
| `DELETE` | `/api/tokens/{id}/purge` | **永久删除**令牌记录（从存储中移除，不可恢复）。仅允许 `revoked`/`expired` 状态——活跃令牌必须先撤销 |
| `GET` | `/api/tokens/defaults` | 获取全局默认目录权限矩阵与敏感路径说明（只读） |

**创建请求体**：`name`、`level`（`readonly`/`writable`）、`hostScope`（主机 ID 数组）、`permissions`（只能在全局默认范围内收紧）、`expiresAt`（可选）。

**校验**：`permissions` 试图放开权限时返回 `422`；`level=readonly` 时不得请求命令类能力。

## 审计

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/audit` | 按时间顺序分页查询；支持 `from`、`to`、`hostId`、`result` 过滤 |
| `GET` | `/api/audit/export` | 导出为可直接阅读的文件（按时间顺序） |

**响应条目**：见 [storage-schema.md](./storage-schema.md) 的 AuditEvent。导出内容同样执行脱敏。

## 配置与运行时

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/runtime` | 返回当前运行模式（`fnos` / `standalone`）与监听形态，不含具体路径 |
| `GET` | `/api/auth/me` | 返回当前请求者身份 `{ id, username, isAdmin }`（fnOS 为网关注入身份，standalone 恒为 `local`）；未认证 401 |

## 错误码

| code | 含义 |
|---|---|
| `invalid_origin` | WebSocket 来源未授权 |
| `host_not_allowed` | 目标主机不在授权清单 |
| `fingerprint_unconfirmed` | 主机指纹未确认 |
| `fingerprint_changed` | 主机指纹变化，已拒绝 |
| `session_limit` | 超出并发会话上限 |
| `permission_out_of_range` | 令牌权限超出全局默认范围 |
| `command_denied` | 命中三层判定任一層 |
| `path_denied` | 路径未授权或属敏感路径 |

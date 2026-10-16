# WebSSH

网页端 SSH 终端：浏览器内连接已授权主机，多会话 tab、审计留痕、MCP 令牌接入。零外部数据库、纯 JS 依赖，同一套代码支持**飞牛 fnOS 应用包**与**通用 Linux** 两种部署形态。

## 功能一览

- **终端**：左侧会话连接列表，右侧多 tab 终端（独立会话、切换不断连、双击改名、右键复制/关闭）
- **凭据安全**：AES-256-GCM 加密落盘；主机指纹 TOFU 确认（首次连接捕获指纹 → 确认后放行，变化即拒绝）
- **审计**：全部连接生命周期事件 JSONL 留痕（脱敏先行），设置 → 审计 可查可导出
- **MCP 令牌**：设置 → 令牌 创建只读/可变更令牌，接入支持 MCP 的 AI 工具（三层判定 + 目录权限矩阵 + 限流）
- **两步验证**：设置 → 两步验证 绑定 TOTP 认证器（Google Authenticator / 腾讯令牌等），为高危险操作（命令审计查看/设置、令牌创建/撤销/删除）增加动态验证；验证一次 5 分钟免重输，8 个一次性恢复码防锁死，连续 5 次失败锁定 5 分钟；认证器丢失可从两步验证页用恢复码恢复（仅 3 次机会）
- **主题**：黑/白双主题，预留终端配色导入扩展点

## 快速开始（standalone）

```bash
npm install --omit=dev --no-optional
WEBSSH_HOME=~/.webssh npm start
# 打开 http://127.0.0.1:8080
```

- Node.js ≥ 22
- 默认仅监听 `127.0.0.1:8080`；数据目录 `~/.webssh/`（`etc/` 配置与凭据、`var/log/` 审计）

## 配置

`$WEBSSH_HOME/etc/config.json`（缺省自动生成，字段见 `specs/001-webssh-base-terminal/contracts/storage-schema.md`）：

| 配置 | 默认 | 说明 |
|---|---|---|
| `limits.sessionsPerUser` | 10 | 单用户并发终端数上限 |
| `limits.connectTimeoutMs` | 10000 | SSH 连接超时 |
| `limits.idleTimeoutMs` | 1800000 | 会话空闲超时（超时断开，关闭码 4010） |
| `limits.execTimeoutMs` | 60000 | MCP 命令执行时长上限 |
| `limits.tokenRateLimitPerMinute` | 60 | MCP 令牌限流 |
| `audit.retentionDays` | 30 | 审计保留天数 |
| `security.allowedOrigins` | [] | 为空时仅允许同源 WebSocket |
| `standalone.bind / port` | 127.0.0.1 / 8080 | 监听地址（非回环必须配 TLS） |
| `fnos.mcpDirect.enabled / bind / port` | false / 0.0.0.0 / 8422 | fnOS 下 MCP 机器直连端口（仅 /mcp，绕过统一网关登录态；限可信内网） |
| `twofa.*` | 见设置页 | 两步验证状态（secret 加密、恢复码哈希、保护开关、防爆破计数）由设置页管理，勿手改 |

## 数据与备份

全部状态在 `WEBSSH_HOME`（fnOS 为系统注入的 `TRIM_PKGETC`/`TRIM_PKGVAR`）：

```
etc/hosts.json       会话连接与加密凭据（.bak 为上一代备份）
etc/tokens.json     MCP 令牌（SHA-256 摘要）
etc/master.key      数据加密主密钥（0700）——丢失则凭据不可恢复
etc/known_hosts     已确认主机指纹（人工核对用）
var/log/audit-*.jsonl     人工操作审计日志（按天/按大小滚动）
var/log/audit-mcp-*.jsonl MCP 令牌调用独立审计流（机器行为与人工分文件）
```

**备份 = 整目录拷贝**；恢复 = 原样放回。`master.key` 必须与 `hosts.json` 成对备份。

## 飞牛 fnOS 打包

```bash
npm run pack:fnos    # 同步产物 + 纯 JS 依赖校验 + fnpack build
# 产物 packaging/fnos/webssh.fpk（manifest 平台 x86，可按需改 all/arm）
```

安装：应用中心 → 手动安装 → 选择 `.fpk`。桌面图标经统一网关 `/app/webssh` 访问，数据由系统按 `TRIM_*` 注入目录管理。

## MCP 接入（AI 工具）

1. 设置 → 令牌 → 创建（选择级别与授权主机，明文仅展示一次）
2. 工具端点与认证：`Authorization: Bearer <令牌>`
   - standalone：`http://<主机>:<端口>/mcp`
   - fnOS 统一网关：`http://<主机>:5666/app/webssh/mcp` —— 网关要求 fnOS 登录态，仅适合浏览器内调试；AI 客户端请用直连端口
   - fnOS MCP 直连（推荐，机器对机器）：在 config.json 启用 `fnos.mcpDirect` 后使用 `http://<主机>:<mcpDirect.port>/mcp`，不经过网关，令牌鉴权由应用层完成
3. 工具：`list_hosts`、`read_file`（只读及以上）、`run_command`、`write_file`（仅可变更级）

## 测试

```bash
npm test              # 单元 + 契约
npm run test:integration  # 需要本机 sshd（自动隔离实例）
```

## 架构与规格

规格驱动开发（Spec Kit）：`specs/001-webssh-base-terminal/`（spec / plan / contracts / tasks / 验证记录），宪法见 `.specify/memory/constitution.md`。

```
src/
├── runtime/   双模式适配（唯一 TRIM_* 入口）
├── crypto/    AES-256-GCM / 脱敏
├── store/     原子写 + 一代备份 + 损坏回退
├── ssh/       连接 / 指纹 / 路径与命令策略
├── session/   会话生命周期 / WS 桥接
├── net/       单一 HTTP 服务（TCP / Unix Socket）+ /mcp
├── api/       REST：主机 / 会话 / 审计 / 令牌
└── mcp/       MCP 端点与工具
web/           前端（无构建，xterm.js vendored）
packaging/fnos fnOS 应用包
```

# Implementation Plan: WebSSH 基础版（网页端 SSH 终端）

**Branch**: `001-webssh-base-terminal` | **Date**: 2026-09-26 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-webssh-base-terminal/spec.md`

## Summary

在单一 Node.js 进程中交付一个网页端 SSH 终端：浏览器内通过 WebSocket 与服务端通信，服务端用 SSH 客户端库连接目标主机并桥接终端字节流。配套提供主机与凭据管理（凭据加密落盘）、结构化审计日志、MCP 令牌接入（三层只读判定 + 目录权限矩阵）。同一套代码以两种形态运行：飞牛 fnOS 应用包（监听 Unix Socket，走系统统一网关）与通用 Linux（监听回环 TCP 端口）。全程不依赖任何外部数据库或中间件，持久化只使用文件系统。

## Technical Context

**Language/Version**: Node.js 22+（ESM）；前端原生 ES Modules，无框架

**Primary Dependencies**:
- `ssh2` — SSH 客户端（纯 JS）
- `ws` — WebSocket 服务端（纯 JS）
- `xterm.js` + `xterm-addon-fit` — 浏览器终端（前端静态资源，vendored）
- `@modelcontextprotocol/sdk` — MCP 服务端能力（纯 JS，P2 阶段引入）
- 其余全部使用 Node 内置模块（`node:http`、`node:crypto`、`node:fs`、`node:test`）

**Storage**: 文件系统。`etc/hosts.json`（主机与凭据）、`etc/tokens.json`（MCP 令牌）、`etc/config.json`（应用配置）、`etc/master.key`（数据加密主密钥）、`var/log/audit-YYYY-MM-DD.jsonl`（审计，按天滚动）。无外部数据库、无 SQLite（基础版）。

**Testing**: `node:test` + `node:assert`（内置，零新增测试依赖）。集成测试依赖本机或容器内的 OpenSSH `sshd`。

**Target Platform**:
- 飞牛 fnOS（x86 / ARM），以 `.fpk` 应用包运行，监听 `${TRIM_APPDEST}/app.sock`
- 通用 Linux（及其他 POSIX 系统），监听 `127.0.0.1:<port>`

**Project Type**: web-service（单进程 Web 应用 + 静态前端）

**Performance Goals**: 终端输入到回显 ≤ 200ms（局域网目标主机）；点击主机到出现提示符 ≤ 5s；支撑数十个并发会话；单会话内存开销可控。

**Constraints**:
- 依赖必须为纯 JavaScript，禁止 node-gyp 原生编译（禁用 `node-pty` 一类）
- 零外部数据库、零外部中间件
- 单一进程、单一对外入口
- fnOS 路径只能通过 `TRIM_*` 获取，禁止硬编码
- 文件写入必须原子化并保留一代备份

**Scale/Scope**: 单机单进程；数十台主机、数十并发会话、数万条审计记录；单用户或极小团队。

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原则 | 门禁判定 | 落实方式 |
|---|---|---|
| I. 安全优先（不可协商） | **PASS** | `node:crypto` AES-256-GCM 加密凭据，`master.key` 权限 0700；WebSocket 握手校验 `Origin`；目标主机只能取自已保存清单，客户端不得传 host/port；`hostVerifier` + 自维护 known_hosts，禁用 `InsecureIgnoreHostKey`；会话与 `X-Trim-Userid`（standalone 为登录会话）强绑定 |
| II. 零外部依赖运行时 | **PASS** | 无数据库、无中间件；`ssh2`/`ws` 为纯 JS；安装使用 `npm install --omit=dev --no-optional`；基础版不引入 SQLite |
| III. 单一进程、单一入口 | **PASS** | 单一 `node:http` 服务，fnOS 监听 Unix Socket、standalone 监听回环端口；MCP 端点复用同一服务的路径，不另开端口 |
| IV. 协议契约先行 | **PASS** | `contracts/` 定义 WebSocket 帧格式、REST 接口、MCP 工具、存储 schema，全部携带 `version` |
| V. 测试先行（不可协商） | **PASS** | `tests/unit`、`tests/integration`、`tests/contract`；SSH 集成测试连真实 `sshd`；第 I 条每条安全规则一测试，测试名引用条款编号；双模式各一冒烟测试 |
| VI. 简洁优先（YAGNI） | **PASS** | 不引入 Web 框架；前端不使用打包器（xterm.js 以 vendored 静态文件方式引入）；不引入 ORM/日志库 |
| VII. 运行模式无关 | **PASS** | `src/runtime/` 是唯一读取 `TRIM_*` 与解析路径的模块，业务层通过注入的 `Runtime` 对象访问；差异全部收敛在适配层 |
| VIII. 分阶段交付：基础版优先 | **PASS** | 不含会话录像、命令拦截审批、授权矩阵；`store` 接口与审计 schema 预留替换与导入能力，但不预建 SQLite |

**首次门禁结论**：无违规，`Complexity Tracking` 无需填写。

**Phase 1 后复检**：结论不变（见文末复检记录）。

## Project Structure

### Documentation (this feature)

```text
specs/001-webssh-base-terminal/
├── plan.md              # 本文件
├── research.md          # Phase 0 输出
├── data-model.md        # Phase 1 输出
├── quickstart.md        # Phase 1 输出
├── contracts/           # Phase 1 输出
│   ├── ws-terminal.md
│   ├── rest-api.md
│   ├── mcp-tools.md
│   └── storage-schema.md
└── tasks.md             # Phase 2 输出（/speckit.tasks 生成，本命令不创建）
```

### Source Code (repository root)

```text
src/
├── runtime/             # 运行模式适配层（唯一允许读 TRIM_* 的地方）
│   ├── profile.js       # detectMode() / resolveRuntime()
│   └── paths.js         # 路径映射与目录初始化（0700）
├── config/              # 应用配置加载、默认值、校验
├── store/               # 持久化（store 接口 + 文件实现）
│   ├── store.js         # 接口定义（可替换为 SQLite 实现）
│   ├── file-store.js
│   └── atomic.js        # 原子写 + 串行化 + 一代备份
├── crypto/
│   ├── secret.js        # AES-256-GCM 加解密
│   ├── master-key.js    # 主密钥创建与加载
│   └── redact.js        # 审计脱敏（凭据/私钥占位符替换）
├── ssh/
│   ├── client.js        # 连接建立、认证、shell/exec
│   ├── hostkey.js       # known_hosts 维护与校验
│   └── policy.js        # 三层判定 + 目录权限矩阵
├── session/
│   └── manager.js       # 会话生命周期、并发上限、超时与资源释放
├── net/
│   ├── server.js        # 单一 HTTP 服务（socket / TCP）
│   ├── upgrade.js       # WebSocket 升级与 Origin 校验
│   └── auth.js          # 身份来源适配（X-Trim-* / 登录会话）
├── api/                 # REST 路由：主机 CRUD、令牌 CRUD、审计查询导出
├── mcp/                 # MCP 工具与令牌鉴权（P2）
└── audit/
    └── logger.js        # JSONL 审计写入与滚动

web/                     # 前端静态资源（无构建步骤）
├── index.html
├── vendor/xterm/        # vendored xterm.js 发行文件
└── src/                 # 终端页与主机管理页（原生 ES Modules）

tests/
├── unit/                # 策略判定、加解密、路径解析、原子写
├── integration/         # 真实 sshd 连接/执行/resize/断开；双模式冒烟
└── contract/            # WS 帧格式、REST、MCP 工具契约校验

packaging/fnos/          # fnOS 应用包目录
├── manifest
├── cmd/main
├── config/{privilege,resource}
└── app/ui/config
```

**Structure Decision**: 采用单项目结构（Option 1 变体）。后端与前端同仓不同目录，前端不参与构建、直接以静态资源托管，避免引入打包器。fnOS 打包目录独立放置于 `packaging/fnos/`，构建时才把后端与前端产物同步进去，保持源码树与打包树分离。

## Complexity Tracking

> 宪法门禁无违规，无需填写。

**Phase 1 后复检记录**：`contracts/` 中新增 MCP 工具契约与目录权限矩阵判定规则后，仍满足第 III 条（MCP 复用同一入口）、第 VI 条（未新增运行时依赖，MCP SDK 为纯 JS）、第 VIII 条（未预建 SQLite）。门禁结论维持 PASS。

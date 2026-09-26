# Research: WebSSH 基础版

**Date**: 2026-09-26 | **Branch**: `001-webssh-base-terminal`

Phase 0 目标：消除技术方案中的全部未知项，为 Phase 1 的设计与契约提供依据。

## R1. SSH 客户端库选型

- **Decision**: `ssh2`
- **Rationale**: Node 生态事实标准，纯 JavaScript 无原生编译，支持 password / publickey / keyboard-interactive 认证，`shell()` 由远端 sshd 分配 PTY 并返回 Duplex 流，`setWindow()` 支持窗口尺寸变更，可直接与 WebSocket 双向对接。满足宪法第 II 条（纯 JS、禁原生模块）。
- **Alternatives considered**: `node-ssh`（`ssh2` 的封装，多一层抽象且对长连接流控制不如直接用 `ssh2`，按第 VI 条放弃）；系统 `ssh` 二进制（需 fork 进程、依赖系统安装、无法精细控制 PTY 与 resize，放弃）；自研 SSH 协议实现（工作量与风险不可接受，放弃）。

## R2. 本地 PTY 是否需要

- **Decision**: 不需要。PTY 由远端 sshd 在 `shell()` 时分配。
- **Rationale**: 避免 `node-pty` 带来的 node-gyp 原生编译与按架构分发问题，直接消除打包阶段最大的风险点。
- **Alternatives considered**: 引入 `node-pty` 做本地 shell（本机场景才需要，当前需求是连接远程主机；且违反宪法第 II 条）。

## R3. 前端终端组件

- **Decision**: `xterm.js` + `xterm-addon-fit`，以 vendored 静态文件引入，不使用打包器。
- **Rationale**: 浏览器终端的事实标准，处理了光标、颜色、宽字符、控制序列等全部细节。vendored 方式让前端零构建步骤，符合第 VI 条。
- **Alternatives considered**: 自研终端渲染（需实现完整 VT100/ANSI 序列解析，不可行）；引入 Vite/esbuild（仅为一个页面引入构建链，按 YAGNI 放弃）。

## R4. WebSocket 与 SSH 流的桥接方式

- **Decision**: 使用 `ws` 的二进制帧，第一个字节作为帧类型标识，其余为负载；控制类消息与终端数据共用同一连接。
- **Rationale**: 终端字节流是二进制且可能包含任意字节，用首字节区分类型可避免在流中做文本解析，也不会与终端内容冲突。`ssh2` 的 channel 是 Duplex 流，与 `ws` 之间双向转发即可。
- **Alternatives considered**: 文本 JSON 封装全部数据（需 base64，带宽与延迟翻倍，放弃）；终端数据与控制消息分两条 WebSocket（增加状态同步复杂度，放弃）。

## R5. 帧类型划分

- **Decision**: `0x00` 终端数据、`0x01` 窗口尺寸变更、`0x02` 信号（中断等）；服务端到客户端同构。
- **Rationale**: 与规格中「终端双向输出、resize 同步、可中断输出」三条需求一一对应，且可被单元测试穷举。
- **Alternatives considered**: 每种消息一个 WebSocket 子协议（复杂度高，放弃）。

## R6. fnOS 统一网关下的监听方式

- **Decision**: `httpServer.listen(path)` 监听 `${TRIM_APPDEST}/app.sock`；入口配置 `gatewayPrefix=/app/webssh`、`gatewaySocket=app.sock`。
- **Rationale**: Node 的 HTTP 服务原生支持 Unix Socket 路径监听，无需任何额外依赖；统一网关在转发前完成登录态校验并注入 `X-Trim-*`，正好满足规格的身份来源要求。
- **Alternatives considered**: 监听 TCP 端口再由网关反代（需额外占用端口，违反宪法第 III 条「单一入口、不额外开放端口」）。

## R7. 凭据与令牌的加密方案

- **Decision**: `node:crypto` 的 AES-256-GCM；主密钥为首次启动生成的 32 字节随机数，存于 `etc/master.key`，文件权限 0700。令牌以不可逆摘要保存校验值，明文只在创建响应中出现一次。
- **Rationale**: GCM 自带完整性校验（authTag），可检测密文篡改；无需引入任何依赖；令牌用摘要而非可逆加密，保证数据库/文件泄露也无法还原令牌。
- **Alternatives considered**: 口令派生主密钥（安全性更高但每次重启需人工输入，与「无人值守常驻服务」冲突，记录为高级版可选增强）；对称加密保存令牌（泄露即可还原，放弃）。

## R8. 文件写入的可靠性

- **Decision**: 写 `.tmp` → `fsync` → `rename` 覆盖；进程内用一条 Promise 链串行化所有写操作；覆盖前保留一代 `.bak`。
- **Rationale**: 断电或崩溃不会留下半截 JSON；串行化避免并发写互相覆盖；一代备份支撑规格 FR-017 的「损坏自动回退」。
- **Alternatives considered**: 直接写原文件（有损坏风险，放弃）；引入写锁库（无必要，单进程内串行即可）。

## R9. 审计日志的形态与滚动

- **Decision**: JSONL（一行一条 JSON 事件），按天滚动，保留天数可配置。
- **Rationale**: 追加写入成本最低、天然可按行解析，且形状固定后可直接导入 SQLite，满足第 VIII 条「预留扩展点」而不预建。
- **Alternatives considered**: 单文件 JSON 数组（每次写入需整体重写，放弃）；SQLite（基础版禁用，留待高级版）。

## R10. HostKey 校验

- **Decision**: 用 `ssh2` 的 `hostVerifier` 回调，配合自维护的 known_hosts 文件（存于 `etc/known_hosts`）；未记录的主机首次连接时向用户返回指纹待确认，指纹变化直接拒绝。禁止使用 `InsecureIgnoreHostKey`。
- **Rationale**: 满足规格 FR-007 与宪法第 I 条。自维护文件而非依赖系统 `~/.ssh/known_hosts`，是因为应用以专用低权用户运行，不应读写用户家目录。
- **Alternatives considered**: 复用 OpenSSH 的 known_hosts（路径与权限受运行用户限制，放弃）。

## R11. MCP 传输与工具形态

- **Decision**: 使用 `@modelcontextprotocol/sdk`，以 HTTP 传输挂载在同一 HTTP 服务上，不新开端口；工具按能力拆分，只读令牌只注册只读工具。
- **Rationale**: 复用既有入口满足第 III 条；「不注册工具」比「注册后在运行时拒绝」更彻底，正是 Q1 选择的 A 层能力隔离。
- **Alternatives considered**: 独立端口的 MCP 服务（违反单一入口，放弃）；注册全部工具再在运行时判定（可被调用方探测、实现易漏判，放弃）。

## R12. 只读命令白名单与危险命令黑名单的判定实现

- **Decision**: 先做词法切分（识别 `;`、`&&`、`||`、`|`、`$()`、反引号、`>`、`<`），命中拼接或重定向语法即整体拒绝；再取第一个词作为命令名，与内置白名单/黑名单比对。
- **Rationale**: 直接字符串前缀匹配会被 `ls; rm -rf` 之类绕过；先拒绝再匹配可显著降低绕过面，对应 FR-034。
- **Alternatives considered**: 正则黑名单（易被编码与空格变形绕过，放弃）；交给远端主机做权限控制（无法保证目标主机配置一致，放弃）。

## R13. 目录权限矩阵的路径判定

- **Decision**: 以最长前缀匹配选择矩阵条目；判定前先规范化路径并拒绝向上穿越；符号链接按解析后的真实路径判定；系统敏感路径清单内置固定，优先级高于任何令牌条目。
- **Rationale**: 对应 FR-035~039。最长前缀可表达「父目录宽、子目录严」的收紧关系，符合 Q3 的「只能收紧」约束。
- **Alternatives considered**: 精确路径匹配（表达力不足，放弃）；通配/正则（配置易写错且判定开销大，放弃）。

## R14. 集成测试用的 SSH 服务端

- **Decision**: 集成测试启动真实 OpenSSH `sshd`（优先容器，其次宿主机 sshd），使用临时生成的密钥与专用测试端口；测试结束清理。
- **Rationale**: 规格要求 SSH 逻辑有真实连接、执行、resize、断开的集成测试；mock 无法覆盖协议与 PTY 行为。
- **Alternatives considered**: 用 `ssh2` 的服务端实现做对端（自证式测试，覆盖不到真实 sshd 行为，放弃）。

## R15. fnOS 打包产物形态

- **Decision**: `npm install --omit=dev --no-optional` 后的 `node_modules` 随应用包分发，依赖 fnOS 的 Node 运行时。
- **Rationale**: 官方 `nodejs_v22` 运行时可由 `install_dep_apps` 声明，路径稳定（`TRIM_APPDEST` 等由系统注入），最省事且可复现。
- **Alternatives considered**: Node SEA 单文件（可去掉运行时依赖，但需 `postject` 注入、与 `.fpk` 打包流程叠加，调试成本高；记录为后续优化项，当前不采用）。

## R16. 前端是否需要构建工具

- **Decision**: 不需要。xterm.js 以 vendored 静态文件引入，页面使用原生 ES Modules。
- **Rationale**: 只有两个页面，引入打包器会新增 devDependency 与构建步骤，违反第 VI 条。
- **Alternatives considered**: Vite/esbuild（收益不足以抵消复杂度，放弃）。

## 未解决的未知项

无。Technical Context 中原有的不确定项已全部在本文件中决策完毕。

# Tasks: WebSSH 基础版（网页端 SSH 终端）

**Input**: Design documents from `/specs/001-webssh-base-terminal/`

**Prerequisites**: plan.md（技术栈与结构）、spec.md（6 个用户故事 P1/P1/P2/P2/P2/P2）、research.md（16 项决策）、data-model.md（7 个实体）、contracts/（ws-terminal / rest-api / mcp-tools / storage-schema）、quickstart.md（端到端验证步骤）

**Tests**: 宪法第 V 条要求 TDD（先写测试 → 确认失败 → 再实现），因此**每个故事阶段都包含测试任务**，测试必须先于同阶段实现任务执行并确认失败。

**Organization**: 按用户故事分组，每个故事可独立实现与验证。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件、无未完成依赖）
- **[Story]**: 所属用户故事（US1–US6）
- 描述中均含具体文件路径

## Path Conventions

- 后端：`src/`（单项目，ESM）
- 前端静态：`web/`（无构建步骤，xterm.js vendored）
- 测试：`tests/unit`、`tests/integration`、`tests/contract`、`tests/helpers`
- fnOS 打包：`packaging/fnos/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 项目初始化与依赖落地

- [ ] T001 创建 `package.json`（`"type": "module"`、Node 22 engines、依赖 `ssh2` / `ws` / `@modelcontextprotocol/sdk`、scripts: `start` / `test` / `test:unit` / `test:integration` / `test:contract` / `pack:fnos`）与 `.gitignore`
- [ ] T002 [P] 创建目录骨架：`src/{runtime,config,store,crypto,ssh,session,net,api,mcp,audit}`、`web/{vendor/xterm,src}`、`tests/{unit,integration,contract,helpers}`、`packaging/fnos/{cmd,config,app/ui,app/images}`、`scripts/`
- [ ] T003 执行 `npm install --omit=dev --no-optional` 安装 `ssh2` / `ws` / `@modelcontextprotocol/sdk`，并校验产物中不含任何 `.node` 原生二进制（宪法第 II 条）
- [ ] T004 [P] 配置 `node:test` 运行脚本与 `tests/helpers/tmpdir.js`（临时目录与清理）
- [ ] T005 [P] 将 `xterm.js` 与 `xterm-addon-fit` 发行文件 vendored 到 `web/vendor/xterm/`，并在 `web/vendor/xterm/VERSION.txt` 记录版本与来源
- [ ] T006 [P] 集成测试用 sshd 脚手架 `tests/helpers/sshd.js`：临时主机密钥 + 专用端口 + authorized_keys，启动/探测/销毁（research R14）

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 所有用户故事都依赖的核心设施——运行模式适配、配置、加密、存储、审计、单一 HTTP 服务与身份

**⚠️ CRITICAL**: 本阶段未完成前，任何用户故事的工作都不得开始

### Tests for Foundation（先写，必须失败）

- [ ] T007 [P] `tests/unit/runtime-profile.test.js`：`detectMode()` 两分支（`TRIM_APPNAME` 非空 → `fnos`，否则 `standalone`）、`resolveRuntime()` 返回 `paths`/`listen`/`authSource`/`mode`
- [ ] T008 [P] `tests/unit/secret-crypto.test.js`：AES-256-GCM 加解密往返、authTag 篡改必须失败、主密钥文件权限 0700、解密失败不得回退明文
- [ ] T009 [P] `tests/unit/atomic-write.test.js`：原子写（.tmp → fsync → rename）、并发写串行化、一代 `.bak`、文件损坏时回退 `.bak` 启动
- [ ] T010 [P] `tests/unit/host-authorization.test.js`：主机不在授权清单 / 不属当前使用者 → 拒绝（FR-001 / FR-009 / FR-020）
- [ ] T011 [P] `tests/unit/path-policy.test.js`：路径规范化、`..` 穿越拒绝、系统敏感路径恒定拒绝、最长前缀匹配、符号链接按真实路径判定（FR-036/037/038/039）
- [ ] T012 [P] `tests/unit/redact.test.js`：疑似口令与私钥片段被占位符替换，其余内容保留（FR-042）
- [ ] T013 [P] `tests/contract/runtime-api.test.js`：`GET /api/runtime` 返回 mode 与监听形态，且不含具体路径

### Implementation for Foundation

- [ ] T014 `src/runtime/profile.js`：`detectMode()` + `resolveRuntime()`，**唯一**允许读取 `TRIM_*` 的入口（宪法第 VII 条）
- [ ] T015 `src/runtime/paths.js`：fnOS（`TRIM_PKGETC`/`TRIM_PKGVAR`/`TRIM_PKGTMP`/`TRIM_APPDEST`/`TRIM_PKGVAR/log`）与 standalone（`${WEBSSH_HOME}/{etc,var,tmp,var/log}`）映射为 `paths.config/data/tmp/log/program`；启动时校验并在缺失时创建，配置目录权限 0700
- [ ] T016 [P] `src/crypto/master-key.js`：首次启动生成 32 字节随机主密钥写入 `paths.config/master.key`（0700），后续加载复用
- [ ] T017 `src/crypto/secret.js`：AES-256-GCM 加解密（`alg`/`iv`/`tag`/`data`），强制校验 authTag
- [ ] T018 [P] `src/crypto/redact.js`：凭据与私钥片段检出并替换为占位符，输出摘要超长截断标记
- [ ] T019 `src/store/atomic.js`：写 `.tmp` → `fsync` → `rename`；进程内 Promise 链串行化；覆盖前保留一代 `.bak`；读取失败时回退 `.bak` 并告警（FR-017）
- [ ] T020 `src/store/store.js`：存储接口定义（hosts / tokens / audit 三组操作），接口稳定以便高级版替换为 SQLite 实现（宪法第 VIII 条）
- [ ] T021 `src/store/file-store.js`：基于 `store.js` 的文件实现——`hosts.json` / `tokens.json` 读写、顶层 `version`、迁移钩子、`ownerId` 归属过滤、损坏回退
- [ ] T022 `src/config/defaults.js` + `src/config/loader.js`：默认配置（limits / audit / security / defaultPermissions / standalone），加载时与用户配置合并并校验，按 `version` 迁移
- [ ] T023 `src/audit/logger.js`：JSONL 追加写入、按天与按大小滚动、`retentionDays` 清理、写入前过 `redact.js`；字段严格遵循 AuditEvent schema（version=1）
- [ ] T024 `src/ssh/policy.js`（路径部分）：路径规范化、穿越拒绝、系统敏感路径内置清单恒定拒绝、目录矩阵最长前缀匹配、符号链接真实路径复核
- [ ] T025 [P] `src/net/router.js`：`/api/*` 路由分发 + `web/` 静态文件服务（含路径穿越防护与扩展名 MIME）+ 实现 `GET /api/runtime`（返回当前 mode 与监听形态，不含具体路径——T013 契约测试的实现落点）
- [ ] T026 `src/net/server.js`：单一 `node:http` 服务；fnOS 监听 `${TRIM_APPDEST}/app.sock`，standalone 监听 `127.0.0.1:<port>`；绑定非回环且未启用 TLS 时输出启动告警
- [ ] T027 `src/net/auth.js`：身份来源适配——fnOS 取 `X-Trim-Userid`/`Username`/`Isadmin`，standalone 取应用登录会话；**禁止**信任请求体自带的用户 ID
- [ ] T028 `src/index.js`：启动引导（探测模式 → 解析路径 → 加载配置 → 建服务 → 输出模式与监听形态日志）、优雅退出（关闭所有会话后再退出）
- [ ] T029 [P] `web/index.html` + `web/src/app.js`：页面外壳与导航（终端 / 主机 / 审计 / 令牌），静态资源在网关前缀下可正确加载

**Checkpoint**: 基础就绪——可启动服务、数据目录自动创建、加密与原子写可用、审计可写。用户故事可开始。

---

## Phase 3: User Story 1 - 从主机清单直接打开远程终端 (Priority: P1) 🎯 MVP

**Goal**: 浏览器内出现可交互远程终端，双向传输、窗口 resize 同步、可中断。

**Independent Test**: 通过种子脚本预置一台可登录主机，点击后 5 秒内出现提示符，执行 `whoami` 回显正确；改变窗口大小后 `tput cols` 随之变化；`Ctrl+C` 可中断。

### Tests for User Story 1（先写，必须失败）

- [ ] T030 [P] [US1] `tests/contract/ws-terminal.test.js`：`/ws/terminal` 握手 Origin 校验、`version` 参数校验（缺失或不支持 → HTTP 400，宪法 VIII）、仅接受 `hostId`/`version` 参数、帧类型 `0x00`/`0x01`/`0x02` 语义、非法 `cols`/`rows` 丢弃、关闭码 4001/4003/4004/4005/4006/4010
- [ ] T031 [P] [US1] `tests/unit/ws-frame.test.js`：帧编解码（首字节类型 + 负载）、`0x00` 负载不被当作文本解析、控制帧 JSON 校验
- [ ] T032 [P] [US1] `tests/integration/terminal-sshd.test.js`：连真实 sshd 完成连接 → 执行 → resize → 信号中断 → 断开
- [ ] T033 [P] [US1] `tests/helpers/seed-host.js`：直接写 `hosts.json` 种子主机（含加密凭据），使 US1 可独立于 US2 界面验证

### Implementation for User Story 1

- [ ] T034 [US1] `src/net/upgrade.js`：WebSocket 升级处理——校验 `Origin`、校验 `version` 参数（缺失或不支持 → HTTP 400）、校验 `hostId` 归属与存在性、并发上限预检、指纹确认预检，失败按约定关闭码结束
- [ ] T035 [US1] `src/ssh/client.js`：基于 `ssh2` 建立连接（口令 / 私钥 + passphrase）、连接超时 `connectTimeoutMs`、申请 `shell({term, cols, rows})`、`setWindow()` 变更尺寸、发送 `INT` 信号
- [ ] T036 [US1] `src/ssh/hostkey.js`：`etc/known_hosts` 读写（OpenSSH 可读兼容格式）、`hostVerifier` 校验、指纹未确认返回待确认、指纹变化直接拒绝并告警（FR-007）
- [ ] T037 [US1] `src/session/manager.js`：会话创建/查询/关闭、状态机（`connecting`→`ready`|`failed`→`closing`→`closed`）、并发上限 `sessionsPerUser`、空闲超时 `idleTimeoutMs`、进入 `closed` 必须释放全部资源
- [ ] T038 [US1] `src/session/bridge.js`：WS ↔ SSH 双向转发——客户端 `0x00` → SSH stdin；SSH stdout → 客户端 `0x00`；`0x01` → `setWindow`；`0x02` → 白名单信号
- [ ] T039 [US1] `src/api/hosts.js`（只读部分）：`GET /api/hosts` 返回当前用户主机，凭据仅回 `hasSecret: boolean`
- [ ] T040 [US1] `web/src/terminal.js`：xterm.js 初始化、`xterm-addon-fit`、二进制收发、`term.write` 分片节流保证大输出下界面可响应且可中断（FR-021）、窗口 resize 上报、`Ctrl+C` 信号、断开原因提示；WebSocket 连接携带 `version=1` 握手参数；接入 `web/index.html`
- [ ] T041 [US1] 会话生命周期事件写入审计：`connect-attempt` / `connect-success` / `connect-failure` / `disconnect`，含 actor、hostId、authType、result、reason、durationMs（FR-010 / FR-011）

**Checkpoint**: US1 可独立验证——终端连接、双向输入输出、resize、中断均可用。

---

## Phase 4: User Story 2 - 保存主机与凭据，一次录入反复使用 (Priority: P1)

**Goal**: 主机条目的增删改查与分组，凭据加密保存且永不回显。

**Independent Test**: 录入一台主机并保存凭据，重启服务后仍可直接打开终端；查看与编辑页面不出现明文凭据。

### Tests for User Story 2（先写，必须失败）

- [ ] T042 [P] [US2] `tests/contract/hosts-api.test.js`：主机 CRUD 契约、字段校验（host/port/authType）、越权返回 403 且不暴露资源存在性、响应不含明文凭据
- [ ] T043 [P] [US2] `tests/unit/host-validation.test.js`：`host` 禁止分隔符与空白、`port` 1–65535、`authType` 枚举、名称长度
- [ ] T044 [P] [US2] `tests/integration/host-persistence.test.js`：保存凭据 → 重启服务 → 仍可连接；删除后不可再连接

### Implementation for User Story 2

- [ ] T045 [US2] `src/api/hosts.js`（完整 CRUD，**依赖 T039 已建只读接口后扩展同一文件**）：`POST` / `GET` / `PUT` / `DELETE` /api/hosts，全部按 `ownerId` 隔离，`PUT` 不传凭据表示保持不变，写操作走原子写与备份
- [ ] T046 [US2] `src/api/hosts.js`：`POST /api/hosts/{id}/verify-hostkey` 确认主机指纹并写入 `known_hosts`
- [ ] T047 [US2] `src/store/file-store.js`：主机条目字段校验、分组（`group`）维护、`lastUsedAt` 更新
- [ ] T048 [US2] `web/src/hosts.js`：主机管理页——列表（按分组）、新增、编辑、删除
- [ ] T049 [US2] `web/src/hosts.js`：凭据字段永不回显（仅显示"已保存"与可替换）、指纹未确认时的确认交互

**Checkpoint**: US1 + US2 均可用，可脱离种子脚本人工录入主机。

---

## Phase 5: User Story 3 - 会话可靠结束，不残留资源 (Priority: P2)

**Goal**: 关闭标签页 / 刷新 / 网络中断 / 空闲超时后，服务端立即终止远程连接并释放资源。

**Independent Test**: 打开会话后直接关闭标签页，sshd 侧对应会话在数秒内消失；空闲会话在超时后被断开并提示原因。

### Tests for User Story 3（先写，必须失败）

- [ ] T050 [P] [US3] `tests/integration/session-cleanup.test.js`：WS 关闭后 sshd 侧会话终止、服务端无残留连接（SC-005）
- [ ] T051 [P] [US3] `tests/integration/session-limits.test.js`：多会话互不影响；达到上限后新连接被拒并给出 `session_limit`

### Implementation for User Story 3

- [ ] T052 [US3] `src/session/manager.js`：关闭链路——`ws close` / `ws error` / 网络断开 / 进程退出均触发 SSH 终止与资源释放，写入 `endReason`
- [ ] T053 [US3] `src/session/manager.js`：空闲超时计时（`idleTimeoutMs`）→ 关闭码 `4010`，前端显示断开原因
- [ ] T054 [US3] `src/session/manager.js`：并发上限校验 → 关闭码 `4004`（FR-019）
- [ ] T055 [US3] `src/api/sessions.js`：`GET /api/sessions`（当前用户活动会话）与 `DELETE /api/sessions/{id}`（终止并释放）

**Checkpoint**: 会话生命周期闭环，无资源泄漏。

---

## Phase 6: User Story 4 - 连接行为留痕，可追溯可导出 (Priority: P2)

**Goal**: 每次连接的建立、失败与断开都有审计记录，可按时间顺序查看并导出。

**Independent Test**: 制造成功、认证失败、空闲断开三类连接后，审计页出现三条记录；导出文件可直接用文本编辑器阅读。

### Tests for User Story 4（先写，必须失败）

- [ ] T056 [P] [US4] `tests/contract/audit-api.test.js`：`GET /api/audit` 分页与 `from`/`to`/`hostId`/`result` 过滤；`GET /api/audit/export` 按时间顺序且可直接阅读
- [ ] T057 [P] [US4] `tests/unit/audit-completeness.test.js`：三类连接均产生记录，字段完备（操作者、时间、主机、认证方式、结果、时长、断开原因）

### Implementation for User Story 4

- [ ] T058 [US4] `src/api/audit.js`：`GET /api/audit` 按时间顺序分页查询与过滤（读取端兼容旧 `version` 字段缺失）
- [ ] T059 [US4] `src/api/audit.js`：`GET /api/audit/export` 导出可直接阅读文件，导出内容同样执行脱敏
- [ ] T060 [US4] `src/audit/logger.js`：补全认证失败与各类断开原因的记录路径，保证 100% 覆盖（FR-010 / SC-004）
- [ ] T061 [US4] `web/src/audit.js`：审计页——时间顺序列表、过滤条件、导出按钮

**Checkpoint**: 审计可查可导出，无明文凭据（SC-010 / SC-021）。

---

## Phase 7: User Story 5 - 同一套程序在飞牛设备与通用 Linux 上都能跑 (Priority: P2)

**Goal**: 双模式一致，数据目录由部署环境决定，无需手工改路径。

**Independent Test**: 同一份代码分别以 standalone 与 fnos 启动，完成「录入主机 → 打开终端 → 执行命令 → 查看审计」且结果一致。

### Tests for User Story 5（先写，必须失败）

- [ ] T062 [P] [US5] `tests/integration/smoke-standalone.test.js`：注入 `WEBSSH_HOME` 启动，走完核心用例
- [ ] T063 [P] [US5] `tests/integration/smoke-fnos.test.js`：注入 `TRIM_APPNAME`/`TRIM_APPDEST`/`TRIM_PKGETC`/`TRIM_PKGVAR`/`TRIM_PKGTMP` 启动，验证监听 Unix Socket 且核心用例一致

### Implementation for User Story 5

- [ ] T064 [P] [US5] `packaging/fnos/manifest`：`appname=webssh`、`source=thirdparty`、声明 `install_dep_apps=nodejs_v22`、`ctl_stop=true`、`os_min_version` 按目标系统填写、**不写** `service_port`（走统一网关）
- [ ] T065 [P] [US5] `packaging/fnos/cmd/main`：`start` / `stop` / `status`，退出码 0/1/3，路径全部取自 `TRIM_*`，后台进程 PID 写入 `$TRIM_PKGVAR`
- [ ] T066 [P] [US5] `packaging/fnos/config/privilege`（`run-as=package`、`username`/`groupname`）与 `config/resource`
- [ ] T067 [P] [US5] `packaging/fnos/app/ui/config`：桌面入口 `type=iframe`、`gatewayPrefix=/app/webssh`、`gatewaySocket=app.sock`、`allUsers=true`，以及 `ICON.PNG` / `ICON_256.PNG` / `app/ui/images/icon_{64,256}.png`
- [ ] T068 [US5] `scripts/build-fnos.sh`：将 `src/`（含 `npm install --omit=dev --no-optional` 后的 `node_modules`）与 `web/` 同步进应用包目录并调用 `fnpack build`；**必须在 fnpack 打包前通过纯 JS 依赖校验**
- [ ] T069 [US5] `src/net/router.js` 与前端资源在统一网关前缀下的路径适配（相对引用，避免硬编码根路径）
- [ ] T070 [US5] `README.md`：standalone 启动方式（`WEBSSH_HOME`、`npm start`）、systemd 单元样例、fnOS 安装步骤

**Checkpoint**: 两种形态均可启动并完成核心用例（SC-007）。

---

## Phase 8: User Story 6 - 创建 MCP 令牌，让外部 AI 工具接入 (Priority: P2)

**Goal**: 令牌管理与外部 MCP 工具接入——三层判定、目录权限矩阵、限流、审计留痕。

**Independent Test**: 创建一枚限定范围的令牌，用外部 MCP 客户端查询主机并执行命令；撤销后立即失效。

### Tests for User Story 6（先写，必须失败）

- [ ] T071 [P] [US6] `tests/contract/mcp-tools.test.js`：工具注册矩阵（readonly 不注册 `run_command`/`write_file`）、入参与返回、错误码 `command_denied`/`path_denied`/`host_not_allowed`/`rate_limited`
- [ ] T072 [P] [US6] `tests/unit/command-policy.test.js`：拼接与重定向语法一律拒绝、只读白名单默认拒绝、危险黑名单任何级别不放行、三层判定顺序（FR-030 ~ FR-034）
- [ ] T073 [P] [US6] `tests/unit/dir-matrix.test.js`：全局默认初始化、令牌条目只能收紧不得放开、越界返回 `permission_out_of_range`、系统敏感路径不可被配置放行（FR-035 ~ FR-040）
- [ ] T074 [P] [US6] `tests/unit/token-auth.test.js`：不可逆摘要校验、明文不落盘、过期与撤销立即失效、限流按令牌维度
- [ ] T075 [P] [US6] `tests/integration/mcp-e2e.test.js`：真实 MCP 客户端 + 真实 sshd 走完 list/read/run/write，撤销后立即拒绝

### Implementation for User Story 6

- [ ] T076 [US6] `src/mcp/tokens.js`：令牌创建（生成明文 + `tokenHash` + `tokenHint`）、校验、撤销、过期判定、`hostScope` 校验、`lastUsedAt` 更新
- [ ] T077 [US6] `src/api/tokens.js`：`GET`/`POST` /api/tokens（创建响应一次性返回明文）、`DELETE /api/tokens/{id}`（撤销立即生效）、`GET /api/tokens/defaults`（全局默认矩阵与敏感路径说明）
- [ ] T078 [US6] `src/ssh/policy.js`（命令部分）：词法预检 → 只读白名单 → 危险黑名单的三层判定，命中即拒绝并给出 reason
- [ ] T079 [US6] `src/mcp/server.js`：使用 `@modelcontextprotocol/sdk` 将 MCP 端点挂载到同一 HTTP 服务的 `/mcp`（不新开端口），Bearer 令牌鉴权
- [ ] T080 [US6] `src/mcp/tools/list-hosts.js`：仅返回 `hostScope` 内主机，字段 `{id,name,host,port,username,group}`
- [ ] T081 [US6] `src/mcp/tools/read-file.js`：主机授权 → 路径规范化与穿越拒绝 → 敏感路径 → 矩阵 `read` → 符号链接复核，返回 `{content,truncated}`
- [ ] T082 [US6] `src/mcp/tools/run-command.js`：主机授权 → 语法预检 → 危险黑名单 → 矩阵；`execTimeoutMs` 超时强制终止并回传已产生摘要，返回 `{exitCode,stdoutDigest,truncated,timedOut}`
- [ ] T083 [US6] `src/mcp/tools/write-file.js`：主机授权 → 路径规范化 → 敏感路径 → 矩阵 `write` + `modify`，返回 `{ok}`
- [ ] T084 [US6] `src/mcp/rate-limit.js`：按令牌维度窗口限流，超额返回 `rate_limited` 且不影响其他令牌与人工会话（FR-028）
- [ ] T085 [US6] `src/mcp/audit-hook.js`：每次工具调用写入 AuditEvent，含 `tokenId`、脱敏后的 `command` 原文、截断的 `outputDigest`、`path`、`result`、`reason`（FR-041 / FR-042 / FR-043）
- [ ] T086 [US6] `web/src/tokens.js`：令牌管理页——创建（名称/级别/主机范围/有效期/矩阵）、列表、撤销、明文仅展示一次

**Checkpoint**: 令牌可用、可控、可审计。

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: 跨故事的收尾与门禁复核

- [ ] T087 [P] 全量测试执行（单元 + 集成 + 契约）并逐条核对宪法「开发工作流与质量门禁」6 条
- [ ] T088 [P] 性能实测并记录：SC-001（≤5s 出现提示符）、SC-002（≤200ms 回显），结果写入 `specs/001-webssh-base-terminal/` 验证记录
- [ ] T089 [P] 审计滚动与保留策略验证：`retentionDays`、`maxFileBytes` 生效，旧文件按策略清理
- [ ] T090 [P] 大输出体量下的前端可响应性与中断能力验证（FR-021，实现位于 T040 的分片节流，本任务为实测复核）
- [ ] T091 [P] 安全复核：宪法第 I 条逐条验证（Origin 校验、目标主机白名单、HostKey 校验、会话与用户绑定、路径穿越、明文凭据零出现），测试名引用条款编号
- [ ] T092 [P] 依赖纯净性复核：`npm install --omit=dev --no-optional` 可重复成功、无原生模块、无外部数据库/中间件
- [ ] T093 [P] 按 `quickstart.md` 第 1–10 节完整复跑一遍并记录结果
- [ ] T094 [P] 文档收尾：`README.md` 补充安装/配置/备份恢复说明，`packaging/fnos` 目录补充说明与安装验证步骤

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**：无依赖，可立即开始
- **Foundational (Phase 2)**：依赖 Setup 完成，**阻塞所有用户故事**
- **US1 (Phase 3)**：依赖 Foundational；US1 的独立验证通过 `tests/helpers/seed-host.js`（T033）提供主机，**不依赖 US2 界面**
- **US2 (Phase 4)**：依赖 Foundational；与 US1 无实现耦合（US1 只用 `GET /api/hosts`）
- **US3 (Phase 5)**：依赖 Foundational + US1（会话对象由 US1 创建）
- **US4 (Phase 6)**：依赖 Foundational + US1（审计事件由会话产生）
- **US5 (Phase 7)**：依赖 Foundational；建议在 US1–US4 完成后打包验证
- **US6 (Phase 8)**：依赖 Foundational + US1/US2（主机与连接能力）+ `src/ssh/policy.js` 路径部分（T024）
- **Polish (Phase 9)**：依赖全部目标故事完成

### User Story Dependencies

- **US1 (P1)**：Foundational 后可开始，无跨故事依赖
- **US2 (P1)**：Foundational 后可开始；测试、store 校验与管理页前端可与 US1 并行，但 T045 必须排在 T039 之后（同一文件 `src/api/hosts.js`，先建只读再扩展完整 CRUD）
- **US3 (P2)**：需 US1 的会话管理器（T037）
- **US4 (P2)**：需 US1 的会话事件（T041）
- **US5 (P2)**：需 Foundational 的适配层；端到端验证需 US1–US4
- **US6 (P2)**：需 US1/US2（主机与 SSH 执行）+ Foundational 的路径策略（T024）

### Within Each User Story

- 测试必须先写并确认失败（Red），再实现（Green）
- 契约/单元测试 → 集成测试 → 实现 → 前端接线 → 审计/日志接线
- 一个故事完整可测后再进入下一优先级

### Parallel Opportunities

- Phase 1 中 T002–T006 可并行
- Phase 2 中 T007–T013（测试）全部可并行；实现中 T016、T018、T025、T029 可并行
- US1 与 US2 在 Foundational 完成后可并行推进，唯一例外：US2 的 T045 必须排在 US1 的 T039 之后（同一文件 `src/api/hosts.js`）
- US3 与 US4 在 US1 完成后可并行推进
- Phase 7 中 T064–T067 可并行
- Phase 9 中标注 [P] 的任务基本可并行

---

## Parallel Example: User Story 1

```bash
# 测试（先写，确认失败）
Task: "tests/contract/ws-terminal.test.js 握手与帧契约"
Task: "tests/unit/ws-frame.test.js 帧编解码"
Task: "tests/integration/terminal-sshd.test.js 真实 sshd 全流程"
Task: "tests/helpers/seed-host.js 种子主机脚本"

# 实现（测试变红后再动手）
Task: "src/net/upgrade.js 升级与校验"
Task: "src/ssh/client.js SSH 连接与 shell"
Task: "src/ssh/hostkey.js known_hosts 校验"
Task: "src/session/manager.js 会话生命周期"
Task: "src/session/bridge.js WS↔SSH 转发"
Task: "web/src/terminal.js 终端页"
```

---

## Implementation Strategy

### MVP First（最小可交付）

1. 完成 Phase 1 Setup
2. 完成 Phase 2 Foundational（CRITICAL，阻塞一切）
3. 完成 Phase 3 US1（终端）+ T033 种子脚本
4. **STOP and VALIDATE**：用真实 sshd 验证连接、输入输出、resize、中断
5. 追加 Phase 4 US2（主机与凭据 CRUD）→ 此时产品已可日常使用
6. 依次追加 US3（会话清理）、US4（审计）、US5（双模式/打包）、US6（MCP 令牌）

### Incremental Delivery

1. Setup + Foundational → 基础就绪
2. + US1 → 可用终端（需种子主机）→ 可演示
3. + US2 → 主机与凭据自管理 → 真正的 MVP
4. + US3 → 无资源泄漏，可长期运行
5. + US4 → 可追溯
6. + US5 → 双形态交付（fnOS `.fpk` + standalone）
7. + US6 → AI 工具接入

### Parallel Team Strategy

1. 团队共同完成 Setup + Foundational
2. Foundational 完成后：
   - 开发者 A：US1 → US3
   - 开发者 B：US2 → US4（T045 待 A 完成 T039 后扩展 hosts API，测试与前端可先行）
   - 开发者 C：US5（打包与双模式）
   - US6 待 US1/US2 稳定后启动
3. 每个故事独立验证后再合并

---

## Notes

- [P] 任务 = 不同文件、无未完成依赖
- [Story] 标签用于需求可追溯（US1–US6 对应 spec.md 六个故事）
- 宪法第 V 条要求 TDD：每阶段测试任务必须先执行并确认失败
- 宪法第 VII 条：`src/runtime/` 是唯一允许读 `TRIM_*` 的模块，业务代码一律通过注入的 `Runtime` 访问
- 宪法第 VIII 条：禁止提前实现高级版能力（会话录像、命令拦截审批、授权矩阵、SQLite）
- 每个任务或逻辑组完成后提交 Git；安全相关改动提交信息标注 `[security]`
- 遇到任何 checkpoint 都可停下来独立验证当前故事
- 避免：跨故事的实现耦合、硬编码绝对路径、跳过 HostKey 校验、日志中出现凭据

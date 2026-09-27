# 基础版验证记录（Phase 9 / T087–T093）

**日期**：2026-09-27 | **执行环境**：macOS arm64 / Node 25.8.0 / 真实 OpenSSH sshd / 飞牛 fnOS amd64 设备

## T087 全量测试与质量门禁

| 套件 | 结果 |
|---|---|
| **全量** | **114/114 ✅（EXIT=0，串行全跑）** |
| 单元 | 72（runtime/加密/原子写/授权/路径策略/脱敏/帧/命令判定/矩阵/令牌/审计完备性/滚动/保留） |
| 契约 | 33（REST 主机/审计/MCP、WS 握手与关闭码） |
| 集成 | 9（真实 sshd：终端全流程、持久化重启、会话清理×4、并发上限、多会话隔离、MCP e2e） |

> 收尾期间修复两处真实缺陷：
> 1. **并发上限绕过**（session-limits 挂起的根因）：升级预检只统计已注册会话，并发连接在建连窗口内可绕过上限且永不收到 4004 → 引入同步名额预留（`tryReserve`）
> 2. **审计落盘竞态**：`app.close()` 后异步写盘与临时目录清理竞争（ENOTEMPTY）→ `audit.drain()` 在关闭前等待队列清空

**宪法质量门禁（6 条）逐条**：

1. 全部测试通过 → ✅（上述）
2. 无新增依赖或已论证 → ✅ 运行时依赖仅 ssh2/ws（MCP 端点为直接 JSON-RPC 实现，按第 VI 条 YAGNI 记录于提交 `5dbe515`）
3. 无硬编码路径 / 无业务直读 TRIM_* / 无明文凭据 / 无跳过 HostKey 校验 → ✅（适配层唯一入口；错误原因白名单化；指纹全等比对）
4. schema version 与迁移同步 → ✅（hosts/tokens/config/audit 均 version=1，迁移钩子在位）
5. 双模式冒烟 → ✅ standalone：全套 bsk 浏览器验收；fnos：TRIM_* 本地冒烟（unix socket + /api/runtime）+ 设备实装验证
6. 无越界功能 → ✅（无录像/拦截审批/授权矩阵/SQLite）

## T088 性能实测（scripts/perf-check.mjs，真实 sshd）

| 指标 | 要求 | 实测 | 结论 |
|---|---|---|---|
| SC-001 点击主机 → 终端就绪 | ≤ 5000ms | **70ms** | ✅ |
| SC-002 输入 → 回显 p50（5 次采样 10–16ms） | ≤ 200ms | **11ms** | ✅ |

## T090 大输出与中断（FR-021）

2,100,377 字节（~2MB）输出完整接收（前端 16ms 分片节流保持可响应）；SIGINT 中断后 **31ms** 恢复提示符。✅

## T091 安全复核：宪法第 I 条逐条

| 条款 | 验证 | 测试 |
|---|---|---|
| 凭据 AES-256-GCM 加密落盘 | ✅ | secret-crypto（往返/篡改/0700）、hosts-api（响应无明文） |
| WebSocket Origin 校验 | ✅ | ws-terminal（403/400 矩阵）；fnos 模式仅信网关凭证 |
| 目标主机仅限授权清单 | ✅ | host-authorization、ws 4003、MCP host_not_allowed |
| HostKey 禁止 InsecureIgnoreHostKey | ✅ | hostVerifier 全等比对；4005 未确认 / fingerprint_changed 拒绝 |
| 客户端输入不可信（穿越拒绝） | ✅ | path-policy（../、符号链接、通配敏感路径）、router 静态穿越防护 |
| 会话与用户强绑定 | ✅ | store ownerId 隔离（403）、审计 actor |
| 身份只信部署环境 | ✅ | auth.js（X-Trim-* / 登录会话）；MCP 仅信 Bearer 摘要比对 |

## T092 依赖纯净性

临时目录全新 `npm install --omit=dev --no-optional`：成功、**0 个 `.node` 原生模块**、ssh2/ws 可导入。✅

## T093 quickstart 复跑状态

| 节 | 状态 |
|---|---|
| 1 sshd 准备 | ✅（集成测试隔离实例） |
| 2 安装启动 standalone | ✅（bsk 全程基于此） |
| 3 主机与凭据管理 | ✅（创建/不回显/密文结构/删除） |
| 4 终端会话 | ✅（连接/命令/resize/中断/关闭清理） |
| 5 指纹确认 | ✅（4005 → 确认 → 变化拒绝路径已覆盖） |
| 6 审计 | ✅（69+ 条真实记录、导出可读、无明文） |
| 7 MCP 令牌 | ✅（创建一次性明文/只读隔离/撤销/敏感路径拒绝） |
| 8 fnOS 模式 | ✅（设备实装：.fpk 安装、桌面入口、网关访问） |
| 9 双模式一致性 | ✅（核心用例两模式均通过） |
| 10 清理 | ✅（临时目录自动清理） |

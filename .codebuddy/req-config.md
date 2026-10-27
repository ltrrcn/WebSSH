# webssh — 需求管理配置

> 本文件是 `req-lifecycle` Skill 的项目数据层（唯一真相源）。
> 修改团队/模块/规则只需改此文件，流程层自动适配。

## 1. 项目信息

- **项目名称**：webssh
- **项目简介**：网页端 SSH 终端，同时支持飞牛 fnOS 应用形态与通用 Linux 部署，零外部数据库
- **主技术栈**：Node.js >=22（原生 http + ws + ssh2，无框架）；前端原生 ES Module JS + xterm.js（vendored）
- **编码规范文档**：`specs/001-webssh-base-terminal/`（spec/数据模型/宪法式约束，新功能需对照）
- **API 文档获取方式**：源码扫描 `src/api/*.js` 路由定义（纯函数式 createXxxRoutes）

## 2. Issue 跟踪平台（tracker）

- **平台**：none（默认值，可修改——远端为 cnb.cool/slera/webssh，未接 NPC/CI 时本地跟踪）
- **验收方式**：人工验收后关闭

> tracker = none 时，需求仅本地跟踪（progress-tracker.md + 归档目录），跳过所有 Issue 操作。

## 3. 团队角色映射

| 角色 | 开发者 | 负责域 | 模块/目录 | 越界规则 |
|:---:|--------|--------|----------|:---:|
| A | slera | 全栈（单人项目） | 全部 | 可越界 |

## 4. 关键字 → 模块分流映射

| 关键字 | 模块/目录 | 负责角色 |
|--------|----------|:---:|
| 终端、会话、标签页、tmux | src/session/ + web/src/terminal.js | A |
| 主机、指纹、分组 | src/api/hosts.js + src/ssh/ + web/src/hosts.js | A |
| MCP、令牌、限流 | src/mcp/ + src/api/mcp-direct.js | A |
| 审计 | src/audit/ + web/src/audit.js | A |
| 设置、主题、快捷命令 | web/src/settings.js / theme.js / quick-commands*.js | A |
| 打包、部署 | packaging/ + scripts/ | A |

## 5. 优先级标准

| 优先级 | 判定标准 | 典型示例 |
|:---:|------|------|
| **P0** | 功能性 Bug、数据丢失、安全漏洞、生产阻断 | 连接泄漏、凭据泄露 |
| **P1** | 核心功能缺失、用户体验关键调整 | tmux 会话模式 |
| **P2** | 优化改进、渐进式迁移、非关键功能 | UI 细节调整 |
| **P3** | 技术债、代码清理、文档补充 | 注释、重构 |

## 6. 跨模块检查清单

**通用检查项**：
1. 数据库表结构变更（本项目为 JSON file-store，等价为数据模型字段变更）
2. API 契约变更（新增/修改/废弃端点）
3. 共享库/公共模块变更
4. 配置文件 / 环境变量变更
5. 权限 / 安全策略变更
6. 模块间调用关系变更

**项目自定义检查项**：
- WS 协议帧格式变更（`src/net/upgrade.js` / FrameType）
- 会话状态机变更（connecting → ready → closed）
- 审计事件类型新增/变更
- MCP 工具签名变更

## 7. 业务基线（不可静默修改的规则）

- 错误信息不得包含凭据（SC-010 白名单化，见 src/session/manager.js sanitizeFailure）
- 会话进入 closed 必须释放全部资源，残留进程数为 0（SC-005）
- known_hosts 仅为人工核对记录（R10），不作为安全判据
- 指纹未确认的 主机必须先人工确认才能连接
- packaging/ 是构建产物（build-fnos.sh rsync 覆盖），不改源码只同步
- specs/ 中已定稿的 spec 是既有功能的验收真相源

## 8. 版本发布规范

- **正式版分支**：main
- **预发布审批人**：无需审批
- **部署方式**：`npm run pack:fnos` 打包 fpk；本地 `npm start`
- **项目特定发布约束**：Node >=22；零外部数据库（file-store JSON）

## 9. 需求归档

- **归档目录**：`docs/requirements/`
- **编号前缀**：R（R001、R002 …）

## 10. 架构变动判定阈值

- 涉及数据模型字段变更
- 涉及 API 契约变更
- 涉及跨模块调用
- 新增服务/应用
- 涉及安全策略
- 单次改动超过 10 个文件

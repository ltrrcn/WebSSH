# R001 — tmux 会话模式（保活/复制/断线恢复 + 安装检测提示）

> 完成日期：2026-10-01 · 优先级：P1 · 状态：已完成

## 需求背景

webssh 原有「复制会话」（FR-052）仅新建独立 shell，无法实现屏幕同步与断线恢复现场。用户需要：正在远端执行的操作（如 /usr/local/services 下的服务命令），关闭标签后继续运行，重新打开的会话与之前保持一致。

## 方案

纯前端实现，零后端协议改动（探测/attach 命令以普通 DATA 帧发送，等同用户手敲，服务端审计天然留痕）：

1. **连接流程**：tmux 模式 WS 建立后发送 `tmux -V` 静默探测（输出喂状态机、不显示、输入忽略），确认可用后自动发送 `tmux new -A -s webssh`（存在 attach / 不存在创建）
2. **复制会话**：右键菜单对 tmux 会话显示「复制会话（tmux 同步）」，新标签 attach 同一远端会话，屏幕实时同步
3. **断线恢复**：Enter 重连 / 重新连接统一走 startTmuxProbe → 自动重新 attach，现场恢复
4. **缺失提示**：探测判定 `command not found`（中英文）→ 弹窗提示（含 apt/yum/apk/pacman 安装指引），当前标签退化为普通终端继续可用；4s 超时乐观 attach 兜底
5. **入口**：新建会话弹窗复选框「以 tmux 保活会话连接」；默认值进设置页「新建会话默认 tmux 保活」开关

## 改动文件

| 文件 | 类型 | 说明 |
|------|------|------|
| web/src/tmux.js | 新增 | 探测状态机 / 会话名净化（防 `:` `.` 注入 tmux target 语法）/ 命令构造 |
| web/src/terminal.js | 修改 | tmux 模式全流程（探测/attach/复制/恢复/关闭提示/探测期输入与快捷命令拦截） |
| web/src/prefs.js | 修改 | 新增 tmuxDefault 偏好 |
| web/src/settings.js | 修改 | 终端偏好区新增开关 |
| web/index.html | 修改 | picker 复选框与缺失提示样式 |
| tests/unit/tmux.test.js | 新增 | 14 用例：净化/命令构造/状态机（分片、防膨胀、中英文缺失文案） |

## 验收标准达成

- AC1 tmux 模式连接后 `tmux ls` 可见 webssh 会话 ✓
- AC2 关闭标签后远端会话存活，重连 attach 恢复现场 ✓
- AC3 复制会话双标签屏幕同步 ✓
- AC4 远端无 tmux 弹窗提示 + 普通模式降级继续 ✓
- AC5 普通会话不受影响；命令以输入流发送、连接级审计正常 ✓
- AC6 全量测试 149/149（unit 90 + contract 50 + integration 9），新增 14 用例 ✓

## 已知边界

- 会话名固定 `webssh`（同主机所有 tmux 标签共享同一会话），自定义会话名留待后续迭代
- 探测超时（4s）按乐观处理直接 attach，极慢远端下可能看到 shell 报错（无害）
- packaging/fnos/app 为构建产物，下次 `npm run pack:fnos` 自动同步

## 关键实现位置

- 探测启动：`terminal.js` connectWs → ws.onopen → startTmuxProbe
- 输出拦截判定：connectWs → ws.onmessage（detecting 分支）
- 状态机：`tmux.js` createTmuxDetector（正则去 `\b`，防截断窗口紧贴漏判）

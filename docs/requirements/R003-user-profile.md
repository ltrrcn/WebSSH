# R003 - 用户管理（个人设置：头像上传 + 昵称修改）

## 需求摘要

| 要素 | 内容 |
|------|------|
| 做什么 | 「个人设置」弹窗新增「用户管理」页签：① 从本地选择并上传头像；② 修改当前昵称（备注名）。飞牛账号本身不可修改，仅可调昵称 |
| 为什么 | 默认首字头像/账号名展示体验单一，支持个性化 |
| 涉及模块 | 后端 `src/api/profile.js`(新)、`src/store/file-store.js`、`src/net/server.js`；前端 `web/src/settings.js`、`app.js`、`contextmenu.js`、`user-profile.js`(新)、`icons.svg`、`index.html` |
| 变更类型 | UI + API + file-store 数据模型（新增 `etc/users.json` + `etc/avatars/`） |
| 验收标准 | ① 上传头像后左下角与用户菜单资料头即时显示图片头像；② 保存昵称后各处展示更新；③ fnOS 下账号名只读展示并提示不可修改；④ 未设置时回退现状（首字头像/账号名）；⑤ 头像支持 png/jpg/webp/gif ≤2MB，服务端 magic bytes 校验 |
| 优先级 | P2 |
| 协作者 | 无（单人项目） |

## 基线检查

- 无冲突：不触碰凭据/指纹/审计基线；头像上传严格 magic bytes + 2MB 上限 + 文件名哈希化（无路径穿越面）。
- 头像/昵称为低风险个人偏好数据，不纳入 2FA 高危保护动作清单。

## 设计要点

- **昵称/头像按用户 ID 隔离**：fnOS 多用户经网关 `X-Trim-Userid` 区分；standalone 恒为 `local`。
- **展示优先级**：昵称 > 账号名 > 用户 ID；头像 > 首字圆形。
- **账号只读**：所有模式下账号（username）均不可修改；fnOS 模式在 UI 明示"飞牛账号由 fnOS 系统管理"。
- **审计**：昵称修改/头像上传/删除记 `profile_update`/`avatar_upload`/`avatar_delete` 事件。

## 验收记录

- 见 `specs/002-user-profile/tasks.md` 与测试 `tests/contract/profile-api.test.js`。

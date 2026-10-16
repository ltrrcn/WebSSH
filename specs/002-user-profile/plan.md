# Plan 002 - 用户管理（头像 + 昵称）

## 后端

1. **store 扩展**（`src/store/file-store.js`）：新增 `usersFile`（etc/users.json）+ `avatarsDir`；`getUserProfile(ownerId)` / `saveUserProfile(record)`（nickname 校验：null 或 trim 后 0–32 字符）
2. **新路由模块**（`src/api/profile.js`）：
   - magic bytes 判定：PNG/JPEG/WebP/GIF → `{ ext, mime }`
   - `readRawBody(req, limit)` 本地实现（router 仅 JSON）
   - 头像落盘：`avatars/sha256(ownerId).ext`（tmp+rename 原子替换，先清旧扩展名文件）
   - 5 个端点见 spec；审计 `profile_update` / `avatar_upload` / `avatar_delete`
3. **注册**（`src/net/server.js`）：`...profileRoutes(deps)`

## 前端

4. **`web/assets/icons.svg`**：新增 `user` 图标 symbol
5. **`web/src/user-profile.js`（新）**：`renderUserProfilePane(pane, { onProfileChanged })`——头像预览/上传（FileReader→ArrayBuffer→POST 原始体）/移除；昵称编辑保存；账号只读 + fnOS 提示；统一用现成 pref-* CSS
6. **`web/src/settings.js`**：`PROFILE_TABS` 前插 `{ key:'user', label:'用户管理' }`，defaultPane='user'；buildPanes 增加 user 分支，injections 透传 `onProfileChanged`
7. **`web/src/app.js`**：`refreshUserDisplay()`（identity+runtime+profile 合并渲染，缓存穿透 v=avatarUpdatedAt）；`onProfileChanged` → 刷新；contextmenu profile 传 avatarUrl
8. **`web/src/contextmenu.js`**：profile 支持 `avatarUrl`（背景图渲染，回退 avatarText）
9. **`web/src/index.html`**：CSS `.user-avatar.img`（cover 填充）+ `.user-avatar.big`（56px 预览）

## 测试与文档

10. `tests/contract/profile-api.test.js`：GET/PUT 昵称（含非法值）、头像上传（真 PNG/非法字节/超限）、GET 字节回读、DELETE 幂等
11. `README.md`：功能一览 + 数据目录（users.json、avatars/）

## 风险与对策

- 头像上传 SSRF/穿越：无 URL 面；文件名哈希化；magic bytes 白名单
- 缓存陈旧：头像 URL 携带 `?v=<avatarUpdatedAt>` 缓存穿透
- modal 单例/页签切换：user pane 每次进入重新 fetch，无脏状态

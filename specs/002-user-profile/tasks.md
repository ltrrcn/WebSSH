# Tasks 002 - 用户管理（头像 + 昵称）

## Phase 1：后端
- [x] T1 store：users.json 存储 + getUserProfile/saveUserProfile（nickname 校验）
- [x] T2 api/profile.js：5 端点 + magic bytes 判定 + 原子落盘 + 审计
- [x] T3 server.js 注册路由

## Phase 2：前端
- [x] T4 icons.svg 新增 user 图标
- [x] T5 user-profile.js 用户管理页签
- [x] T6 settings.js 接入（PROFILE_TABS + injections 透传）
- [x] T7 app.js 左下角/菜单即时刷新
- [x] T8 contextmenu.js 支持 avatarUrl
- [x] T9 index.html CSS

## Phase 3：验证
- [x] T10 契约测试 profile-api.test.js（5/5 通过）
- [x] T11 npm test 回归：151/152 通过；唯一失败为存量问题（groups.js:65 注释含 ✓ 字符，宪法 IX 扫描，HEAD 即红，与本需求无关）
- [x] T12 README + progress-tracker 更新

## 端到端冒烟（standalone :8877）

- PUT 昵称「阿峰」→ 200，回读一致；非法字节 POST 头像 → 422 invalid_image
- GIF 上传 → GET avatar 200 image/gif；users.json 落盘结构正确（version/ownerId/nickname）
- DELETE 幂等，昵称保留；无头像 GET 404


# Spec 002 - 个人资料（头像 + 昵称）

> 需求编号：R003 ｜ 优先级：P2 ｜ 关联：docs/requirements/R003-user-profile.md

## 目标

在「个人设置」弹窗新增「个人资料」页签，支持：

1. 从本地上传头像（png/jpg/webp/gif，≤2MB），可移除
2. 修改当前用户的昵称（备注名）；账号（username）在所有模式下只读

## API 契约

所有端点要求认证（resolveIdentity），未认证 401；仅作用于当前身份，无跨用户面。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/profile` | — | `200 { id, username, nickname, hasAvatar, avatarUpdatedAt }`（nickname 无则 null） |
| PUT | `/api/profile` | `{ nickname: string }`（trim 后 0–32 字符；空串=清除昵称） | `200 { ok: true, nickname }`；非法 `422 invalid_field` |
| POST | `/api/profile/avatar` | 原始二进制图片体（≤2MB） | `200 { ok: true, avatarUpdatedAt }`；超限 `413 payload_too_large`；非图片 `422 invalid_image` |
| DELETE | `/api/profile/avatar` | — | `200 { ok: true }`（幂等） |
| GET | `/api/profile/avatar` | — | `200` 图片字节（Content-Type 按 magic bytes 判定类型；`no-cache`）；无头像 `404` |

安全约束：

- 图片类型由 **magic bytes 判定**（不信 Content-Type/文件名），扩展名由判定结果推导
- 头像文件名 = `sha256(ownerId).hex + '.' + ext`，杜绝路径穿越
- 响应带 `x-content-type-options: nosniff`
- 上传/删除走原子替换（tmp 写入 + rename），失败不破坏旧头像

## 数据模型

`etc/users.json`（file-store，schema v1）：

```json
{ "version": 1, "updatedAt": "…", "users": [
  { "ownerId": "local", "nickname": "张三", "avatarExt": "png", "avatarUpdatedAt": "…", "updatedAt": "…" }
] }
```

头像二进制：`etc/avatars/<sha256(ownerId)>.<ext>`（0700 目录）。

## UI 契约

- 「个人设置」页签集变为：**个人资料**（默认页签）/ MCP 令牌 / 令牌配置
- 个人资料页：头像预览（56px 圆形，无头像回退首字）+ 上传/移除；账号只读行；昵称输入 + 保存
- fnOS 模式明示："飞牛账号由 fnOS 系统管理，不可修改；昵称仅作为本应用内的展示备注名"
- 保存/上传成功后即时刷新：左下角用户入口、用户菜单资料头
- 展示名优先级：昵称 > username > id；无头像回退首字圆形

## 验收标准

- [ ] 上传 png 后：`GET /api/profile` hasAvatar=true；`GET /api/profile/avatar` 返回同字节且 Content-Type image/png
- [ ] 非图片字节上传 → 422；>2MB → 413
- [ ] 昵称：设置→读回一致；空串清除；>32 字符 → 422
- [ ] DELETE 头像后 GET 404（幂等）
- [ ] 前端：上传/改名后左下角与用户菜单即时更新；无头像/昵称时保持现状回退
- [ ] 全部现有测试通过（npm test 单元+契约）

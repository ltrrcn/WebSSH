# WebSSH UI 风格说明文档

> 适用范围：`web/index.html` 内联样式体系及其衍生页面。
> 本文档与 `docs/ui-style-demo.html`（静态演示页）配套，演示页为所有规范的视觉基准。

---

## 一、设计概览

WebSSH 是一款**面向开发者的终端管理工具**，整体风格为：克制的现代工具风——浅色为默认、低饱和灰蓝基调、单强调色（蓝色）、精细的微交互（聚焦光晕、扫描线、弹性指示条）、等宽字体点缀（地址/命令/时间）。

核心特征：

| 特征 | 说明 |
|------|------|
| 主题机制 | 三态（跟随系统 / 浅色 / 深色），`<html data-theme="dark|light">` 驱动，浅色为默认 |
| 基础字号 | **13px**（工具型紧凑密度），信息层级靠色彩弱化而非字号放大 |
| 强调色 | 单一蓝色系：浅色 `#2f6fed` / 深色 `#4f8dff`，配 `accent-soft` 半透明底 |
| 等宽字体 | Menlo，用于主机地址、命令、时间、ID 等机器数据 |
| 边框分层 | 弱边框 + 灰底分层代替重阴影；仅弹窗/菜单用投影 |
| 动效 | 短促（.12–.22s）、有物理感（active 缩放、弹性 cubic-bezier） |

---

## 二、设计令牌（Design Tokens）

所有颜色经 CSS 变量引用，**禁止硬编码色值**（代码窗口等独立子系统例外）。导入新配色 = 整组替换变量。

### 2.1 色彩令牌

| 令牌 | 浅色（默认） | 深色 | 用途 |
|------|------------|------|------|
| `--bg` | `#f4f6f9` | `#0e1116` | 页面最底层背景 |
| `--bg-panel` | `#ffffff` | `#151922` | 侧栏 / 弹窗 / 卡片面板 |
| `--bg-elevated` | `#ffffff` | `#1b2029` | 浮起元素（菜单、toast、图标按钮 hover） |
| `--bg-hover` | `#eef1f6` | `#20262f` | 行/项 hover 底色、表头底色 |
| `--bg-active` | `#e3e9f5` | `#2a3140` | 按下/选中态底色 |
| `--bg-input` | `#ffffff` | `#0e1116` | 输入框、列表容器 |
| `--term-bg` | `#fcfdff` | `#0a0c10` | 终端区（激活 tab 用它做"融合"） |
| `--border` | `#e3e7ed` | `#262c38` | 常规边框、分隔线 |
| `--border-strong` | `#ccd3dd` | `#343c4c` | hover 加深边框 |
| `--text` | `#22272f` | `#e8eaf0` | 主文字 |
| `--text-dim` | `#57606f` | `#9aa3b2` | 次要文字（描述、元信息） |
| `--text-faint` | `#8a94a4` | `#626c7d` | 弱化文字（占位、计数、表头） |
| `--accent` | `#2f6fed` | `#4f8dff` | 品牌强调色（选中、聚焦、链接） |
| `--accent-soft` | `rgba(47,111,237,.10)` | `rgba(79,141,255,.14)` | 强调色柔和底（选中行、徽章底） |
| `--accent-text` | `#ffffff` | `#ffffff` | 强调色上的文字 |
| `--ok` | `#0a8a5f` | `#3ecf8e` | 成功 / 在线 |
| `--warn` | `#b26b00` | `#f2b04d` | 警告 / 连接中 |
| `--danger` | `#d1242f` | `#f87171` | 危险 / 错误 |
| `--ok/warn/danger-soft` | 对应色 8–12% 透明度 | 同左 | 语义徽章底、危险按钮 hover 底 |
| `--tag-bg` | `#eef1f6` | `#20262f` | 中性徽章底 |

语义规则：
- 三级文字层级：`text` → `text-dim` → `text-faint`，严格递进使用，不新造灰色。
- 语义色永远成对使用：实色文字/边框 + soft 底（如 `.tag.ok { color: var(--ok); background: var(--ok-soft); }`）。

### 2.2 圆角

| 令牌 | 值 | 使用场景 |
|------|----|---------|
| `--radius-sm` | 6px | 小控件（图标按钮、小标签页、菜单项） |
| `--radius-md` | 8px | **主力圆角**：按钮、输入框、列表容器、行项 |
| `--radius-lg` | 12px | 大卡片、详情浮层 |
| （固定值） | 14px | 弹窗外框 |
| （固定值） | 999px / 50% | 胶囊（快捷命令、徽章）/ 圆形（头像、开关、圆点） |

### 2.3 阴影

| 令牌 | 浅色 | 深色 | 使用场景 |
|------|------|------|---------|
| `--shadow-sm` | `0 1px 2px rgba(31,42,66,.06)` | `0 1px 2px rgba(0,0,0,.3)` | 按钮、选中分段块 |
| `--shadow-md` | `0 4px 16px rgba(31,42,66,.08)` | `0 4px 16px rgba(0,0,0,.35)` | 悬浮小元素 |
| `--shadow-lg` | `0 16px 48px rgba(31,42,66,.14)` | `0 16px 48px rgba(0,0,0,.5)` | 弹窗、菜单、tooltip |

---

## 三、字体排印

```css
font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif;
/* 等宽：Menlo, Monaco, 'Courier New', monospace */
```

| 元素 | 字号 | 字重 | 备注 |
|------|-----|------|------|
| 正文/按钮/行项 | 13px | 400/500 | 基准 |
| 弹窗标题 | 15px | 600 | |
| 空态标题 | 14–16px | 500/600 | |
| 元信息（host-meta 等） | 11px | 400 | 等宽 |
| 徽章 `.tag` | 10px | 400 | |
| 表头/分节标题 | 10.5–11px | 500/600 | `text-faint` + `letter-spacing: .05–.06em`，常配大写 |
| 品牌副标题 | 9.5px | 500 | `letter-spacing: .14em`（TERMINAL） |

时间/计数使用 `font-variant-numeric: tabular-nums` 防抖动；等宽内容超出用 `ellipsis` 三件套截断。

---

## 四、布局体系

```
┌─────────┬──────────────────────────┐
│ sidebar │ tabbar (40px)            │
│ 264px   ├──────────────────────────┤
│ 固定宽  │ 终端区 / 空态（flex:1）    │
│         │ 底部：快捷命令栏           │
└─────────┴──────────────────────────┘
```

- 侧栏 `264px` 固定宽（`min-width` 同值防压缩），`bg-panel` 底 + 右侧 1px 边框。
- 弹窗双栏范式（设置/会话表单）：左侧窄导航（128–148px，`--bg` 底）+ 右侧内容面板，弹窗固定 `960×620`，`max-width: 95vw; max-height: 90vh` 自适应；≤640px 时导航转横向顶栏。
- 列表行规范：行 `padding 8–13px 14–16px`，行间 1px `--border` 分隔（末行去边），hover `--bg-hover`。
- 表格范式：表头与数据行共用同一 `grid-template-columns`（列宽两处同步），表头 `sticky` + `--bg-hover` 底 + 11px faint 字。

---

## 五、组件规范

### 5.1 按钮 `.btn`

- 默认：`bg-elevated` 底 + 1px `--border` 边 + `radius-md` + `shadow-sm`，`padding: 7px 18px`，13px/500。
- `.primary`：`--accent` 实底 + `--accent-text` 白字；hover `brightness(1.08)` + `0 4px 14px accent-soft` 投影。
- `.danger-solid`：danger 实底白字；`.danger-text`：仅文字变 danger。
- 通用：`active: scale(.97)`；disabled `opacity: .6`。
- 图标按钮 `.icon-btn`：无边框透明底，hover 才浮出 `bg-elevated` + `shadow-sm`；danger 变体 hover 红。

### 5.2 徽章 `.tag`

胶囊形（`border-radius: 10px`），10px 字 + `2px 8px` 内边距；变体 `ok/warn/danger/pinned/closed` = 语义色 + 对应 soft 底；中性 = `tag-bg` 底 + `text-dim`。

### 5.3 输入框（特色：聚焦扫描线）

```css
/* 常态：1px --border + 轻微内凹 inset 阴影 */
/* hover：边框加深为 --border-strong */
/* 聚焦：双层光晕 + 底部扫描线从左向右铺满 */
:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft), 0 0 20px var(--accent-soft);
  background-size: 100% 2px; /* 借 background-image 渐变线动画实现 */
}
caret-color: var(--accent); /* 光标跟主题色 */
```

select 去原生箭头，内嵌 SVG chevron（常态灰 `#8a94a4`，hover/focus 蓝色）。

### 5.4 开关 `.switch`

36×20px 胶囊；关闭态 `--bg-hover` 底 + faint 圆点（14px）；开启态 `--accent` 实底 + 白点右移 16px；过渡 `.15s ease`。

### 5.5 分段选择器 `.seg` / `.ctx-theme-switch`

外框 = 输入框同款；内 `3px` 间距分格；选中块 `--accent` 实底白字（同心圆角：外 8 = 内 5 + 3）。右键菜单内变体带**滑动指示块**（`.anim` 时 `transform/width .28s cubic-bezier(.4,0,.2,1)`）。

### 5.6 弹窗 `.modal`

- 遮罩：`rgba(6,8,12,.55)` + `backdrop-filter: blur(5px)`。
- 面板：`bg-panel` + 1px 边 + **14px 圆角** + `shadow-lg`；入场 `modalIn .18s cubic-bezier(.2,.9,.3,1.2)`（缩放 .96 → 1，带回弹）。
- 标题栏 15px/600；设置/表单弹窗标题栏铺 `--bg` 灰底与左栏连成一体。

### 5.7 确认弹窗 / Toast / Tooltip

- 确认弹窗 400px，头部 32px 圆形徽章（accent-soft 底 + accent 图标，danger 变体红色）。
- Toast：右下角浮出，`bg-elevated` + `border-strong`，`translateY(6px)` 淡入，语义色图标。
- 快速提示 `.fast-tip`：fixed 定位跟随元素，等宽字体，无原生 title 的 1s 延迟。

### 5.8 树形分组列表（侧栏）

- 分组头：11px/600 faint + chevron 旋转动画（`.22s`）。
- 折叠动画：`grid-template-rows: 1fr → 0fr` 过渡（不依赖 max-height）。
- 子项缩进 10px + `::before` 竖向引导线（1.5px `--border`）。
- 连接指示：行左缘 3px `--ok` 竖条，高度 0 → 60% 展开。

### 5.9 会话标签 `.tab`

卡片式上圆角（`radius-md radius-md 0 0`），激活态底色 = `--term-bg` 与终端区融合 + 顶部 2px accent 指示条；状态圆点 7px（ok/warn，连接中 `pulse 1.4s` 呼吸）。

### 5.10 代码窗口 `.tc-code-win`

Mac 窗口风格：交通灯三圆点（`#ff5f57/#febc2e/#28c840`）+ 等宽标题栏 + 复制按钮；语法配色独立子系统——浅色 VS Code Light（键 `#0451a5`、串 `#a31515`），深色 GitHub Dark（键 `#79c0ff`、串 `#7ee787`）。

### 5.11 上下文菜单 `.ctx-menu`

`radius 10px` + `shadow-lg`，项 `radius 7px`、13px；danger 项红字 + danger-soft hover 底；分隔线 `1px --border`；入场 `scale(.96) translateY(-2px)` .12s。

---

## 六、动效规范

| 场景 | 时长/曲线 |
|------|----------|
| 通用状态过渡（颜色/背景/边框/阴影） | `.15s ease` |
| 微交互（菜单项、小按钮） | `.12s ease` |
| 输入框边框/光晕/扫描线 | `.18s ease`（扫描线 `.26s`） |
| 面板切换/树折叠/行内编辑展开 | `.2–.22s ease` |
| 弹窗入场 | `.18s cubic-bezier(.2,.9,.3,1.2)`（回弹） |
| 弹窗滚轮互切 | `.45–.6s ease`，沿方向 ±14px 位移淡入淡出 |
| 按下反馈 | `transform: scale(.97)`，`.1s` |
| 呼吸（连接中） | `pulse 1.4s ease-in-out infinite`，50% 处 opacity .35 |
| 列表项入场 | `translateY(4–6px)` 淡入，`.28–.3s` |
| 导航激活指示条 | 弹性 `cubic-bezier(.3,1.4,.5,1)` scaleY 展开 |

原则：动效服务于状态反馈，不做装饰性动画；所有过渡只过渡颜色类属性与 transform，避免布局属性。

---

## 七、无障碍与细节

- `:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }`
- `color-scheme` 随主题切换（原生控件/滚动条同步明暗）。
- 滚动条：8px，thumb = `--border`（hover 加深），圆角 4px，透明轨道。
- `hidden` 属性用 `display: none !important` 兜底，优先级高于任何 display。
- 禁用态保持可见（`opacity .35–.6` + not-allowed），不隐藏，避免"以为丢了"。

---

## 八、主题机制（`web/src/theme.js`）

- 模式：`auto | dark | light`，localStorage `webssh-theme-mode` 持久化，**默认浅色**。
- `auto` 模式监听 `prefers-color-scheme` 实时跟随。
- 落地方式：`document.documentElement.dataset.theme = name`；`xterm` 终端配色经 `TERMINAL_THEMES` 注册表同步映射（扩展点：加条目即可导入 iTerm 配色）。
- 新增主题的正确姿势：只加 CSS 变量组 + 注册表条目，**不改组件样式**。

---

## 九、速查：新页面/新组件检查清单

1. 颜色是否全部走 CSS 变量？（grep 检查无裸 `#hex`）
2. 圆角是否用 `--radius-*` 令牌？
3. hover/active/focus 三态是否齐全且用语义令牌？
4. 等宽数据（地址/命令/时间/ID）是否用了 Menlo + ellipsis 截断？
5. 列表行是否遵循分隔线 + hover 底 + 末行去边范式？
6. 动效时长是否落在 .12–.22s 区间、只过渡颜色与 transform？
7. 深/浅两主题下都验证过对比度？
8. 交互反馈是否有按下缩放 / 聚焦光晕等既定微交互？

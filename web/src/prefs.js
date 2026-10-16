// 用户偏好（通用设置）：localStorage 持久化 + 变更订阅
// 与主题（webssh-theme）平行的前端偏好，不改服务端配置（服务端 config 由管理员文件维护）
const KEY = 'webssh-prefs';

const DEFAULTS = {
  fontSize: 13, // 终端字号（px）
  cursorBlink: true, // 终端光标闪烁
  exitConfirm: true, // 关闭页面前确认仍有活动会话（FR-046 的用户开关）
  tmuxDefault: false, // 新建会话默认勾选 tmux 保活模式（R001）
  fontFamily: '', // 界面字体（'' = 系统默认）
  quickCmdMaxChars: 24, // 右键「保存为快捷命令」选中文本的最大字符数（上限 128）
};

/** 系统默认字体栈：与 index.html 中 --app-font 兜底值保持一致 */
export const SYSTEM_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif';

/** 可选界面字体注册表：value 为完整 font-family 栈（带各自回退），label 用于设置面板 */
export const FONT_OPTIONS = [
  { value: '', label: '系统默认' },
  { value: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif', label: '苹方' },
  { value: '"Microsoft YaHei", "PingFang SC", sans-serif', label: '微软雅黑' },
  { value: '"Noto Sans SC", "Source Han Sans SC", "PingFang SC", sans-serif', label: '思源黑体' },
  { value: 'Menlo, Monaco, "Courier New", monospace', label: '等宽（Menlo）' },
];

/** 全局应用界面字体：写入 CSS 变量 --app-font，index.html body 引用该变量 */
function applyFont(value) {
  const stack = FONT_OPTIONS.some((o) => o.value === value) ? value : '';
  document.documentElement.style.setProperty('--app-font', stack || SYSTEM_FONT_STACK);
}

function read() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function getPrefs() {
  return read();
}

export function setPref(name, value) {
  const all = read();
  all[name] = value;
  localStorage.setItem(KEY, JSON.stringify(all));
  listeners.forEach((fn) => fn(name, value, all));
}

const listeners = new Set();
/** 订阅偏好变更（terminal 等模块动态应用） */
export function onPrefsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// 模块加载即应用已保存的界面字体，并订阅后续变更即时生效
applyFont(read().fontFamily);
onPrefsChange((name, value) => {
  if (name === 'fontFamily') applyFont(value);
});

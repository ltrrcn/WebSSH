// 主题管理（FR-048）：黑/白双主题 + localStorage 持久化 + xterm 主题映射
// 扩展点：TERMINAL_THEMES 注册表——后续导入 iTerm 等配色时只需往注册表加条目，
// 不需要改动主题切换机制本身（宪法 VIII：允许预留，禁止预建）。

const STORAGE_KEY = 'webssh-theme';
export const THEMES = ['dark', 'light'];

/** 终端配色注册表：key = 主题名；导入外部配色文件的扩展点 */
export const TERMINAL_THEMES = {
  dark: {
    background: '#0d0f12',
    foreground: '#e6e6e6',
    cursor: '#e6e6e6',
    cursorAccent: '#0d0f12',
    selectionBackground: '#2f6fed55',
  },
  light: {
    background: '#ffffff',
    foreground: '#1f2328',
    cursor: '#1f2328',
    cursorAccent: '#ffffff',
    selectionBackground: '#2f6fed44',
  },
};

export function currentTheme() {
  const saved = localStorage.getItem(STORAGE_KEY);
  return THEMES.includes(saved) ? saved : 'dark';
}

export function applyTheme(name) {
  if (!THEMES.includes(name)) return;
  document.documentElement.dataset.theme = name;
  localStorage.setItem(STORAGE_KEY, name);
}

export function initTheme() {
  applyTheme(currentTheme());
}

/** 当前主题对应的 xterm 配色（FR-048：终端主题随全局主题） */
export function xtermTheme(name = currentTheme()) {
  return TERMINAL_THEMES[name] ?? TERMINAL_THEMES.dark;
}

/** 主题变化订阅（终端 tab 需要跟随刷新配色） */
const listeners = new Set();
export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setTheme(name) {
  applyTheme(name);
  for (const fn of listeners) fn(name);
}

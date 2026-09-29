// 主题管理（FR-048）：三态模式（跟随系统 / 浅色 / 深色）+ localStorage 持久化 + xterm 主题映射
// - 默认浅色：未做过任何选择时以浅色启动
// - 用户主动选择跟随系统/浅色/深色：持久生效，刷新与其他操作均保持
// 扩展点：TERMINAL_THEMES 注册表——后续导入 iTerm 等配色时只需往注册表加条目，
// 不需要改动主题切换机制本身（宪法 VIII：允许预留，禁止预建）。

const MODE_KEY = 'webssh-theme-mode'; // 'auto' | 'dark' | 'light'
const LEGACY_KEY = 'webssh-theme'; // 旧版双态键，迁移为 mode
export const THEME_MODES = ['auto', 'dark', 'light'];
export const THEMES = ['dark', 'light']; // 实际主题（兼容既有引用）

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

/** 用户选择的模式（auto/dark/light）；旧版双态键迁移，默认浅色 */
export function currentThemeMode() {
  const mode = localStorage.getItem(MODE_KEY);
  if (THEME_MODES.includes(mode)) return mode;
  const legacy = localStorage.getItem(LEGACY_KEY);
  if (THEMES.includes(legacy)) {
    localStorage.setItem(MODE_KEY, legacy);
    return legacy;
  }
  return 'light';
}

function systemPrefersDark() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
}

/** 当前实际生效主题（dark/light）：auto 模式下由系统偏好决定 */
export function currentTheme() {
  const mode = currentThemeMode();
  return mode === 'auto' ? (systemPrefersDark() ? 'dark' : 'light') : mode;
}

function applyTheme(name) {
  document.documentElement.dataset.theme = name;
}

export function initTheme() {
  applyTheme(currentTheme());
  // 跟随系统：系统切换明暗时，仅 auto 模式实时跟随
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (currentThemeMode() === 'auto') {
      const t = currentTheme();
      applyTheme(t);
      for (const fn of listeners) fn(t);
    }
  });
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

/** 设置主题模式（auto/dark/light）：持久化并立即生效 */
export function setTheme(mode) {
  const m = THEME_MODES.includes(mode) ? mode : 'light';
  localStorage.setItem(MODE_KEY, m);
  const t = currentTheme();
  applyTheme(t);
  for (const fn of listeners) fn(t);
}

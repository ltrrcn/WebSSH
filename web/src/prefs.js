// 用户偏好（通用设置）：localStorage 持久化 + 变更订阅
// 与主题（webssh-theme）平行的前端偏好，不改服务端配置（服务端 config 由管理员文件维护）
const KEY = 'webssh-prefs';

const DEFAULTS = {
  fontSize: 13, // 终端字号（px）
  cursorBlink: true, // 终端光标闪烁
  exitConfirm: true, // 关闭页面前确认仍有活动会话（FR-046 的用户开关）
  tmuxDefault: false, // 新建会话默认勾选 tmux 保活模式（R001）
};;

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

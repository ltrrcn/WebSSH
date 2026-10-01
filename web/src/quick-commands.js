// 快捷命令（终端底部命令栏）：localStorage 持久化 + 变更订阅
// 前端偏好（与主题/字号同级）；命令内容由用户自身保存，点击发送即执行（含回车）
const KEY = 'webssh-quick-cmds';
const listeners = new Set();

export function getQuickCommands() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function persist(list) {
  localStorage.setItem(KEY, JSON.stringify(list));
  for (const fn of listeners) fn(list);
}

export function addQuickCommand(name, cmd) {
  const list = getQuickCommands();
  list.push({ id: `qc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: name.trim(), cmd });
  persist(list);
}

export function removeQuickCommand(id) {
  persist(getQuickCommands().filter((c) => c.id !== id));
}

/** R002 编辑快捷命令：按 id 更新名称/命令，任一字段传 null 表示保持不变 */
export function updateQuickCommand(id, { name, cmd }) {
  const list = getQuickCommands();
  const item = list.find((c) => c.id === id);
  if (!item) return false;
  if (name != null) {
    const v = String(name).trim();
    if (v) item.name = v;
  }
  if (cmd != null) {
    const v = String(cmd).trim();
    if (v) item.cmd = v;
  }
  persist(list);
  return true;
}

export function onQuickCommandsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// 快捷命令（终端底部命令栏）：localStorage 持久化 + 变更订阅
// 防逆向：命令明文不回填界面——编辑只能覆盖（cmd 传 null 表示保持原值）；点击发送为掩码执行
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

/** 自动编号名：快捷命令1、2、3…（跳过已被占用的编号） */
export function nextQuickCommandName() {
  const list = getQuickCommands();
  const names = new Set(list.map((c) => c.name));
  let n = list.length + 1;
  while (names.has(`快捷命令${n}`)) n++;
  return `快捷命令${n}`;
}

/** 覆盖更新：name 可回填修改；cmd 传 null/空表示保持原命令（原值不回界面，防泄露） */
export function updateQuickCommand(id, { name, cmd }) {
  const list = getQuickCommands();
  const item = list.find((c) => c.id === id);
  if (!item) return false;
  if (name != null) {
    const v = String(name).trim();
    if (v) item.name = v;
  }
  if (typeof cmd === 'string' && cmd.trim()) item.cmd = cmd.trim();
  persist(list);
  return true;
}

export function onQuickCommandsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

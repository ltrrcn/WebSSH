// 应用基址（T069：统一网关前缀适配）
// standalone 下为 '/'，fnOS 统一网关下为 '/app/webssh/'
export const APP_BASE = (() => {
  const p = location.pathname;
  return p.endsWith('/') ? p : p + '/';
})();

export function apiUrl(path) {
  return `${APP_BASE}api/${path}`;
}

export function wsUrl(path) {
  return (
    (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + APP_BASE + path
  );
}

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

// 运行时信息（/api/runtime：mode = fnos | standalone），缓存 Promise 避免重复请求
let runtimePromise = null;
export function getRuntime() {
  if (!runtimePromise) {
    runtimePromise = fetch(apiUrl('runtime'))
      .then((r) => (r.ok ? r.json() : { mode: 'standalone' }))
      .catch(() => ({ mode: 'standalone' }));
  }
  return runtimePromise;
}

// 当前请求者身份（/api/auth/me），缓存 Promise；失败回退占位，不阻塞 UI
let identityPromise = null;
export function getIdentity() {
  if (!identityPromise) {
    identityPromise = fetch(apiUrl('auth/me'))
      .then((r) => (r.ok ? r.json() : { id: '—', username: null, isAdmin: false }))
      .catch(() => ({ id: '—', username: null, isAdmin: false }));
  }
  return identityPromise;
}

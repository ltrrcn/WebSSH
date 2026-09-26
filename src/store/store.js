// 存储接口定义（宪法第 VIII 条：store 接口稳定，高级版可替换为 SQLite 实现）
// 高级版替换实现时必须保持以下方法签名不变；基础版唯一实现见 file-store.js。

/**
 * Store 接口（JSDoc 契约）：
 *
 * —— 主机（hosts.json）——
 * listHosts(ownerId): Promise<Host[]>                     // 仅本人条目
 * getHost(id, ownerId): Promise<Host | undefined>        // 归属校验后返回
 * getHostById(id): Promise<Host | undefined>             // 不做归属校验（内部使用）
 * saveHosts(hosts): Promise<void>                        // 整体保存（原子写 + .bak）
 * upsertHost(host): Promise<Host>                        // 新增或更新（含 validateHost）
 * deleteHost(id, ownerId): Promise<boolean>
 * validateHost(host): Host                                // 同步校验，非法即抛错
 * touchHost(id, patch): Promise<void>                    // 局部更新（lastUsedAt / fingerprint 等）
 *
 * —— MCP 令牌（tokens.json，US6 使用）——
 * listTokens(ownerId): Promise<Token[]>
 * getTokenById(id): Promise<Token | undefined>
 * saveTokens(tokens): Promise<void>
 *
 * —— 元信息 ——
 * hostsFile: string
 * tokensFile: string
 */

/** 供实现与测试核对的接口方法清单 */
export const STORE_INTERFACE = {
  hosts: [
    'listHosts',
    'getHost',
    'getHostById',
    'saveHosts',
    'upsertHost',
    'deleteHost',
    'validateHost',
    'touchHost',
  ],
  tokens: ['listTokens', 'getTokenById', 'saveTokens'],
  meta: ['hostsFile', 'tokensFile'],
};

/**
 * 校验一个对象是否满足 Store 接口形状（高级版替换实现时的准入检查）。
 */
export function assertStoreShape(store, label = 'store') {
  const missing = [];
  for (const group of Object.values(STORE_INTERFACE)) {
    for (const method of group) {
      if (typeof store[method] !== 'function' && !(method in store)) {
        missing.push(method);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(`${label} 不满足 Store 接口，缺失: ${missing.join(', ')}`);
  }
}

// 文件存储实现（hosts.json / tokens.json），Store 接口见 store.js
// 顶层 version + 迁移钩子（宪法 IV / VIII）；读取走 .bak 回退（FR-017）
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { atomicWriteFile, readJsonWithFallback } from './atomic.js';

const SCHEMA_VERSION = 1;

/** host 字段允许的形态：域名或 IP 字面量，禁止分隔符与空白（contracts/rest-api.md） */
const HOSTNAME_RE = /^[A-Za-z0-9._-]+$/;

/** 已知迁移函数：version -> 迁移动作（当前仅 1，无迁移） */
const MIGRATIONS = {
  1: (data) => data,
};

function migrate(data, file) {
  const version = Number(data?.version) || 0;
  if (version > SCHEMA_VERSION) {
    throw new Error(`${file} schema 版本（${version}）高于当前程序支持（${SCHEMA_VERSION}），拒绝加载`);
  }
  let out = data;
  for (let v = version || 1; v < SCHEMA_VERSION; v++) {
    if (MIGRATIONS[v]) out = MIGRATIONS[v](out);
  }
  out.version = SCHEMA_VERSION;
  return out;
}

export function createFileStore({ configDir, now = () => new Date().toISOString() }) {
  const hostsFile = join(configDir, 'hosts.json');
  const tokensFile = join(configDir, 'tokens.json');

  // 进程内缓存：启动后读一次，写操作「改内存 + 排队落盘」
  let hostsCache = null;
  let tokensCache = null;

  async function loadHosts() {
    if (hostsCache) return hostsCache;
    let data;
    try {
      data = await readJsonWithFallback(hostsFile);
    } catch (err) {
      if (err.code === 'ENOENT') {
        hostsCache = [];
        return hostsCache;
      }
      throw err;
    }
    data = migrate(data, 'hosts.json');
    hostsCache = Array.isArray(data.hosts) ? data.hosts : [];
    return hostsCache;
  }

  async function persistHosts() {
    hostsCache = hostsCache || [];
    await atomicWriteFile(
      hostsFile,
      JSON.stringify({ version: SCHEMA_VERSION, updatedAt: now(), hosts: hostsCache }, null, 2)
    );
  }

  // —— 主机 ——
  async function listHosts(ownerId) {
    return (await loadHosts()).filter((h) => h.ownerId === ownerId);
  }

  async function getHost(id, ownerId) {
    return (await loadHosts()).find((h) => h.id === id && h.ownerId === ownerId);
  }

  async function getHostById(id) {
    return (await loadHosts()).find((h) => h.id === id);
  }

  async function saveHosts(hosts) {
    for (const h of hosts) validateHost(h);
    hostsCache = hosts;
    await persistHosts();
  }

  function validateHost(host) {
    if (!host || typeof host !== 'object') throw new Error('host 条目无效');
    const name = typeof host.name === 'string' ? host.name : '';
    if (name.length < 1 || name.length > 64) {
      throw new Error('name 必须为 1–64 字符的非空字符串');
    }
    if (typeof host.host !== 'string' || !HOSTNAME_RE.test(host.host)) {
      throw new Error(`host 非法（仅允许域名或 IP 字面量）: ${JSON.stringify(host.host)}`);
    }
    const port = Number(host.port ?? 22);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('port 必须为 1–65535 的整数');
    }
    if (typeof host.username !== 'string' || host.username === '') {
      throw new Error('username 必须为非空字符串');
    }
    if (host.authType !== 'password' && host.authType !== 'privateKey') {
      throw new Error('authType 必须为 password 或 privateKey');
    }
    return host;
  }

  async function upsertHost(host) {
    validateHost(host);
    const hosts = await loadHosts();
    const idx = hosts.findIndex((h) => h.id === host.id);
    if (idx >= 0) hosts[idx] = host;
    else hosts.push(host);
    await persistHosts();
    return host;
  }

  async function deleteHost(id, ownerId) {
    const hosts = await loadHosts();
    const idx = hosts.findIndex((h) => h.id === id && h.ownerId === ownerId);
    if (idx < 0) return false;
    hosts.splice(idx, 1);
    await persistHosts();
    return true;
  }

  async function touchHost(id, patch) {
    const hosts = await loadHosts();
    const h = hosts.find((x) => x.id === id);
    if (!h) return false;
    Object.assign(h, patch, { updatedAt: now() });
    await persistHosts();
    return true;
  }

  /** 分组集合操作（contracts/rest-api.md 分组节）：仅作用于 ownerId 的主机，单次原子落盘 */
  async function updateHostsGroup(ownerId, fromGroup, toGroup) {
    const hosts = await loadHosts();
    let moved = 0;
    for (const h of hosts) {
      if (h.ownerId === ownerId && h.group === fromGroup) {
        h.group = toGroup; // string（重命名/合并）或 null（删除 → 回默认分组）
        h.updatedAt = now();
        moved++;
      }
    }
    if (moved) await persistHosts();
    return moved;
  }

  // —— MCP 令牌（US6 使用，接口先行保证可替换性）——
  async function loadTokens() {
    if (tokensCache) return tokensCache;
    let data;
    try {
      data = await readJsonWithFallback(tokensFile);
    } catch (err) {
      if (err.code === 'ENOENT') {
        tokensCache = [];
        return tokensCache;
      }
      throw err;
    }
    data = migrate(data, 'tokens.json');
    tokensCache = Array.isArray(data.tokens) ? data.tokens : [];
    return tokensCache;
  }

  async function persistTokens() {
    tokensCache = tokensCache || [];
    await atomicWriteFile(
      tokensFile,
      JSON.stringify({ version: SCHEMA_VERSION, updatedAt: now(), tokens: tokensCache }, null, 2)
    );
  }

  async function listTokens(ownerId) {
    return (await loadTokens()).filter((t) => t.ownerId === ownerId);
  }

  async function listTokensAll() {
    return await loadTokens();
  }

  async function getTokenById(id) {
    return (await loadTokens()).find((t) => t.id === id);
  }

  async function touchToken(id, patch) {
    const tokens = await loadTokens();
    const t = tokens.find((x) => x.id === id);
    if (!t) return false;
    Object.assign(t, patch);
    await persistTokens();
    return true;
  }

  async function saveTokens(tokens) {
    tokensCache = tokens;
    await persistTokens();
  }

  return {
    hostsFile,
    tokensFile,
    listHosts,
    getHost,
    getHostById,
    saveHosts,
    upsertHost,
    deleteHost,
    validateHost,
    touchHost,
    updateHostsGroup,
    listTokens,
    listTokensAll,
    getTokenById,
    touchToken,
    saveTokens,
  };
}

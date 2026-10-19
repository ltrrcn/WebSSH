// 文件存储实现（hosts.json / tokens.json），Store 接口见 store.js
// 顶层 version + 迁移钩子（宪法 IV / VIII）；读取走 .bak 回退（FR-017）
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
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
  const groupsFile = join(configDir, 'groups.json');
  const usersFile = join(configDir, 'users.json');
  const avatarsDir = join(configDir, 'avatars');

  // 进程内缓存：启动后读一次，写操作「改内存 + 排队落盘」
  let hostsCache = null;
  let tokensCache = null;
  let groupsCache = null;
  let usersCache = null;

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
    if (host.authType !== 'password' && host.authType !== 'privateKey' && host.authType !== 'none') {
      throw new Error('authType 必须为 password、privateKey 或 none');
    }
    if (host.connectVia !== undefined && host.connectVia !== 'direct' && host.connectVia !== 'jump') {
      throw new Error('connectVia 必须为 direct 或 jump');
    }
    // 授权范围（all/terminal/mcp）：缺省记录按 all 处理，显式值必须合法
    if (host.scope !== undefined && !['all', 'terminal', 'mcp'].includes(host.scope)) {
      throw new Error(`scope 必须为 all、terminal 或 mcp: ${JSON.stringify(host.scope)}`);
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

  /**
   * 不可逆清除全部主机连接（所有 owner）：删除 hosts.json 及 .bak/.tmp，
   * 并清空内存缓存。不走 saveHosts([])（那会留一代 .bak，可被恢复）。
   * 仅供 2FA 恢复保护触发（api/twofa.js），其余场景禁止调用。
   */
  async function wipeHosts() {
    hostsCache = [];
    const targets = [hostsFile, `${hostsFile}.bak`, `${hostsFile}.tmp`];
    for (const f of targets) {
      try {
        await rm(f, { force: true });
      } catch {
        /* 尽力删除；失败由调用方审计 */
      }
    }
  }

  // —— 分组实体（groups.json：分组是独立实体，支持新建/排序；default 为内置不落盘） ——

  async function loadGroups() {
    if (groupsCache) return groupsCache;
    let data;
    try {
      data = await readJsonWithFallback(groupsFile);
    } catch (err) {
      if (err.code === 'ENOENT') {
        groupsCache = [];
        return groupsCache;
      }
      throw err;
    }
    data = migrate(data, 'groups.json');
    groupsCache = Array.isArray(data.groups) ? data.groups : [];
    return groupsCache;
  }

  async function persistGroups() {
    groupsCache = groupsCache || [];
    await atomicWriteFile(
      groupsFile,
      JSON.stringify({ version: SCHEMA_VERSION, updatedAt: now(), groups: groupsCache }, null, 2)
    );
  }

  /** 分组列表（按 order 排序）：仅该 owner 的实体分组；default 由接口层恒定前置 */
  async function listGroups(ownerId) {
    return (await loadGroups())
      .filter((g) => g.ownerId === ownerId)
      .sort((a, b) => a.order - b.order);
  }

  /** 新建分组实体：order 取该 owner 现有最大值 +1 */
  async function createGroupEntity(ownerId, name) {
    const groups = await loadGroups();
    const mine = groups.filter((g) => g.ownerId === ownerId);
    const order = mine.length ? Math.max(...mine.map((g) => g.order)) + 1 : 1;
    const entry = { name, order, ownerId, createdAt: now() };
    groups.push(entry);
    await persistGroups();
    return entry;
  }

  /** 删除分组实体（主机归属由调用方另行处理） */
  async function removeGroupEntity(ownerId, name) {
    const groups = await loadGroups();
    const idx = groups.findIndex((g) => g.ownerId === ownerId && g.name === name);
    if (idx < 0) return false;
    groups.splice(idx, 1);
    await persistGroups();
    return true;
  }

  /** 重命名分组实体；目标已存在（合并语义）则直接删除源实体 */
  async function renameGroupEntity(ownerId, from, to) {
    const groups = await loadGroups();
    const src = groups.find((g) => g.ownerId === ownerId && g.name === from);
    if (!src) return false;
    const dst = groups.find((g) => g.ownerId === ownerId && g.name === to);
    if (dst) {
      // 合并：删源实体，目标实体保留
      groups.splice(groups.indexOf(src), 1);
    } else {
      src.name = to;
      src.updatedAt = now();
    }
    await persistGroups();
    return true;
  }

  /** 分组排序：按传入顺序重写该 owner 分组的 order（缺漏的分组追加到末尾） */
  async function reorderGroups(ownerId, names) {
    const groups = await loadGroups();
    const mine = groups.filter((g) => g.ownerId === ownerId);
    const rank = new Map(names.map((n, i) => [n, i + 1]));
    let tail = names.length + 1;
    for (const g of mine) {
      g.order = rank.get(g.name) ?? tail++;
    }
    await persistGroups();
    return true;
  }

  /** 分组集合操作（contracts/rest-api.md 分组节）：仅作用于 ownerId 的主机，单次原子落盘 */
  async function updateHostsGroup(ownerId, fromGroup, toGroup) {
    const hosts = await loadHosts();
    let moved = 0;
    for (const h of hosts) {
      if (h.ownerId === ownerId && h.group === fromGroup) {
        h.group = toGroup; // string（重命名/合并）或 'default'（删除 → 回内置默认分组）
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

  /** 永久删除令牌记录（rest-api.md：仅限已撤销/已过期；调用方负责状态校验） */
  async function deleteToken(id) {
    const tokens = await loadTokens();
    const idx = tokens.findIndex((t) => t.id === id);
    if (idx < 0) return null;
    const [removed] = tokens.splice(idx, 1);
    await persistTokens();
    return removed;
  }

  async function saveTokens(tokens) {
    tokensCache = tokens;
    await persistTokens();
  }

  // —— 用户资料（users.json：昵称/头像元数据，按 ownerId 隔离；R003）——

  async function loadUsers() {
    if (usersCache) return usersCache;
    let data;
    try {
      data = await readJsonWithFallback(usersFile);
    } catch (err) {
      if (err.code === 'ENOENT') {
        usersCache = [];
        return usersCache;
      }
      throw err;
    }
    data = migrate(data, 'users.json');
    usersCache = Array.isArray(data.users) ? data.users : [];
    return usersCache;
  }

  async function persistUsers() {
    usersCache = usersCache || [];
    await atomicWriteFile(
      usersFile,
      JSON.stringify({ version: SCHEMA_VERSION, updatedAt: now(), users: usersCache }, null, 2)
    );
  }

  /** 读取某用户资料记录；不存在返回 null（字段全空时也返回 null，调用方按缺省处理） */
  async function getUserProfile(ownerId) {
    const rec = (await loadUsers()).find((u) => u.ownerId === ownerId);
    if (!rec) return null;
    const empty = !rec.nickname && !rec.avatarExt;
    return empty ? null : rec;
  }

  /**
   * 昵称校验：null/undefined = 未设置；string trim 后 0–32 字符（空串=清除）。
   * @returns {string|null} 规范化后的昵称
   */
  function normalizeNickname(nickname) {
    if (nickname === undefined || nickname === null) return null;
    if (typeof nickname !== 'string') throw new Error('nickname 必须为字符串');
    const trimmed = nickname.trim();
    if (trimmed.length > 32) throw new Error('nickname 长度不可超过 32 字符');
    return trimmed === '' ? null : trimmed;
  }

  /**
   * 写入用户资料（upsert by ownerId）。patch：{ nickname?, avatarExt?, avatarUpdatedAt? }
   * nickname 走 normalize 校验；记录变为全空时从存储移除。
   */
  async function saveUserProfile(ownerId, patch = {}) {
    if (!ownerId || typeof ownerId !== 'string') throw new Error('ownerId 无效');
    if (patch.avatarExt !== undefined && patch.avatarExt !== null && typeof patch.avatarExt !== 'string') {
      throw new Error('avatarExt 必须为字符串或 null');
    }
    const nickname =
      patch.nickname !== undefined ? normalizeNickname(patch.nickname) : undefined;
    const users = await loadUsers();
    let rec = users.find((u) => u.ownerId === ownerId);
    if (!rec) {
      rec = { ownerId, nickname: null, avatarExt: null, avatarUpdatedAt: null, updatedAt: null };
      users.push(rec);
    }
    if (nickname !== undefined) rec.nickname = nickname;
    if (patch.avatarExt !== undefined) rec.avatarExt = patch.avatarExt;
    if (patch.avatarUpdatedAt !== undefined) rec.avatarUpdatedAt = patch.avatarUpdatedAt;
    rec.updatedAt = now();
    // 全空记录不入盘（保持文件最小）
    const idx = users.indexOf(rec);
    if (!rec.nickname && !rec.avatarExt) users.splice(idx, 1);
    await persistUsers();
    return rec;
  }

  return {
    hostsFile,
    tokensFile,
    groupsFile,
    usersFile,
    avatarsDir,
    listHosts,
    getHost,
    getHostById,
    saveHosts,
    upsertHost,
    deleteHost,
    validateHost,
    touchHost,
    wipeHosts,
    updateHostsGroup,
    listGroups,
    createGroupEntity,
    removeGroupEntity,
    renameGroupEntity,
    reorderGroups,
    listTokens,
    listTokensAll,
    getTokenById,
    touchToken,
    deleteToken,
    saveTokens,
    getUserProfile,
    saveUserProfile,
  };
}

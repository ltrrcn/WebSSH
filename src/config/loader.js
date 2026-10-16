// 配置加载：默认值 + 用户配置合并 + 校验
// 用户 config.json 损坏时回退默认值并输出告警（不静默使用半截配置）
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from './defaults.js';

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 深合并：用户值覆盖默认值，对象递归，数组整体替换（敏感路径清单等语义） */
export function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(base[k]) && isPlainObject(v) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/**
 * 加载配置。@param {{config: string}} paths 运行时路径
 * @returns {Promise<{config: object, warnings: string[]}>}
 */
export async function loadConfig(paths) {
  const file = join(paths.config, 'config.json');
  let user = null;
  const warnings = [];
  try {
    user = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      warnings.push(`config.json 解析失败（${err.message}），已回退默认配置`);
      // 尝试 .bak
      try {
        user = JSON.parse(await readFile(`${file}.bak`, 'utf8'));
        warnings.push('已从 config.json.bak 恢复用户配置');
      } catch {
        user = null;
      }
    }
  }
  const merged = user ? deepMerge(structuredClone(DEFAULT_CONFIG), user) : structuredClone(DEFAULT_CONFIG);
  validateConfig(merged);
  return { config: merged, warnings };
}

/**
 * 持久化配置（运行时修改用）：原子写 tmp + rename，保留一代 .bak。
 * @param {{config: string}} paths 运行时路径
 */
export async function saveConfig(paths, config) {
  const file = join(paths.config, 'config.json');
  const text = JSON.stringify(config, null, 2) + '\n';
  // 保留旧版本为 .bak（与 store 的"一代备份"策略一致）
  try {
    const prev = await readFile(file, 'utf8');
    await writeFile(`${file}.bak`, prev, 'utf8');
  } catch {
    /* 首次保存无旧文件 */
  }
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
}

function validateConfig(cfg) {
  const { limits } = cfg;
  if (limits) {
    for (const key of ['sessionsPerUser', 'connectTimeoutMs', 'idleTimeoutMs', 'execTimeoutMs', 'tokenRateLimitPerMinute', 'outputDigestBytes', 'detachedTtlMs']) {
      if (limits[key] !== undefined && (!Number.isFinite(limits[key]) || limits[key] < 0)) {
        throw new Error(`config.limits.${key} 必须为非负数值`);
      }
    }
  }
  if (cfg.standalone?.port !== undefined) {
    const p = Number(cfg.standalone.port);
    if (!Number.isInteger(p) || p < 0 || p > 65535) {
      throw new Error('config.standalone.port 必须为 0–65535');
    }
  }
  if (cfg.audit?.recordTerminalOutput !== undefined && typeof cfg.audit.recordTerminalOutput !== 'boolean') {
    throw new Error('config.audit.recordTerminalOutput 必须为布尔值');
  }
  const twofa = cfg.twofa;
  if (twofa) {
    if (twofa.enabled !== undefined && typeof twofa.enabled !== 'boolean') {
      throw new Error('config.twofa.enabled 必须为布尔值');
    }
    for (const key of ['audit', 'tokens']) {
      const v = twofa.protectedActions?.[key];
      if (v !== undefined && typeof v !== 'boolean') {
        throw new Error(`config.twofa.protectedActions.${key} 必须为布尔值`);
      }
    }
    if (twofa.failedAttempts !== undefined &&
        (!Number.isInteger(twofa.failedAttempts) || twofa.failedAttempts < 0)) {
      throw new Error('config.twofa.failedAttempts 必须为非负整数');
    }
    if (twofa.recoveryAttempts !== undefined &&
        (!Number.isInteger(twofa.recoveryAttempts) || twofa.recoveryAttempts < 0)) {
      throw new Error('config.twofa.recoveryAttempts 必须为非负整数');
    }
    if (twofa.lockedUntil !== undefined && twofa.lockedUntil !== null && !Number.isFinite(twofa.lockedUntil)) {
      throw new Error('config.twofa.lockedUntil 必须为数值或 null');
    }
  }
  const mcpDirect = cfg.fnos?.mcpDirect;
  if (mcpDirect) {
    if (mcpDirect.enabled !== undefined && typeof mcpDirect.enabled !== 'boolean') {
      throw new Error('config.fnos.mcpDirect.enabled 必须为布尔值');
    }
    if (mcpDirect.port !== undefined) {
      const p = Number(mcpDirect.port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        throw new Error('config.fnos.mcpDirect.port 必须为 1–65535');
      }
    }
    if (mcpDirect.bind !== undefined && typeof mcpDirect.bind !== 'string') {
      throw new Error('config.fnos.mcpDirect.bind 必须为字符串');
    }
  }
  const topMcp = cfg.mcpDirect;
  if (topMcp) {
    if (topMcp.enabled !== undefined && typeof topMcp.enabled !== 'boolean') {
      throw new Error('config.mcpDirect.enabled 必须为布尔值');
    }
    if (topMcp.port !== undefined) {
      const p = Number(topMcp.port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        throw new Error('config.mcpDirect.port 必须为 1–65535');
      }
    }
    if (topMcp.bind !== undefined && typeof topMcp.bind !== 'string') {
      throw new Error('config.mcpDirect.bind 必须为字符串');
    }
  }
}

// 配置加载：默认值 + 用户配置合并 + 校验
// 用户 config.json 损坏时回退默认值并输出告警（不静默使用半截配置）
import { readFile } from 'node:fs/promises';
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

function validateConfig(cfg) {
  const { limits } = cfg;
  if (limits) {
    for (const key of ['sessionsPerUser', 'connectTimeoutMs', 'idleTimeoutMs', 'execTimeoutMs', 'tokenRateLimitPerMinute', 'outputDigestBytes']) {
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
}

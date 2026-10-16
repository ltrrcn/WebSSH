// JSONL 审计日志（research R9 / FR-010/011/041/042）
// 按天 + 按大小滚动；保留 N 天；写入前过脱敏；schema version=1（只增不改）
// MCP 独立审计流：actorType='token'（令牌/机器调用）写入 audit-mcp-*.jsonl，
// 人工操作写 audit-*.jsonl —— 机器行为与人工行为物理分文件，便于独立审查与归档。
import { appendFile, mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { redact, needsRedaction, truncateDigest } from '../crypto/redact.js';

const SCHEMA_VERSION = 1;
// 文件名前缀（两套流共用同一滚动/保留策略）
const PREFIX_MAIN = 'audit';
const PREFIX_MCP = 'audit-mcp';
const FILE_RE = /^(audit|audit-mcp)-(\d{4}-\d{2}-\d{2})(\.\d+)?\.jsonl$/;

function dayStamp(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

/**
 * @param {{logDir: string, config: object}} opts
 *   config: { audit: { retentionDays, maxFileBytes }, limits: { outputDigestBytes } }
 */
export function createAuditLogger({ logDir, config }) {
  const { retentionDays = 30, maxFileBytes = 10485760 } = config?.audit ?? {};
  const digestBytes = config?.limits?.outputDigestBytes ?? 2048;

  // 串行写入链：保证 JSONL 行序与滚动判定不竞态
  let chain = Promise.resolve();
  // 各流当前文件（前缀 → 文件名）
  const currentFiles = new Map();

  async function resolveFile(prefix, bytes) {
    const base = join(logDir, `${prefix}-${dayStamp()}.jsonl`);
    if (currentFiles.get(prefix) !== base) {
      currentFiles.set(prefix, base);
    }
    if (bytes === 0) return base;
    try {
      const st = await stat(base);
      if (st.size >= maxFileBytes) {
        // 同日滚动：{prefix}-YYYY-MM-DD.N.jsonl
        let n = 1;
        // 从当前最大序号继续
        const files = await readdir(logDir);
        const p = `${prefix}-${dayStamp()}.`;
        for (const f of files) {
          const m = f.match(new RegExp(`^${p}(\\d+)\\.jsonl$`));
          if (m) n = Math.max(n, Number(m[1]) + 1);
        }
        return join(logDir, `${p}${n}.jsonl`);
      }
    } catch {
      /* 文件不存在，走 base */
    }
    return base;
  }

  /** 追加写入链（串行） */
  function enqueue(job) {
    const next = chain.then(job, job);
    chain = next.catch(() => {});
    return next;
  }

  /**
   * 写入一条审计事件。补全 id/ts/version，对 command/outputDigest 脱敏并截断。
   * @param {object} event AuditEvent（见 data-model.md）
   */
  function log(event) {
    return enqueue(async () => {
      await mkdir(logDir, { recursive: true });
      const ev = {
        version: SCHEMA_VERSION,
        id: event.id ?? `a_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        ts: event.ts ?? new Date().toISOString(),
        actor: event.actor ?? null,
        actorType: event.actorType ?? 'user',
        tokenId: event.tokenId ?? null,
        hostId: event.hostId ?? null,
        hostAddress: event.hostAddress ?? null,
        authType: event.authType ?? null,
        sessionId: event.sessionId ?? null, // 会话 ID（Web 终端事件；MCP 调用为 null）
        event: event.event,
        result: event.result ?? 'success',
        reason: event.reason ?? null,
        durationMs: event.durationMs ?? null,
        command: null,
        outputDigest: null,
        path: event.path ?? null,
        quickName: null, // 快捷命令备注名（event=quick-exec）：审计页展示备注名而非命令原文
        redacted: false,
      };
      if (event.command !== undefined && event.command !== null) {
        const r = redact(String(event.command));
        ev.command = r;
        ev.redacted = ev.redacted || r !== String(event.command);
      }
      if (event.outputDigest !== undefined && event.outputDigest !== null) {
        const r = redact(String(event.outputDigest));
        const t = truncateDigest(r, digestBytes);
        ev.outputDigest = t.content;
        ev.redacted = ev.redacted || t.truncated || r !== String(event.outputDigest);
      }
      if (event.outputDigest !== undefined && event.outputDigest !== null && needsRedaction(String(event.outputDigest))) {
        ev.redacted = true;
      }
      if (event.quickName !== undefined && event.quickName !== null) {
        ev.quickName = redact(String(event.quickName));
      }
      const line = `${JSON.stringify(ev)}\n`;
      // MCP 独立审计流：令牌发起的机器调用写 audit-mcp-*，人工操作写 audit-*
      const prefix = ev.actorType === 'token' ? PREFIX_MCP : PREFIX_MAIN;
      const file = await resolveFile(prefix, line.length);
      await appendFile(file, line, 'utf8');
      return ev;
    });
  }

  /** 按保留策略清理过期审计文件（启动与每日触发，两种流一并清理） */
  async function enforceRetention() {
    const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
    let files;
    try {
      files = await readdir(logDir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const f of files) {
      const m = f.match(FILE_RE);
      if (!m) continue;
      if (new Date(`${m[2]}T00:00:00Z`).getTime() < cutoff) {
        try {
          await unlink(join(logDir, f));
          removed++;
        } catch {
          /* 忽略单个删除失败 */
        }
      }
    }
    return removed;
  }

  /**
   * 读取全部事件（两种审计流的文件合并，行序读入；查询侧再按 ts 排序）。
   * @param {{actorType?: 'token' | 'user'}} [opts] 按来源过滤（兼容旧文件中的历史事件）
   */
  async function listAll(opts = {}) {
    let files;
    try {
      files = (await readdir(logDir)).filter((f) => FILE_RE.test(f));
    } catch {
      return [];
    }
    files.sort();
    const events = [];
    for (const f of files) {
      let text = '';
      try {
        text = await readFile(join(logDir, f), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (opts.actorType && ev.actorType !== opts.actorType) continue;
          events.push(ev);
        } catch {
          /* 跳过损坏行 */
        }
      }
    }
    return events;
  }

  /** 等待队列中全部写入完成（优雅退出/测试清理前调用） */
  function drain() {
    return chain;
  }

  return { log, enforceRetention, listAll, logDir, drain };
}

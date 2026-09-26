// JSONL 审计日志（research R9 / FR-010/011/041/042）
// 按天 + 按大小滚动；保留 N 天；写入前过脱敏；schema version=1（只增不改）
import { appendFile, mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { redact, needsRedaction, truncateDigest } from '../crypto/redact.js';

const SCHEMA_VERSION = 1;

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
  let currentFile = null;

  async function resolveFile(bytes) {
    const base = join(logDir, `audit-${dayStamp()}.jsonl`);
    if (currentFile !== base) {
      currentFile = base;
    }
    if (bytes === 0) return base;
    try {
      const st = await stat(currentFile);
      if (st.size >= maxFileBytes) {
        // 同日滚动：audit-YYYY-MM-DD.N.jsonl
        let n = 1;
        // 从当前最大序号继续
        const files = await readdir(logDir);
        const prefix = `audit-${dayStamp()}.`;
        for (const f of files) {
          const m = f.match(new RegExp(`^${prefix}(\\d+)\\.jsonl$`));
          if (m) n = Math.max(n, Number(m[1]) + 1);
        }
        return join(logDir, `audit-${dayStamp()}.${n}.jsonl`);
      }
    } catch {
      /* 文件不存在，走 base */
    }
    return currentFile;
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
        event: event.event,
        result: event.result ?? 'success',
        reason: event.reason ?? null,
        durationMs: event.durationMs ?? null,
        command: null,
        outputDigest: null,
        path: event.path ?? null,
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
      const line = `${JSON.stringify(ev)}\n`;
      const file = await resolveFile(line.length);
      await appendFile(file, line, 'utf8');
      return ev;
    });
  }

  /** 按保留策略清理过期审计文件（启动与每日触发） */
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
      const m = f.match(/^audit-(\d{4}-\d{2}-\d{2})(\.\d+)?\.jsonl$/);
      if (!m) continue;
      if (new Date(`${m[1]}T00:00:00Z`).getTime() < cutoff) {
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

  /** 读取全部事件（按文件名时间顺序 + 行序），US4 查询/导出使用 */
  async function listAll() {
    let files;
    try {
      files = (await readdir(logDir)).filter((f) => /^audit-\d{4}-\d{2}-\d{2}(\.\d+)?\.jsonl$/.test(f));
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
          events.push(JSON.parse(line));
        } catch {
          /* 跳过损坏行 */
        }
      }
    }
    return events;
  }

  return { log, enforceRetention, listAll, logDir };
}

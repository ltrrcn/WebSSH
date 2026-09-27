// MCP 端点（FR-022~043 / mcp-tools.md 契约）：挂载在既有 HTTP 服务的 /mcp，不新开端口（宪法 III）
// 说明：按宪法 VI（YAGNI）直接实现 MCP 所需的 JSON-RPC 子集（initialize/tools/list/tools/call），
// 不引入 SDK 的会话传输层——基础版为无状态调用，鉴权与审计由本层统一控制。
import { Client } from 'ssh2';
import { fingerprintOfKey } from '../ssh/hostkey.js';
import { checkPathAccess, checkCommand } from '../ssh/policy.js';
import { decryptSecret } from '../crypto/secret.js';
import { redact, truncateDigest } from '../crypto/redact.js';
import { checkRateLimit } from './rate-limit.js';

const MAX_READ_BYTES = 1024 * 512; // read_file 单次上限 512KB

/** 工具注册矩阵（第一层判定：能力隔离，FR-031） */
export function toolDefinitions(level) {
  const tools = [
    {
      name: 'list_hosts',
      description: '列出令牌授权范围内的主机',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ];
  if (level === 'readonly' || level === 'writable') {
    tools.push({
      name: 'read_file',
      description: '读取授权主机上矩阵允许路径的文件内容（受目录权限矩阵限制）',
      inputSchema: {
        type: 'object',
        properties: {
          hostId: { type: 'string', description: '目标主机 ID' },
          path: { type: 'string', description: '绝对路径' },
        },
        required: ['hostId', 'path'],
        additionalProperties: false,
      },
    });
  }
  if (level === 'writable') {
    tools.push({
      name: 'run_command',
      description: '在授权主机上执行一条命令（拼接/重定向语法与危险命令将被拒绝）',
      inputSchema: {
        type: 'object',
        properties: {
          hostId: { type: 'string', description: '目标主机 ID' },
          command: { type: 'string', description: '命令原文' },
        },
        required: ['hostId', 'command'],
        additionalProperties: false,
      },
    });
    tools.push({
      name: 'write_file',
      description: '写入授权主机上矩阵允许路径的文件（需要 write 与 modify 权限）',
      inputSchema: {
        type: 'object',
        properties: {
          hostId: { type: 'string', description: '目标主机 ID' },
          path: { type: 'string', description: '绝对路径' },
          content: { type: 'string', description: '文件内容' },
        },
        required: ['hostId', 'path', 'content'],
        additionalProperties: false,
      },
    });
  }
  return tools;
}

/**
 * 处理 /mcp 请求（已在路由层完成 Bearer 鉴权与限流预检）。
 * @param {{token: object, runtime: object, config: object, store: object, audit: object, masterKey: Buffer}} ctx
 */
export async function handleMcpCall(body, ctx) {
  const { token, config, store, audit, masterKey } = ctx;
  const method = body?.method;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: body.id ?? null,
      result: {
        protocolVersion: body.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'webssh', version: '0.1.0' },
      },
    };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id: body.id ?? null, result: { tools: toolDefinitions(token.level) } };
  }
  if (method === 'tools/call') {
    const name = body.params?.name;
    const args = body.params?.arguments ?? {};
    const allowed = toolDefinitions(token.level).some((t) => t.name === name);
    if (!allowed) {
      return rpcError(body.id, -32602, `工具不存在或令牌级别（${token.level}）无权调用: ${name}`);
    }
    try {
      const result = await dispatchTool(name, args, ctx);
      auditToolCall(audit, token, name, args, result, 'success', null);
      return {
        jsonrpc: '2.0',
        id: body.id ?? null,
        result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
      };
    } catch (err) {
      auditToolCall(audit, token, name, args, null, err.code === 'rate_limited' ? 'denied' : 'error', err.code ?? err.message);
      return {
        jsonrpc: '2.0',
        id: body.id ?? null,
        result: {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ error: err.code ?? 'tool_error', message: String(err.message) }) }],
        },
      };
    }
  }
  // 未知方法（notifications 无 id 时上层已直接 202）
  return rpcError(body.id ?? null, -32601, `Method not found: ${method}`);
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** 审计：每次工具调用一条 AuditEvent（FR-027/041/042） */
function auditToolCall(audit, token, name, args, result, resultStatus, reason) {
  audit.log({
    actor: token.ownerId,
    actorType: 'token',
    tokenId: token.id,
    hostId: args?.hostId ?? null,
    event: name === 'run_command' ? 'command' : name === 'read_file' ? 'file-read' : name === 'write_file' ? 'file-write' : 'command',
    result: resultStatus,
    reason,
    command: name === 'run_command' ? args?.command : undefined,
    outputDigest: result?.stdoutDigest ?? null,
    path: args?.path ?? null,
  });
}
let ctxDigestBytes = 2048;
export function setDigestBytes(n) {
  ctxDigestBytes = n;
}

async function dispatchTool(name, args, ctx) {
  const { token, config, store, masterKey } = ctx;
  setDigestBytes(config.limits.outputDigestBytes ?? 2048);

  if (name === 'list_hosts') {
    const hosts = (await store.listHosts(token.ownerId)).filter((h) =>
      token.hostScope.includes(h.id)
    );
    return {
      hosts: hosts.map((h) => ({ id: h.id, name: h.name, host: h.host, port: h.port, username: h.username, group: h.group ?? null })),
    };
  }

  // 需要目标主机与 SSH 连接的工具
  const host = (await store.listHosts(token.ownerId)).find(
    (h) => h.id === args.hostId && token.hostScope.includes(h.id)
  );
  if (!host) {
    throw Object.assign(new Error('目标主机不在令牌授权范围'), { code: 'host_not_allowed' });
  }

  if (name === 'run_command') {
    const verdict = checkCommand(args.command, config.security, { level: token.level });
    if (!verdict.allowed) {
      throw Object.assign(new Error(`命令被拒绝（${verdict.reason}）`), { code: 'command_denied' });
    }
    const out = await withSsh({ host, masterKey, config }, (conn) =>
      execCommand(conn, args.command, config.limits.execTimeoutMs ?? 60000)
    );
    const t = truncateDigest(redact(out.stdout), config.limits.outputDigestBytes ?? 2048);
    return { exitCode: out.exitCode, stdoutDigest: t.content, truncated: t.truncated, timedOut: out.timedOut };
  }

  if (name === 'read_file') {
    const pctx = { sensitivePaths: config.security.sensitivePaths, matrix: token.permissions };
    const verdict = checkPathAccess(args.path, pctx, 'read');
    if (!verdict.allowed) {
      throw Object.assign(new Error(`路径被拒绝（${verdict.reason}）`), { code: 'path_denied' });
    }
    return withSsh({ host, masterKey, config }, (conn) => sftpRead(conn, args.path, MAX_READ_BYTES));
  }

  if (name === 'write_file') {
    const pctx = { sensitivePaths: config.security.sensitivePaths, matrix: token.permissions };
    const w = checkPathAccess(args.path, pctx, 'write');
    const m = checkPathAccess(args.path, pctx, 'modify');
    if (!w.allowed || !m.allowed) {
      throw Object.assign(new Error(`路径被拒绝（${!w.allowed ? w.reason : m.reason}）`), { code: 'path_denied' });
    }
    await withSsh({ host, masterKey, config }, (conn) => sftpWrite(conn, args.path, String(args.content ?? '')));
    return { ok: true };
  }

  throw Object.assign(new Error(`未知工具: ${name}`), { code: 'tool_error' });
}

/** 建立一次性 SSH 连接并执行（HostKey 校验与终端会话一致，FR-029） */
function withSsh({ host, masterKey, config }, fn) {
  return new Promise((resolve, reject) => {
    const secret = (() => {
      try {
        return decryptSecret(masterKey, host.secret);
      } catch (e) {
        return reject(e);
      }
    })();
    const conn = new Client();
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch { /* 忽略 */ }
      reject(err);
    };
    conn.on('ready', async () => {
      try {
        const out = await fn(conn);
        if (settled) return;
        settled = true;
        conn.end();
        resolve(out);
      } catch (err) {
        fail(err);
      }
    });
    conn.on('error', fail);
    conn.connect({
      host: host.host,
      port: host.port,
      username: host.username,
      password: secret.password,
      privateKey: secret.privateKey,
      passphrase: secret.passphrase,
      readyTimeout: config.limits.connectTimeoutMs ?? 10000,
      hostVerifier: (keyBlob) => fingerprintOfKey(keyBlob) === host.fingerprint,
    });
  });
}

/** exec 一条命令，超时强杀（FR-043：独立于会话空闲超时） */
function execCommand(conn, command, timeoutMs) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { stream.close(); } catch { /* 忽略 */ }
        try { conn.end(); } catch { /* 忽略 */ }
        resolve({ exitCode: -1, stdout, timedOut: true });
      }, timeoutMs);
      stream.on('data', (d) => { stdout += d.toString(); if (stdout.length > 1024 * 1024) stdout = stdout.slice(0, 1024 * 1024); });
      stream.stderr.on('data', () => { /* 忽略 stderr */ });
      stream.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) return;
        resolve({ exitCode: code ?? 0, stdout, timedOut: false });
      });
      stream.on('error', reject);
    });
  });
}

/** SFTP 读取（上限截断） */
function sftpRead(conn, path, maxBytes) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const chunks = [];
      let size = 0;
      const rs = sftp.createReadStream(path);
      rs.on('data', (d) => {
        if (size < maxBytes) chunks.push(d);
        size += d.length;
      });
      rs.on('error', (e) => reject(Object.assign(new Error(`读取失败: ${e.message}`), { code: 'path_denied' })));
      rs.on('end', () => {
        sftp.end();
        resolve({ content: Buffer.concat(chunks).toString('utf8'), truncated: size > maxBytes });
      });
    });
  });
}

/** SFTP 写入 */
function sftpWrite(conn, path, content) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const ws = sftp.createWriteStream(path);
      ws.on('error', (e) => reject(Object.assign(new Error(`写入失败: ${e.message}`), { code: 'path_denied' })));
      ws.on('close', () => { sftp.end(); resolve(); });
      ws.end(content, 'utf8');
    });
  });
}

export { checkRateLimit };

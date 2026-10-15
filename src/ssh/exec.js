// 一次性 SSH exec：建立独立连接执行单条命令（与终端 PTY 会话无关）
// 供 MCP run_command 与 Web 快捷命令掩码执行（/api/quick-exec）共用；HostKey 校验与终端会话一致（FR-029）
import { Client } from 'ssh2';
import { fingerprintOfKey } from './hostkey.js';
import { decryptSecret } from '../crypto/secret.js';

/** 建立一次性 SSH 连接并执行 fn(conn)，结束自动断开 */
export function withSsh({ host, masterKey, config }, fn) {
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
      readyTimeout: config.limits?.connectTimeoutMs ?? 10000,
      hostVerifier: (keyBlob) => fingerprintOfKey(keyBlob) === host.fingerprint,
    });
  });
}

/** exec 一条命令，超时强杀（FR-043：独立于会话空闲超时）；stdout/stderr 分别截断上限 */
export function execCommand(conn, command, timeoutMs) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { stream.close(); } catch { /* 忽略 */ }
        try { conn.end(); } catch { /* 忽略 */ }
        resolve({ exitCode: -1, stdout, stderr, timedOut: true });
      }, timeoutMs);
      stream.on('data', (d) => { stdout += d.toString(); if (stdout.length > 1024 * 1024) stdout = stdout.slice(0, 1024 * 1024); });
      stream.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 256 * 1024) stderr = stderr.slice(0, 256 * 1024); });
      stream.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) return;
        resolve({ exitCode: code ?? 0, stdout, stderr, timedOut: false });
      });
      stream.on('error', reject);
    });
  });
}

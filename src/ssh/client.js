// SSH 连接建立（research R1/R2：ssh2 纯 JS，PTY 由远端 sshd 分配，无需 node-pty）
import { Client } from 'ssh2';
import { fingerprintOfKey } from './hostkey.js';

/**
 * 建立 SSH 连接并申请交互式 shell。
 * HostKey 校验（FR-007 / 宪法 I）：以已确认指纹做全等比对，禁止 InsecureIgnoreHostKey。
 *
 * @param {{host: string, port: number, username: string,
 *   secret: {password?: string, privateKey?: string, passphrase?: string},
 *   connectTimeoutMs: number, expectedFingerprint: string,
 *   onHostKeyVerified?: ({algorithm: string, fingerprint: string}) => void,
 *   cols?: number, rows?: number}} opts
 * @returns {Promise<{conn: import('ssh2').Client, stream: import('ssh2').Channel}>}
 */
export function connectShell(opts) {
  const {
    host,
    port,
    username,
    secret,
    connectTimeoutMs,
    expectedFingerprint,
    onHostKeyVerified,
    cols = 80,
    rows = 24,
  } = opts;

  if (!expectedFingerprint) {
    return Promise.reject(new Error('fingerprint_unconfirmed'));
  }

  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try {
        conn.end();
      } catch {
        /* 忽略 */
      }
      reject(err);
    };

    conn.on('ready', () => {
      conn.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) return fail(err);
        if (settled) {
          try {
            conn.end();
          } catch {
            /* 忽略 */
          }
          return;
        }
        settled = true;
        resolve({ conn, stream });
      });
    });

    conn.on('error', fail);
    conn.on('close', () => fail(new Error('connection_closed')));

    conn.connect({
      host,
      port,
      username,
      // 认证方式（FR-006）：口令或私钥（可带 passphrase）
      password: secret.password,
      privateKey: secret.privateKey,
      passphrase: secret.passphrase,
      readyTimeout: connectTimeoutMs,
      keepaliveInterval: 15000,
      // HostKey 校验：指纹全等比对（宪法 I：禁止 InsecureIgnoreHostKey）
      hostVerifier: (keyBlob) => {
        const fingerprint = fingerprintOfKey(keyBlob);
        const ok = fingerprint === expectedFingerprint;
        if (ok && typeof onHostKeyVerified === 'function') {
          onHostKeyVerified({ algorithm: 'ssh-key', fingerprint });
        }
        if (!ok) {
          // 指纹变化：拒绝并告警（防中间人）。错误信息不含任何凭据。
          fail(new Error('fingerprint_changed'));
          return false;
        }
        return true;
      },
    });
  });
}

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
      conn.shell(
        {
          term: 'xterm-256color',
          cols,
          rows,
          // 中文输入乱码修复：不带 env 时 sshd 会话以 C/POSIX locale 启动，
          // zle 按单字节处理中文（显示 <0093><0088> 形式转义）。
          // LC_CTYPE=UTF-8 为 macOS 原生形式且 glibc 系（Debian/Ubuntu）内置接受，
          // 双平台保底字符集；LANG 让界面消息保持中文。
          // sshd 需 AcceptEnv LANG LC_*（OpenSSH 默认开启），被拒绝也不影响 shell 建立。
          env: { LANG: 'zh_CN.UTF-8', LC_CTYPE: 'UTF-8' },
        },
        (err, stream) => {
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

/**
 * 捕获目标主机当前指纹（不建立会话）：
 * 完成密钥交换拿到主机公钥后立即拒绝握手并断开。
 * 用于「首次连接 + 指纹未确认」时向使用者展示待确认指纹（Edge Case：禁止静默接受）。
 * @returns {Promise<string>} SHA256:xxx 形式指纹
 */
export function captureFingerprint({ host, port, connectTimeoutMs }) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      try {
        conn.end();
      } catch {
        /* 忽略 */
      }
      reject(err);
    };
    conn.on('error', fail);
    conn.on('close', () => fail(new Error('connection_closed')));
    conn.connect({
      host,
      port,
      username: 'probe',
      readyTimeout: connectTimeoutMs,
      hostVerifier: (keyBlob) => {
        if (!done) {
          done = true;
          const fp = fingerprintOfKey(keyBlob);
          resolve(fp);
        }
        // 返回 false 中止握手：仅捕获指纹，不认证、不建立会话
        return false;
      },
    });
  });
}

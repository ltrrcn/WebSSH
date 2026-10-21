// SSH 连接建立（research R1/R2：ssh2 纯 JS，PTY 由远端 sshd 分配，无需 node-pty）
import { Client } from 'ssh2';
import { fingerprintOfKey } from './hostkey.js';

/**
 * 建立裸 SSH 连接（ready 即返回，不申请 shell）。
 * HostKey 校验（FR-007 / 宪法 I）：以已确认指纹做全等比对，禁止 InsecureIgnoreHostKey。
 *
 * @param {{host: string, port: number, username: string,
 *   secret: {password?: string, privateKey?: string, passphrase?: string},
 *   connectTimeoutMs: number, expectedFingerprint: string,
 *   onHostKeyVerified?: ({algorithm: string, fingerprint: string}) => void,
 *   sock?: import('node:stream').Duplex}} opts sock = 经跳板机转发的通道（ProxyJump）
 * @returns {Promise<import('ssh2').Client>}
 */
function openConn(opts) {
  const {
    host,
    port,
    username,
    secret,
    connectTimeoutMs,
    expectedFingerprint,
    onHostKeyVerified,
    sock,
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
      settled = true;
      resolve(conn);
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
      // 跳板模式：底层 socket 替换为跳板机的 direct-tcpip 通道
      ...(sock ? { sock } : {}),
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

/** 在已就绪的连接上申请交互式 shell */
function openShell(conn, { cols = 80, rows = 24, termType, env }) {
  return new Promise((resolve, reject) => {
    conn.shell(
      {
        // 终端类型可按连接覆盖（高级页），默认 xterm-256color
        term: termType || 'xterm-256color',
        cols,
        rows,
        // 中文输入乱码修复：不带 env 时 sshd 会话以 C/POSIX locale 启动，
        // zle 按单字节处理中文（显示 <0093><0088> 形式转义）。
        // LC_CTYPE=UTF-8 为 macOS 原生形式且 glibc 系（Debian/Ubuntu）内置接受，
        // 双平台保底字符集；LANG 让界面消息保持中文。
        // sshd 需 AcceptEnv LANG LC_*（OpenSSH 默认开启），被拒绝也不影响 shell 建立。
        // 连接级环境变量（高级页 KEY=VALUE）在此叠加注入（sshd 拒绝时不影响 shell 建立）。
        env: { LANG: 'zh_CN.UTF-8', LC_CTYPE: 'UTF-8', ...(env ?? {}) },
      },
      (err, stream) => {
        if (err) {
          try {
            conn.end();
          } catch {
            /* 忽略 */
          }
          return reject(err);
        }
        resolve(stream);
      }
    );
  });
}

/**
 * 建立 SSH 连接并申请交互式 shell。
 * @param {object} opts 同 openConn，另加 cols/rows
 * @returns {Promise<{conn: import('ssh2').Client, stream: import('ssh2').Channel}>}
 */
export async function connectShell(opts) {
  const conn = await openConn(opts);
  try {
    const stream = await openShell(conn, opts);
    return { conn, stream };
  } catch (err) {
    try {
      conn.end();
    } catch {
      /* 忽略 */
    }
    throw err;
  }
}

/**
 * 经跳板机连接目标主机（ProxyJump，单级）：
 * 跳板机裸连接 → forwardOut(direct-tcpip) 到目标 → 目标连接以该通道为 sock。
 * 跳板与目标的指纹各自独立全等校验（宪法 I 对两跳同样生效）。
 *
 * @param {{jump: object, target: object}} opts jump/target 均为 openConn 参数
 * @returns {Promise<{conn: import('ssh2').Client, stream: import('ssh2').Channel, jumpConn: import('ssh2').Client}>}
 */
export async function connectShellViaJump({ jump, target }) {
  // 同机换用户（跳板与目标同 host:port，如 user@X → root@X）：
  // 跳板本身就是从本机直连的，再经它回环转发毫无网络意义，还会受目标侧
  // AllowTcpForwarding/PermitOpen 限制——直接本机开第二连接，效果等价于 ProxyJump 到自己
  if (jump.host === target.host && Number(jump.port) === Number(target.port)) {
    return connectShell(target);
  }
  // 跳板机私钥若需口令而未保存 → 以专用错误码抛出，由上层映射为明确提示
  const jumpConn = await openConn(jump).catch((err) => {
    const msg = String(err?.message ?? '');
    if (/no passphrase given|bad passphrase|decryption failed/i.test(msg)) {
      throw new Error('jump_passphrase_required');
    }
    if (msg === 'fingerprint_unconfirmed' || msg === 'fingerprint_changed') {
      throw new Error(`jump_${msg}`);
    }
    throw new Error(`jump_connect_failed`);
  });

  const sock = await new Promise((resolve, reject) => {
    // 源地址/端口仅作协议占位，sshd 忽略
    jumpConn.forwardOut('127.0.0.1', 0, target.host, target.port, (err, stream) => {
      if (err) {
        // sshd 错误不含凭据，可安全记日志。OpenSSH 的 description 恒为 "open failed"，
        // 可靠分类依据是 SSH 通道拒绝 reason 码：1=配置禁止（AllowTcpForwarding/PermitOpen），
        // 2=连接失败（跳板侧连不上目标），4=资源不足（MaxSessions 等）
        const raw = String(err?.message ?? '');
        const code = typeof err?.reason === 'number' ? err.reason : null;
        console.warn(`[webssh][jump] direct-tcpip → ${target.host}:${target.port} 失败 (reason=${code}): ${raw}`);
        const denied = code === 1 || /disallow|prohibit|admin/i.test(raw);
        return reject(new Error(denied ? 'jump_forward_denied' : 'jump_forward_failed'));
      }
      resolve(stream);
    });
  }).catch((err) => {
    try {
      jumpConn.end();
    } catch {
      /* 忽略 */
    }
    throw err;
  });

  try {
    const conn = await openConn({ ...target, sock });
    const stream = await openShell(conn, target);
    // 目标断开 → 跳板连接一并释放（防孤儿连接，SC-005）
    conn.once('close', () => {
      try {
        jumpConn.end();
      } catch {
        /* 忽略 */
      }
    });
    return { conn, stream, jumpConn };
  } catch (err) {
    try {
      jumpConn.end();
    } catch {
      /* 忽略 */
    }
    throw err;
  }
}

/**
 * 捕获目标主机当前指纹（不建立会话）：
 * 完成密钥交换拿到主机公钥后立即拒绝握手并断开。
 * 用于「首次连接 + 指纹未确认」时向使用者展示待确认指纹（Edge Case：禁止静默接受）。
 * @returns {Promise<string>} SHA256:xxx 形式指纹
 */
export function captureFingerprint({ host, port, connectTimeoutMs, sock }) {
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
      // 跳板模式：底层 socket 替换为跳板机的 direct-tcpip 通道
      ...(sock ? { sock } : {}),
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

/**
 * 经跳板机捕获目标主机指纹：跳板机直连可达不代表目标直连可达，
 * 仅跳板授权的连接（内网目标）必须经跳板 forwardOut 才能触达目标 sshd。
 * 跳板约束与 connectShellViaJump 一致（已确认指纹全等校验）；任何失败由调用方兜底。
 * @param {{jump: object, target: {host: string, port: number}, connectTimeoutMs: number}} opts
 * @returns {Promise<string>} SHA256:xxx 形式指纹
 */
export async function captureFingerprintViaJump({ jump, target, connectTimeoutMs }) {
  // 同机换用户：本机直连捕获（跳板能从本机直连，目标同机必然可达）
  if (jump.host === target.host && Number(jump.port) === Number(target.port)) {
    return captureFingerprint({ ...target, connectTimeoutMs });
  }
  const jumpConn = await openConn(jump);
  try {
    const sock = await new Promise((resolve, reject) => {
      jumpConn.forwardOut('127.0.0.1', 0, target.host, target.port, (err, stream) => {
        if (err) return reject(err);
        resolve(stream);
      });
    });
    return await captureFingerprint({ ...target, connectTimeoutMs, sock });
  } finally {
    try {
      jumpConn.end();
    } catch {
      /* 忽略 */
    }
  }
}

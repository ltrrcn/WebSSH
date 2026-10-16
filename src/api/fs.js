// REST：fnOS 文件浏览（仅 fnos 模式可用，standalone 一律 404）
// 用途：「从飞牛导入私钥」——在 NAS 存储空间内浏览目录并读取私钥文件。
// 安全约束：
// - 仅允许 /vol<数字> 与 /home 之下的路径（根列表由服务端枚举，客户端不能构造任意根）
// - realpath 解析后再次校验根前缀，防符号链接逃逸
// - 读取上限 256KB，且内容必须是 PEM 私钥（-----BEGIN ... PRIVATE KEY-----）
// - 身份经统一网关注入（X-Trim-*），与 hosts 等接口一致
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, normalize } from 'node:path';
import { sendJson, sendError, readJsonBody } from '../net/router.js';
import { resolveIdentity } from '../net/auth.js';

const MAX_KEY_BYTES = 256 * 1024;
const KEY_HEADER_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const ROOT_RE = /^\/vol\d+(\/|$)|^\/home(\/|$)/;

/** 路径合法性：规范化 + 符号链接解析后必须仍在允许的根之下 */
async function safeAbs(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 1024) return null;
  const norm = normalize(path);
  let abs;
  try {
    abs = await realpath(norm);
  } catch {
    return null; // 不存在 / 无权限
  }
  return ROOT_RE.test(abs) ? abs : null;
}

/** 枚举可浏览的根目录（/vol*、/home 中实际存在且可读的） */
async function listRoots() {
  const roots = [];
  for (const base of ['/vol', '/home']) {
    // /vol 本身不是存储根，枚举其下的 /vol1、/vol2…
    if (base === '/vol') {
      try {
        for (const e of await readdir('/')) {
          if (/^vol\d+$/.test(e)) roots.push({ name: e, path: `/${e}`, type: 'dir' });
        }
      } catch {
        /* 忽略 */
      }
    } else {
      try {
        await stat(base);
        roots.push({ name: 'home', path: base, type: 'dir' });
      } catch {
        /* 忽略 */
      }
    }
  }
  return roots;
}

export function fsRoutes(deps) {
  const { runtime } = deps;
  const fnosOnly = (res) => {
    if (runtime.mode !== 'fnos') {
      sendError(res, 404, 'not_found', '接口不存在');
      return true;
    }
    return false;
  };

  return [
    {
      // 目录列表：path 为空 → 返回可浏览根目录；否则返回目录项（目录在前，按名称排序）
      method: 'GET',
      path: '/api/fs/list',
      handler: async (req, res) => {
        if (fnosOnly(res)) return;
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');

        const url = new URL(req.url, 'http://localhost');
        const path = url.searchParams.get('path') ?? '';
        if (path === '') return sendJson(res, 200, { path: '', entries: await listRoots() });

        const abs = await safeAbs(path);
        if (!abs) return sendError(res, 403, 'forbidden', '路径非法或不可访问');
        let st;
        try {
          st = await stat(abs);
        } catch {
          return sendError(res, 404, 'not_found', '路径不存在');
        }
        if (!st.isDirectory()) return sendError(res, 422, 'not_directory', '目标不是目录');
        let dirents;
        try {
          dirents = await readdir(abs, { withFileTypes: true });
        } catch {
          return sendError(res, 403, 'forbidden', '目录不可读');
        }
        const entries = dirents
          .filter((d) => d.isDirectory() || d.isFile())
          .map((d) => ({
            name: d.name,
            type: d.isDirectory() ? 'dir' : 'file',
          }))
          .sort((a, b) =>
            a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, 'zh')
          );
        sendJson(res, 200, { path: abs, entries });
      },
    },
    {
      // 读取私钥文件：限大小、限 PEM 私钥内容
      method: 'POST',
      path: '/api/fs/read-key',
      handler: async (req, res) => {
        if (fnosOnly(res)) return;
        const identity = resolveIdentity(req, runtime);
        if (!identity) return sendError(res, 401, 'unauthorized', '未认证');
        let body;
        try {
          body = await readJsonBody(req);
        } catch (e) {
          return sendError(res, 422, 'invalid_json', e.message);
        }
        const abs = await safeAbs(body?.path);
        if (!abs) return sendError(res, 403, 'forbidden', '路径非法或不可访问');
        let st;
        try {
          st = await stat(abs);
        } catch {
          return sendError(res, 404, 'not_found', '文件不存在');
        }
        if (!st.isFile()) return sendError(res, 422, 'not_file', '目标不是文件');
        if (st.size > MAX_KEY_BYTES) {
          return sendError(res, 422, 'file_too_large', '文件超过 256KB，不是有效的私钥');
        }
        let content;
        try {
          content = await readFile(abs, 'utf8');
        } catch {
          return sendError(res, 403, 'forbidden', '文件不可读');
        }
        if (!KEY_HEADER_RE.test(content)) {
          return sendError(res, 422, 'not_a_key', '文件内容不是 PEM 格式的私钥');
        }
        sendJson(res, 200, { name: basename(abs), content });
      },
    },
  ];
}

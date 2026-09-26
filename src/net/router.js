// API 路由分发 + 静态文件服务（含路径穿越防护）
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, normalize, resolve } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

export function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

export function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

/**
 * 创建 HTTP 请求处理器。
 * @param {{runtime: object, webDir: string, apiRoutes: Array<{method:string, path:string, handler:(req,res,ctx)=>Promise<void>}>}} opts
 */
export function createRouter({ webDir, apiRoutes = [] }) {
  const routes = new Map();
  for (const r of apiRoutes) routes.set(`${r.method} ${r.path}`, r.handler);
  const webRoot = resolve(webDir);

  return async function handle(req, res, ctx = {}) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (path.startsWith('/api/')) {
      const handler = routes.get(`${req.method} ${path}`);
      if (handler) return handler(req, res, ctx);
      return sendError(res, 404, 'not_found', '接口不存在');
    }

    // —— 静态资源（web/，无构建步骤）——
    const rel = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
    // 穿越防护：规范化后必须仍在 webRoot 内（normalize 保留 .. 供 resolve 计算后比对）
    const abs = resolve(webRoot, normalize(rel));
    if (abs !== webRoot && !abs.startsWith(`${webRoot}/`)) {
      return sendError(res, 403, 'forbidden', '路径非法');
    }
    let st;
    try {
      st = await stat(abs);
    } catch {
      return sendError(res, 404, 'not_found', '资源不存在');
    }
    if (!st.isFile()) return sendError(res, 404, 'not_found', '资源不存在');
    res.writeHead(200, {
      'content-type': MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream',
      'content-length': st.size,
    });
    createReadStream(abs).pipe(res);
  };
}

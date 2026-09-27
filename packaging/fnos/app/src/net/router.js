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
 * 读取并解析 JSON 请求体（带大小上限）。
 * @returns {Promise<object>} 解析失败或超限时 reject（message: payload_too_large / invalid_json）
 */
export function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 统一网关前缀剥离（fnOS gatewayPrefix=/app/webssh 转发时路径携带前缀）。
 * standalone 无此前缀，天然不受影响。WebSocket 升级路径同样使用本函数。
 */
export function stripGatewayPrefix(path) {
  const stripped = path.replace(/^\/app\/[\w.-]+(?=\/|$)/, '');
  return stripped === '' ? '/' : stripped;
}

/**
 * 创建 HTTP 请求处理器。支持 `{param}` 路径占位（如 /api/hosts/{id}）。
 * @param {{webDir: string, apiRoutes: Array<{method:string, path:string, handler:(req,res,ctx)=>Promise<void>}>}} opts
 */
export function createRouter({ webDir, apiRoutes = [], onMcp }) {
  // 编译路由：静态段 + 参数段
  const routes = apiRoutes.map((r) => {
    const pattern = r.path.split('/').map((seg) =>
      seg.startsWith('{') && seg.endsWith('}') ? { param: seg.slice(1, -1) } : seg
    );
    return { ...r, pattern };
  });
  const webRoot = resolve(webDir);

  function matchRoute(method, path) {
    const segs = path.split('/');
    outer: for (const r of routes) {
      if (r.method !== method) continue;
      if (r.pattern.length !== segs.length) continue;
      const params = {};
      for (let i = 0; i < segs.length; i++) {
        const p = r.pattern[i];
        if (typeof p === 'string') {
          if (p !== segs[i]) continue outer;
        } else {
          if (!segs[i]) continue outer;
          params[p.param] = decodeURIComponent(segs[i]);
        }
      }
      return { handler: r.handler, params };
    }
    return null;
  }

  return async function handle(req, res, ctx = {}) {
    const url = new URL(req.url, 'http://localhost');
    const path = stripGatewayPrefix(url.pathname);

    // MCP 端点（单一入口，宪法 III）：Bearer 令牌鉴权由 mcp 层处理
    if (path === '/mcp') {
      if (typeof onMcp === 'function') return onMcp(req, res, ctx);
      return sendError(res, 404, 'not_found', 'MCP 未启用');
    }

    if (path.startsWith('/api/')) {
      const m = matchRoute(req.method, path);
      if (m) return m.handler(req, res, { ...ctx, params: m.params });
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

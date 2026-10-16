// REST：用户资料（R003 个人设置 → 个人资料：昵称/头像）
// 契约见 specs/002-user-profile/spec.md；所有端点仅作用于当前身份（owner = identity.id）
// 安全：图片类型由 magic bytes 判定（不信 Content-Type/文件名）；文件名 sha256(ownerId) 杜绝穿越；
//       ≤2MB；响应 nosniff。昵称/头像为低风险偏好数据，不纳入 2FA 高危保护清单。
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sendJson, sendError, readJsonBody } from '../net/router.js';
import { resolveIdentity } from '../net/auth.js';

const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/** magic bytes 白名单：判定结果即落盘扩展名与响应 Content-Type 的唯一来源 */
const IMAGE_SIGNATURES = [
  {
    ext: 'png',
    mime: 'image/png',
    test: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  {
    ext: 'jpg',
    mime: 'image/jpeg',
    test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    ext: 'webp',
    mime: 'image/webp',
    test: (b) =>
      b.length >= 12 &&
      b.toString('ascii', 0, 4) === 'RIFF' &&
      b.toString('ascii', 8, 12) === 'WEBP',
  },
  {
    ext: 'gif',
    mime: 'image/gif',
    test: (b) =>
      b.length >= 6 &&
      (b.toString('ascii', 0, 6) === 'GIF87a' || b.toString('ascii', 0, 6) === 'GIF89a'),
  },
];

function sniffImage(buf) {
  return IMAGE_SIGNATURES.find((s) => s.test(buf)) ?? null;
}

/**
 * 读取原始二进制请求体（带大小上限）；超限 reject('payload_too_large')。
 * 超限后改为丢弃式排空（不 destroy socket），保证 413 响应可达客户端；
 * 上限仅 2MB，排空残留不构成带宽放大面。
 */
function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on('data', (c) => {
      if (overflow) return; // 丢弃后续数据直至 end
      size += c.length;
      if (size > limit) {
        overflow = true;
        chunks.length = 0;
        reject(new Error('payload_too_large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!overflow) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/** 头像文件名：sha256(ownerId) + 判定扩展名（内容寻主键，天然防穿越与猜枚） */
function avatarFileName(ownerId, ext) {
  return `${createHash('sha256').update(ownerId).digest('hex')}.${ext}`;
}

export function profileRoutes(deps) {
  const { runtime, store, audit } = deps;

  const requireIdentity = (req, res) => {
    const identity = resolveIdentity(req, runtime);
    if (!identity) {
      sendError(res, 401, 'unauthorized', '未认证');
      return null;
    }
    return identity;
  };

  return [
    {
      method: 'GET',
      path: '/api/profile',
      handler: async (req, res) => {
        const identity = requireIdentity(req, res);
        if (!identity) return;
        const rec = await store.getUserProfile(identity.id);
        sendJson(res, 200, {
          id: identity.id,
          username: identity.username,
          nickname: rec?.nickname ?? null,
          hasAvatar: Boolean(rec?.avatarExt),
          avatarUpdatedAt: rec?.avatarUpdatedAt ?? null,
        });
      },
    },
    {
      // 昵称保存：空串 = 清除（回退账号名展示）；账号 username 恒不可改
      method: 'PUT',
      path: '/api/profile',
      handler: async (req, res) => {
        const identity = requireIdentity(req, res);
        if (!identity) return;
        let body;
        try {
          body = await readJsonBody(req);
        } catch (e) {
          return sendError(res, 422, 'invalid_json', e.message);
        }
        if (body?.nickname === undefined) {
          return sendError(res, 422, 'invalid_field', 'nickname 必填');
        }
        let rec;
        try {
          rec = await store.saveUserProfile(identity.id, { nickname: body.nickname });
        } catch (e) {
          return sendError(res, 422, 'invalid_field', e.message);
        }
        audit?.log({
          event: 'profile_update',
          actorType: 'user',
          userId: identity.id,
          result: 'success',
          reason: 'nickname',
        });
        sendJson(res, 200, { ok: true, nickname: rec.nickname });
      },
    },
    {
      // 头像上传：原始二进制体；服务端 sniff 白名单 + 2MB 上限 + 原子替换
      method: 'POST',
      path: '/api/profile/avatar',
      handler: async (req, res) => {
        const identity = requireIdentity(req, res);
        if (!identity) return;
        let buf;
        try {
          buf = await readRawBody(req, AVATAR_MAX_BYTES);
        } catch (e) {
          if (e.message === 'payload_too_large') {
            return sendError(res, 413, 'payload_too_large', '头像文件不可超过 2MB');
          }
          return sendError(res, 400, 'bad_request', '请求体读取失败');
        }
        const sig = sniffImage(buf);
        if (!sig) {
          return sendError(res, 422, 'invalid_image', '仅支持 PNG / JPEG / WebP / GIF 图片');
        }
        const dir = store.avatarsDir;
        await mkdir(dir, { recursive: true });
        const finalPath = join(dir, avatarFileName(identity.id, sig.ext));
        // 原子替换：tmp 写入 + rename；先清其它扩展名旧文件（换格式场景）
        const tmpPath = `${finalPath}.tmp`;
        await writeFile(tmpPath, buf);
        try {
          await rename(tmpPath, finalPath);
        } catch (err) {
          await rm(tmpPath, { force: true });
          throw err;
        }
        for (const s of IMAGE_SIGNATURES) {
          if (s.ext !== sig.ext) {
            await rm(join(dir, avatarFileName(identity.id, s.ext)), { force: true });
          }
        }
        const ts = new Date().toISOString();
        await store.saveUserProfile(identity.id, { avatarExt: sig.ext, avatarUpdatedAt: ts });
        audit?.log({
          event: 'avatar_upload',
          actorType: 'user',
          userId: identity.id,
          result: 'success',
          reason: sig.mime,
        });
        sendJson(res, 200, { ok: true, avatarUpdatedAt: ts });
      },
    },
    {
      // 头像移除：幂等（无头像时同样 200）
      method: 'DELETE',
      path: '/api/profile/avatar',
      handler: async (req, res) => {
        const identity = requireIdentity(req, res);
        if (!identity) return;
        const dir = store.avatarsDir;
        for (const s of IMAGE_SIGNATURES) {
          await rm(join(dir, avatarFileName(identity.id, s.ext)), { force: true });
        }
        const had = Boolean((await store.getUserProfile(identity.id))?.avatarExt);
        await store.saveUserProfile(identity.id, { avatarExt: null, avatarUpdatedAt: null });
        if (had) {
          audit?.log({ event: 'avatar_delete', actorType: 'user', userId: identity.id, result: 'success' });
        }
        sendJson(res, 200, { ok: true });
      },
    },
    {
      // 头像读取：<img>/背景图直连；无头像 404 由前端回退首字样式
      method: 'GET',
      path: '/api/profile/avatar',
      handler: async (req, res) => {
        const identity = requireIdentity(req, res);
        if (!identity) return;
        const rec = await store.getUserProfile(identity.id);
        if (!rec?.avatarExt) return sendError(res, 404, 'not_found', '未设置头像');
        const sig = IMAGE_SIGNATURES.find((s) => s.ext === rec.avatarExt);
        let buf;
        try {
          buf = await readFile(join(store.avatarsDir, avatarFileName(identity.id, rec.avatarExt)));
        } catch {
          // 元数据与文件不一致（人工清理过 avatars 目录）：回退 404 并自愈元数据
          await store.saveUserProfile(identity.id, { avatarExt: null, avatarUpdatedAt: null });
          return sendError(res, 404, 'not_found', '头像文件缺失');
        }
        res.writeHead(200, {
          'content-type': sig?.mime ?? 'application/octet-stream',
          'content-length': buf.length,
          'cache-control': 'no-cache, must-revalidate',
          'x-content-type-options': 'nosniff',
        });
        res.end(buf);
      },
    },
  ];
}

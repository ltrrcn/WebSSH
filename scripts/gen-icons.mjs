// 生成 fnOS 应用包图标（无外部依赖，Node 内置 zlib 手写 PNG）
// 产出到 packaging/fnos/：ICON.PNG（64x64）、ICON_256.PNG（256x256）、app/ui/images/icon_{64,256}.png
// 图形与 web 端品牌 logo 完全一致（web/index.html .logo）：
// 蓝→紫 135° 渐变圆角方块 + 白色终端符号 ">_" + 顶部高光
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'packaging', 'fnos');

// CRC32（PNG 块校验）
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// —— 与 web 端 logo SVG（viewBox 24）一致的图形定义 ——
const C1 = [0x2f, 0x6f, 0xed]; // 渐变起点（左上，CSS 135deg）
const C2 = [0x7c, 0x5c, 0xff]; // 渐变终点（右下）
const FG = [0xff, 0xff, 0xff];
const CHEVRON = [
  [6.5, 9],
  [9.5, 11.6],
  [6.5, 14.2],
]; // ">" 折线
const UNDERLINE = [
  [12, 14.4],
  [17.5, 14.4],
]; // "_"（圆头端点）
const STROKE = 1.9; // 线宽（与 SVG stroke-width 一致）

/** 点到线段 [a,b] 的距离（SVG 24 坐标系） */
function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const gx = ax + t * dx - px;
  const gy = ay + t * dy - py;
  return Math.sqrt(gx * gx + gy * gy);
}

/** 到 ">_" 符号的距离（SVG 24 坐标系，折线两段 + 下划线一段） */
function distGlyph(px, py) {
  let d = Infinity;
  for (let i = 0; i < CHEVRON.length - 1; i++) {
    d = Math.min(d, distSeg(px, py, ...CHEVRON[i], ...CHEVRON[i + 1]));
  }
  d = Math.min(d, distSeg(px, py, ...UNDERLINE[0], ...UNDERLINE[1]));
  return d;
}

function makePng(size) {
  const W = size;
  const H = size;
  const px = Buffer.alloc(W * H * 4);
  const R = Math.floor(size * 0.18); // 圆角半径（与 .logo border-radius 8/28≈0.29 不同，沿用图标比例）

  // 像素 ↔ SVG 24 坐标换算；抗锯齿过渡带（像素空间约 1.25px）
  const toSvg = size / 24;
  const halfW = STROKE / 2;
  const aaBandSvg = (1.25 * 24) / size;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const inCorner =
        (x < R && y < R && (x - R) ** 2 + (y - R) ** 2 > R * R) ||
        (x >= W - R && y < R && (x - (W - R - 1)) ** 2 + (y - R) ** 2 > R * R) ||
        (x < R && y >= H - R && (x - R) ** 2 + (y - (H - R - 1)) ** 2 > R * R) ||
        (x >= W - R && y >= H - R && (x - (W - R - 1)) ** 2 + (y - (H - R - 1)) ** 2 > R * R);
      if (inCorner) {
        px.fill(0, i, i + 4);
        continue;
      }

      // 背景渐变：135° 对角（左上 C1 → 右下 C2）
      const t = (x + y) / (W + H - 2);
      let r = C1[0] + (C2[0] - C1[0]) * t;
      let g = C1[1] + (C2[1] - C1[1]) * t;
      let b = C1[2] + (C2[2] - C1[2]) * t;

      // 顶部内嵌高光（模拟 inset 0 1px 0 rgba(255,255,255,.25)，两条渐隐白线）
      const hl = y <= 1 ? 0.25 : y <= 3 ? 0.25 * (3 - (y - 1)) / 3 : 0;
      r += (255 - r) * hl;
      g += (255 - g) * hl;
      b += (255 - b) * hl;

      // 白色 ">_" 符号（带抗锯齿边缘）
      const d = distGlyph(x / toSvg, y / toSvg);
      const a = Math.max(0, Math.min(1, (halfW + aaBandSvg / 2 - d) / aaBandSvg));
      if (a > 0) {
        r += (FG[0] - r) * a;
        g += (FG[1] - g) * a;
        b += (FG[2] - b) * a;
      }

      px[i] = Math.round(r);
      px[i + 1] = Math.round(g);
      px[i + 2] = Math.round(b);
      px[i + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA

  const raw = Buffer.alloc(H * (W * 4 + 1));
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0;
    px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const i64 = makePng(64);
const i256 = makePng(256);
await mkdir(join(PKG_DIR, 'app', 'ui', 'images'), { recursive: true });
await writeFile(join(PKG_DIR, 'ICON.PNG'), i64);
await writeFile(join(PKG_DIR, 'ICON_256.PNG'), i256);
await writeFile(join(PKG_DIR, 'app', 'ui', 'images', 'icon_64.png'), i64);
await writeFile(join(PKG_DIR, 'app', 'ui', 'images', 'icon_256.png'), i256);
console.log('icons written to', PKG_DIR);

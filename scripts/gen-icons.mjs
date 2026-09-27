// fnOS 应用包图标生成（宪法 IX：资产矢量优先）
// 唯一真源：web/assets/logo.svg。本脚本解析该 SVG 并栅格化为 PNG——
// fnOS 平台要求的 ICON.PNG / ICON_256.PNG 是「生成产物」，禁止手绘像素或直接编辑位图。
// 无外部依赖（node:zlib 手写 PNG）；导出 parseLogoSvg / renderIcon 供单元测试导入。
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PKG_DIR = join(ROOT, 'packaging', 'fnos');
const SVG_PATH = join(ROOT, 'web', 'assets', 'logo.svg');

// ————— SVG 解析（受控子集：rect/linearGradient/polyline/line，正则解析足够） —————

const HEX = s => {
  const m = /^#([0-9a-f]{6})$/i.exec(s ?? '');
  if (!m) throw new Error(`不支持的描色格式: ${s}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** 解析 logo SVG，返回栅格化所需的几何与色彩描述 */
export function parseLogoSvg(svg) {
  const view = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(svg);
  if (!view) throw new Error('SVG 必须含 viewBox');
  const V = parseFloat(view[1]);

  // 渐变（objectBoundingBox 单位，支持任意两点方向）
  const grad = /<linearGradient[^>]*x1="([\d.]+)"[^>]*y1="([\d.]+)"[^>]*x2="([\d.]+)"[^>]*y2="([\d.]+)"/.exec(svg);
  const stops = [...svg.matchAll(/<stop offset="([\d.]+)" stop-color="(#[0-9a-fA-F]{6})"/g)]
    .sort((a, b) => parseFloat(a[1]) - parseFloat(b[1]))
    .map((m) => ({ offset: parseFloat(m[1]), color: HEX(m[2]) }));
  if (!grad || stops.length < 2) throw new Error('SVG 必须含 linearGradient 与至少两个 stop');

  // 背景 rect（fill=url(#..)）与圆角
  const bgRect = /<rect width="([\d.]+)" height="([\d.]+)" rx="([\d.]+)" fill="url\(/.exec(svg);
  if (!bgRect) throw new Error('SVG 必须含圆角背景 rect（fill=url(#…)）');
  const radiusRatio = parseFloat(bgRect[3]) / V;

  // 顶部高光 rect（白色 + opacity）
  const hlRect = /<rect y="0" width="[\d.]+" height="([\d.]+)" fill="#ffffff" opacity="([\d.]+)"/.exec(svg);

  // 描边线段：polyline 与 line（stroke + stroke-width）
  const strokes = [];
  for (const m of svg.matchAll(/<polyline points="([^"]+)"[^>]*stroke="#([0-9a-fA-F]{6})"[^>]*stroke-width="([\d.]+)"/g)) {
    const pts = m[1].trim().split(/\s+/).map((p) => p.split(',').map(Number));
    for (let i = 0; i < pts.length - 1; i++)
      strokes.push({ a: pts[i], b: pts[i + 1], width: parseFloat(m[3]), color: HEX(`#${m[2]}`) });
  }
  for (const m of svg.matchAll(
    /<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"[^>]*stroke="#([0-9a-fA-F]{6})"[^>]*stroke-width="([\d.]+)"/g
  )) {
    strokes.push({
      a: [parseFloat(m[1]), parseFloat(m[2])],
      b: [parseFloat(m[3]), parseFloat(m[4])],
      width: parseFloat(m[6]),
      color: HEX(`#${m[5]}`),
    });
  }
  if (!strokes.length) throw new Error('SVG 必须含至少一条描边线段');

  const hl = hlRect ? { heightRatio: parseFloat(hlRect[1]) / V, alpha: parseFloat(hlRect[2]) } : null;
  return {
    viewBox: V,
    gradient: {
      p1: [parseFloat(grad[1]), parseFloat(grad[2])],
      p2: [parseFloat(grad[3]), parseFloat(grad[4])],
      stops,
    },
    radiusRatio,
    highlight: hl,
    strokes,
  };
}

// ————— 栅格化（距离场描边 + 渐变投影 + 圆角 alpha + 抗锯齿） —————

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

function lerpColor(stops, t) {
  if (t <= stops[0].offset) return stops[0].color;
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i].offset) {
      const [a, b] = [stops[i - 1], stops[i]];
      const k = (t - a.offset) / (b.offset - a.offset || 1);
      return a.color.map((c, j) => c + (b.color[j] - c) * k);
    }
  }
  return stops[stops.length - 1].color;
}

/** 将解析结果栅格化为 RGBA 像素缓冲（size x size） */
export function renderPixels(parsed, size) {
  const { viewBox: V, gradient, radiusRatio, highlight, strokes } = parsed;
  const px = Buffer.alloc(size * size * 4);
  const R = Math.floor(size * radiusRatio);
  const toSvg = size / V;

  // 渐变方向（objectBoundingBox → 像素空间）
  const [x1, y1] = [gradient.p1[0] * size, gradient.p1[1] * size];
  const dx = (gradient.p2[0] - gradient.p1[0]) * size;
  const dy = (gradient.p2[1] - gradient.p1[1]) * size;
  const d2 = dx * dx + dy * dy || 1;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inCorner =
        (x < R && y < R && (x - R) ** 2 + (y - R) ** 2 > R * R) ||
        (x >= size - R && y < R && (x - (size - R - 1)) ** 2 + (y - R) ** 2 > R * R) ||
        (x < R && y >= size - R && (x - R) ** 2 + (y - (size - R - 1)) ** 2 > R * R) ||
        (x >= size - R && y >= size - R && (x - (size - R - 1)) ** 2 + (y - (size - R - 1)) ** 2 > R * R);
      if (inCorner) continue; // 透明

      // 渐变背景（沿渐变方向投影）
      let t = ((x - x1) * dx + (y - y1) * dy) / d2;
      t = Math.max(0, Math.min(1, t));
      const [r, g, b] = lerpColor(gradient.stops, t);

      // 顶部高光（高 h 全 alpha，随后 2h 线性渐隐）
      let hr = r, hg = g, hb = b;
      if (highlight) {
        const hPx = highlight.heightRatio * size;
        const a = y <= hPx ? highlight.alpha : y <= hPx * 3 ? highlight.alpha * (1 - (y - hPx) / (hPx * 2)) : 0;
        hr += (255 - r) * a; hg += (255 - g) * a; hb += (255 - b) * a;
      }

      // 描边线段（距离场 + ~1.25px 抗锯齿）
      const sx = x / toSvg, sy = y / toSvg;
      const aa = (1.25 * V) / size;
      let wA = 0, wColor = strokes[0].color;
      for (const s of strokes) {
        const d = distSeg(sx, sy, s.a[0], s.a[1], s.b[0], s.b[1]);
        const a = Math.max(0, Math.min(1, (s.width / 2 + aa / 2 - d) / aa));
        if (a > wA) { wA = a; wColor = s.color; }
      }
      const fr = hr + (wColor[0] - hr) * wA;
      const fg = hg + (wColor[1] - hg) * wA;
      const fb = hb + (wColor[2] - hb) * wA;

      px[i] = Math.round(fr);
      px[i + 1] = Math.round(fg);
      px[i + 2] = Math.round(fb);
      px[i + 3] = 255;
    }
  }
  return px;
}

// ————— PNG 编码 —————

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  let c = 0xffffffff;
  for (let i = 0; i < body.length; i++) c = CRC_TABLE[(c ^ body[i]) & 0xff] ^ (c >>> 8);
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, body, crc]);
}

/** RGBA 像素缓冲 → PNG 文件内容 */
export function encodePng(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 从 SVG 真源渲染指定尺寸的 PNG */
export async function renderIcon(size, svgPath = SVG_PATH) {
  const svg = await readFile(svgPath, 'utf8');
  return encodePng(renderPixels(parseLogoSvg(svg), size), size);
}

// ————— CLI：生成 fnOS 图标产物 —————

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const i64 = await renderIcon(64);
  const i256 = await renderIcon(256);
  await mkdir(join(PKG_DIR, 'app', 'ui', 'images'), { recursive: true });
  await writeFile(join(PKG_DIR, 'ICON.PNG'), i64);
  await writeFile(join(PKG_DIR, 'ICON_256.PNG'), i256);
  await writeFile(join(PKG_DIR, 'app', 'ui', 'images', 'icon_64.png'), i64);
  await writeFile(join(PKG_DIR, 'app', 'ui', 'images', 'icon_256.png'), i256);
  console.log('icons rendered from', SVG_PATH, '->', PKG_DIR);
}

// 生成 fnOS 应用包图标（无外部依赖，Node 内置 zlib 手写 PNG）
// 产出到 packaging/fnos/：ICON.PNG（64x64）、ICON_256.PNG（256x256）、app/ui/images/icon_{64,256}.png
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

/** 极简图标：圆角蓝底 + 白色终端块 + 蓝色提示符行 */
function makePng(size) {
  const W = size;
  const H = size;
  const px = Buffer.alloc(W * H * 4);
  const A = [0x2f, 0x6f, 0xed];
  const FG = [0xff, 0xff, 0xff];
  const R = Math.floor(size * 0.18);

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
      const cx = x / W;
      const cy = y / H;
      const inBlock = cx > 0.32 && cx < 0.68 && cy > 0.36 && cy < 0.66;
      let color = A;
      if (inBlock) {
        color = FG;
        const tx = (cx - 0.32) / 0.36;
        const ty = (cy - 0.36) / 0.3;
        if (ty > 0.15 && ty < 0.4 && tx > 0.12 && tx < 0.5) color = A;
        if (ty > 0.6 && ty < 0.75 && tx > 0.12 && tx < 0.28) color = A;
      }
      px[i] = color[0];
      px[i + 1] = color[1];
      px[i + 2] = color[2];
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

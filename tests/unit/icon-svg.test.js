// 宪法 IX（资产矢量优先）+ 第 V 条：SVG 真源解析与栅格化的单元测试
import { test } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLogoSvg, renderPixels, encodePng } from '../../scripts/gen-icons.mjs';

const SVG = await readFile(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'assets', 'logo.svg'),
  'utf8'
);

test('宪法IX: SVG 真源可解析（viewBox / 渐变 / 圆角 / 描边）', () => {
  const p = parseLogoSvg(SVG);
  assert.equal(p.viewBox, 24);
  assert.equal(p.gradient.p1[0], 0);
  assert.deepEqual(p.gradient.stops[0].color, [0x2f, 0x6f, 0xed]);
  assert.deepEqual(p.gradient.stops.at(-1).color, [0x7c, 0x5c, 0xff]);
  assert.ok(p.radiusRatio > 0 && p.radiusRatio < 0.5);
  assert.ok(p.strokes.length >= 3, '>_ 符号至少 3 段线段');
  for (const s of p.strokes) {
    assert.deepEqual(s.color, [255, 255, 255]);
    assert.ok(s.width > 0);
  }
  assert.ok(p.highlight && p.highlight.alpha > 0, '顶部高光存在');
});

test('宪法IX: 栅格化产物像素正确（渐变 / 白线 / 透明圆角 / 高光）', () => {
  const size = 256;
  const px = renderPixels(parseLogoSvg(SVG), size);
  const at = (x, y) => {
    const i = (y * size + x) * 4;
    return [px[i], px[i + 1], px[i + 2], px[i + 3]];
  };
  // 圆角外透明
  assert.equal(at(2, 2)[3], 0);
  // 渐变两端（对角投影：t≈0 / t≈1）
  const tl = at(40, 40), br = at(215, 215);
  assert.ok(Math.abs(tl[0] - 0x2f) < 24 && Math.abs(tl[2] - 0xed) < 24, `左上接近蓝: ${tl}`);
  assert.ok(Math.abs(br[0] - 0x7c) < 24 && Math.abs(br[2] - 0xff) < 24, `右下接近紫: ${br}`);
  // ">" 折点与下划线中点为白色（>_.(9.5,11.6) 与 (14.75,14.4)）
  const k = size / 24;
  const chevron = at(Math.round(9.5 * k), Math.round(11.6 * k));
  const under = at(Math.round(14.75 * k), Math.round(14.4 * k));
  assert.ok(chevron[0] > 240 && chevron[1] > 240 && chevron[2] > 240, `顶点偏白: ${chevron}`);
  assert.ok(under[0] > 240 && under[1] > 240 && under[2] > 240, `下划线偏白: ${under}`);
  // 顶部高光：y=0 行比 y=8 行更亮（同列）
  const top = at(128, 0), mid = at(128, Math.round(8 * k));
  assert.ok(top[0] >= mid[0], '顶部高光使首行更亮');
});

test('宪法IX: PNG 编码合法且两尺寸确定性一致', async () => {
  const p = parseLogoSvg(SVG);
  for (const size of [64, 256]) {
    const png = encodePng(renderPixels(p, size), size);
    // PNG 魔数 + IHDR 尺寸
    assert.equal(png.readUInt32BE(0), 0x89504e47);
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
  // 确定性：同尺寸两次渲染逐字节一致
  const a = encodePng(renderPixels(p, 64), 64);
  const b = encodePng(renderPixels(p, 64), 64);
  assert.ok(a.equals(b));
});

test('宪法IX: UI 图标 sprite 合规（symbol 定义 + 无 emoji 图标）', async () => {
  const { readFile: rf } = await import('node:fs/promises');
  const sprite = await rf(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'assets', 'icons.svg'),
    'utf8'
  );
  // sprite 提供当前 UI 引用的全部图标
  const ids = [...sprite.matchAll(/<symbol id="(\w+)"/g)].map((m) => m[1]);
  for (const need of ['plus', 'x', 'gear', 'play', 'pencil', 'trash', 'palette', 'list', 'key', 'shield', 'file']) {
    assert.ok(ids.includes(need), `sprite 缺少图标: ${need}`);
  }
  // 源码禁止 emoji / Unicode 符号图标（宪法 IX）
  const { readdir } = await import('node:fs/promises');
  const webSrc = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
  const banned = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]|[＋▶✎🗑⚙✕🗝]/u;
  const checkDir = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await checkDir(p);
      else if (/\.(js|html)$/.test(e.name)) {
        const src = await rf(p, 'utf8');
        const hit = src.match(banned);
        assert.ok(!hit, `${p} 含禁止的 emoji/Unicode 图标: ${hit?.[0]}`);
      }
    }
  };
  await checkDir(join(webSrc, 'src'));
  await checkDir(webSrc); // index.html
});

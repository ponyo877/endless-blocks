// Renders preview sheets of the procedural textures.
//   npx tsx scripts/texture-sheet.ts            -> textures.png, tinted.png, tiling.png
//   npx tsx scripts/texture-sheet.ts a b c      -> additionally zoom.png with layers a, b, c at x16
// Output goes to scripts/out/ (git-ignored).

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateTextures, missingGenerators } from '../src/render/textures';
import { TEXTURES, layerOf } from '../src/gen/textureNames';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- PNG encoder

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(w: number, h: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

// ---------------------------------------------------------------- image helpers

class Img {
  readonly data: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
    bg: number,
  ) {
    this.data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      this.data[i * 4] = (bg >> 16) & 255;
      this.data[i * 4 + 1] = (bg >> 8) & 255;
      this.data[i * 4 + 2] = bg & 255;
      this.data[i * 4 + 3] = 255;
    }
  }
  blend(x: number, y: number, r: number, g: number, b: number, a: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    const t = a / 255;
    this.data[i] = Math.round(this.data[i] * (1 - t) + r * t);
    this.data[i + 1] = Math.round(this.data[i + 1] * (1 - t) + g * t);
    this.data[i + 2] = Math.round(this.data[i + 2] * (1 - t) + b * t);
  }
  rect(x0: number, y0: number, w: number, h: number, c: number): void {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.blend(x, y, (c >> 16) & 255, (c >> 8) & 255, c & 255, 255);
  }
  save(name: string): void {
    writeFileSync(join(OUT, name), encodePng(this.w, this.h, this.data));
    console.log(`wrote scripts/out/${name} (${this.w}x${this.h})`);
  }
}

// ---------------------------------------------------------------- generate

const t0 = performance.now();
const tex = generateTextures();
const tFirst = performance.now() - t0;
let tSum = 0;
const RUNS = 10;
for (let k = 0; k < RUNS; k++) {
  const t = performance.now();
  generateTextures();
  tSum += performance.now() - t;
}
console.log(`generateTextures(): first ${tFirst.toFixed(1)} ms, avg of ${RUNS} more ${(tSum / RUNS).toFixed(1)} ms, ${tex.layers} layers`);
const missing = missingGenerators();
if (missing.length) console.log(`MISSING generators: ${missing.join(', ')}`);

const layerNames: string[] = [];
for (const t of TEXTURES) {
  const f = t.frames ?? 1;
  for (let k = 0; k < f; k++) layerNames.push(f > 1 ? `${t.name}#${k}` : t.name);
}

type Tint = number | null;

const TINTS: Record<string, number> = {
  grass_top: 0x79c05a,
  grass_side: 0x79c05a,
  short_grass: 0x79c05a,
  fern: 0x79c05a,
  tall_grass_bottom: 0x79c05a,
  tall_grass_top: 0x79c05a,
  oak_leaves: 0x59ae30,
  jungle_leaves: 0x59ae30,
  acacia_leaves: 0x59ae30,
  dark_oak_leaves: 0x59ae30,
  vine: 0x59ae30,
  birch_leaves: 0x80a755,
  spruce_leaves: 0x619961,
  lily_pad: 0x208030,
  water: 0x3f76e4,
};

/** Draw a layer at (ox, oy) scaled by s, optionally applying tint via the mask. */
function drawLayer(img: Img, layer: number, ox: number, oy: number, s: number, tint: Tint): void {
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const i = (layer * 256 + y * 16 + x) * 4;
      let r = tex.rgba[i];
      let g = tex.rgba[i + 1];
      let b = tex.rgba[i + 2];
      const a = tex.rgba[i + 3];
      if (tint !== null) {
        const m = tex.mask[layer * 256 + y * 16 + x] / 255;
        r = r * (1 + (((tint >> 16) & 255) / 255 - 1) * m);
        g = g * (1 + (((tint >> 8) & 255) / 255 - 1) * m);
        b = b * (1 + ((tint & 255) / 255 - 1) * m);
      }
      for (let yy = 0; yy < s; yy++) for (let xx = 0; xx < s; xx++) img.blend(ox + x * s + xx, oy + y * s + yy, r, g, b, a);
    }
}

// ---------------------------------------------------------------- 1. textures.png

{
  const S = 6;
  const cell = 16 * S;
  const cols = 12;
  const rows = Math.ceil(tex.layers / cols);
  const img = new Img(cols * (cell + 2) + 2, rows * (cell + 2) + 2, 0x808080);
  for (let l = 0; l < tex.layers; l++) {
    const cx = 2 + (l % cols) * (cell + 2);
    const cy = 2 + Math.floor(l / cols) * (cell + 2);
    drawLayer(img, l, cx, cy, S, null);
    console.log(`${l} ${layerNames[l]}`);
  }
  img.save('textures.png');
}

// ---------------------------------------------------------------- 2. tinted.png

{
  const S = 6;
  const cell = 16 * S;
  const cols = 8;
  const list: number[] = [];
  for (let l = 0; l < tex.layers; l++) {
    const base = layerNames[l].split('#')[0];
    if (TINTS[base] !== undefined) list.push(l);
  }
  const rows = Math.ceil(list.length / cols);
  const img = new Img(cols * (cell + 2) + 2, rows * (cell + 2) + 2, 0x808080);
  console.log('tinted.png:');
  list.forEach((l, k) => {
    const cx = 2 + (k % cols) * (cell + 2);
    const cy = 2 + Math.floor(k / cols) * (cell + 2);
    const base = layerNames[l].split('#')[0];
    if (base === 'water') img.rect(cx, cy, cell, cell, 0xd8c890);
    drawLayer(img, l, cx, cy, S, TINTS[base]);
    console.log(`  ${k} ${layerNames[l]}`);
  });
  img.save('tinted.png');
}

// ---------------------------------------------------------------- 3. tiling.png

function tilingSheet(file: string, items: { name: string; tint: Tint; bg?: number }[], reps: number, s: number, cols: number): void {
  const patch = reps * 16 * s;
  const rows = Math.ceil(items.length / cols);
  const img = new Img(cols * (patch + 4) + 4, rows * (patch + 4) + 4, 0x303030);
  items.forEach((it, k) => {
    const ox = 4 + (k % cols) * (patch + 4);
    const oy = 4 + Math.floor(k / cols) * (patch + 4);
    if (it.bg !== undefined) img.rect(ox, oy, patch, patch, it.bg);
    const l = layerOf(it.name);
    for (let ty = 0; ty < reps; ty++) for (let tx = 0; tx < reps; tx++) drawLayer(img, l, ox + tx * 16 * s, oy + ty * 16 * s, s, it.tint);
  });
  img.save(file);
}

tilingSheet(
  'tiling.png',
  [
    { name: 'grass_top', tint: 0x79c05a },
    { name: 'stone', tint: null },
    { name: 'dirt', tint: null },
    { name: 'sand', tint: null },
    { name: 'gravel', tint: null },
    { name: 'oak_leaves', tint: 0x59ae30, bg: 0x87b7ff },
    { name: 'water', tint: 0x3f76e4, bg: 0xd8c890 },
    { name: 'snow', tint: null },
    { name: 'cobblestone', tint: null },
    { name: 'oak_planks', tint: null },
    { name: 'terracotta_orange', tint: null },
    { name: 'red_sand', tint: null },
  ],
  6,
  4,
  4,
);

// ---------------------------------------------------------------- optional zoom

const args = process.argv.slice(2);
if (args.length) {
  const S = 16;
  const cell = 16 * S;
  const cols = Math.min(4, args.length);
  const layers: { l: number; name: string }[] = [];
  for (const a of args) {
    const [n, fr] = a.split('#');
    layers.push({ l: layerOf(n) + (fr ? Number(fr) : 0), name: n });
  }
  const rows = Math.ceil(layers.length / cols);
  const img = new Img(cols * (cell + 4) + 4, rows * (cell + 4) + 4, 0x808080);
  layers.forEach(({ l, name }, k) => {
    const ox = 4 + (k % cols) * (cell + 4);
    const oy = 4 + Math.floor(k / cols) * (cell + 4);
    if (name === 'water') img.rect(ox, oy, cell, cell, 0xd8c890);
    drawLayer(img, l, ox, oy, S, TINTS[name] ?? null);
  });
  img.save('zoom.png');
}

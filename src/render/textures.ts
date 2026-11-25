// Procedural 16x16 pixel-art block textures.
//
// Pure TypeScript: no DOM, no three.js, no Math.random. Every texture is generated from a
// PRNG seeded by its name, so output is identical in Node and in the browser.
//
// Layout of the result (see TextureSet):
//   rgba offset = ((layer*16 + y)*16 + x)*4, y = 0 is the TOP row
//   mask offset = (layer*16 + y)*16 + x, 255 = multiply by biome tint
//
// Conventions used by the generators:
//   - colours are 0xRRGGBB numbers
//   - terrain / wood / building textures wrap (all neighbour lookups use & 15)
//   - sprites (plants etc.) are drawn on a Canvas without wrap, standing on the bottom row

import { TEXTURES, TEXTURE_LAYER_COUNT, type TextureSpec } from '../gen/textureNames';

export interface TextureSet {
  layers: number;
  rgba: Uint8Array;
  mask: Uint8Array;
}

const S = 16;
const N = S * S;

// ------------------------------------------------------------------------------------------
// PRNG
// ------------------------------------------------------------------------------------------

class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    // mulberry32
    let t = (this.s = (this.s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }
}

function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

const rngFor = (name: string): Rng => new Rng(hashStr(name));

// ------------------------------------------------------------------------------------------
// Colour helpers
// ------------------------------------------------------------------------------------------

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const rgb = (r: number, g: number, b: number): number => (clamp255(r) << 16) | (clamp255(g) << 8) | clamp255(b);
const grey = (v: number): number => rgb(v, v, v);
const R = (c: number): number => (c >> 16) & 255;
const G = (c: number): number => (c >> 8) & 255;
const B = (c: number): number => c & 255;

/** Multiply brightness. */
function shade(c: number, f: number): number {
  return rgb(R(c) * f, G(c) * f, B(c) * f);
}
function mix(a: number, b: number, t: number): number {
  return rgb(lerp(R(a), R(b), t), lerp(G(a), G(b), t), lerp(B(a), B(b), t));
}
/** Build an n-step ramp between colour stops (dark -> light). */
function ramp(stops: number[], n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(t));
    out.push(mix(stops[k], stops[k + 1], t - k));
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// Layer (a 16x16 view into the big arrays) and Canvas (sprite scratch buffer)
// ------------------------------------------------------------------------------------------

const ix = (x: number, y: number): number => ((y & 15) << 4) | (x & 15);

class Layer {
  constructor(
    readonly px: Uint8Array,
    readonly mask: Uint8Array,
  ) {}
  /** Wrapping set. */
  set(x: number, y: number, c: number, a = 255): void {
    const i = ix(x, y) << 2;
    this.px[i] = (c >> 16) & 255;
    this.px[i + 1] = (c >> 8) & 255;
    this.px[i + 2] = c & 255;
    this.px[i + 3] = a;
  }
  get(x: number, y: number): number {
    const i = ix(x, y) << 2;
    return (this.px[i] << 16) | (this.px[i + 1] << 8) | this.px[i + 2];
  }
  alpha(x: number, y: number): number {
    return this.px[(ix(x, y) << 2) + 3];
  }
  setA(x: number, y: number, a: number): void {
    this.px[(ix(x, y) << 2) + 3] = a;
  }
  fill(c: number, a = 255): void {
    for (let i = 0; i < N; i++) this.set(i & 15, i >> 4, c, a);
  }
  /** Copy another layer's pixels. */
  copy(o: Layer): void {
    this.px.set(o.px);
  }
}

/** Sprite canvas without wrap. -1 = transparent. */
class Canvas {
  readonly c: Int32Array;
  constructor(
    readonly w = S,
    readonly h = S,
  ) {
    this.c = new Int32Array(w * h).fill(-1);
  }
  put(x: number, y: number, col: number): void {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.c[y * this.w + x] = col;
  }
  get(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return -1;
    return this.c[y * this.w + x];
  }
  has(x: number, y: number): boolean {
    return this.get(x, y) >= 0;
  }
  /** Draw into a layer from canvas row offset oy. */
  toLayer(L: Layer, oy = 0): void {
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const col = this.get(x, y + oy);
        if (col < 0) L.set(x, y, 0, 0);
        else L.set(x, y, col, 255);
      }
  }
  line(x0: number, y0: number, x1: number, y1: number, col: number | ((t: number) => number)): void {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      this.put(lerp(x0, x1, t), lerp(y0, y1, t), typeof col === 'number' ? col : col(t));
    }
  }
  /** Pixel map: rows top->bottom, aligned to the bottom of the canvas. */
  map(rows: string[], pal: Record<string, number>, ox = 0, oy?: number): void {
    const y0 = oy ?? this.h - rows.length;
    for (let r = 0; r < rows.length; r++)
      for (let x = 0; x < rows[r].length; x++) {
        const ch = rows[r][x];
        if (ch === '.' || ch === ' ') continue;
        const col = pal[ch];
        if (col === undefined) continue;
        this.put(x + ox, y0 + r, col);
      }
  }
}

// ------------------------------------------------------------------------------------------
// Noise
// ------------------------------------------------------------------------------------------

type Field = Float32Array;
const sstep = (t: number): number => t * t * (3 - 2 * t);

/** Tileable value noise with lattice cell cx by cy pixels (cx, cy divide 16). */
// Per-axis sample tables for each cell size: knot index pair and smoothed weight.
const _axis = new Map<number, { k0: Int32Array; k1: Int32Array; t: Float32Array }>();
function axis(c: number): { k0: Int32Array; k1: Int32Array; t: Float32Array } {
  let a = _axis.get(c);
  if (a) return a;
  const n = S / c;
  a = { k0: new Int32Array(S), k1: new Int32Array(S), t: new Float32Array(S) };
  for (let p = 0; p < S; p++) {
    const g = c === 1 ? p : (p + 0.5) / c;
    const i = Math.floor(g);
    a.k0[p] = i % n;
    a.k1[p] = (i + 1) % n;
    a.t[p] = sstep(g - i);
  }
  _axis.set(c, a);
  return a;
}

/** Tileable value noise with lattice cell cx by cy pixels (cx, cy divide 16). */
function lattice(rng: Rng, cx: number, cy: number): Field {
  const out = new Float32Array(N);
  if (cx === 1 && cy === 1) {
    for (let i = 0; i < N; i++) out[i] = rng.next();
    return out;
  }
  const nx = S / cx;
  const ny = S / cy;
  const g = new Float32Array(nx * ny);
  for (let i = 0; i < g.length; i++) g[i] = rng.next();
  const ax = axis(cx);
  const ay = axis(cy);
  for (let y = 0; y < S; y++) {
    const y0 = ay.k0[y] * nx;
    const y1 = ay.k1[y] * nx;
    const ty = ay.t[y];
    for (let x = 0; x < S; x++) {
      const x0 = ax.k0[x];
      const x1 = ax.k1[x];
      const tx = ax.t[x];
      const a = g[y0 + x0] + (g[y0 + x1] - g[y0 + x0]) * tx;
      const b = g[y1 + x0] + (g[y1 + x1] - g[y1 + x0]) * tx;
      out[y * S + x] = a + (b - a) * ty;
    }
  }
  return out;
}

/** Sum of lattice octaves: [cx, cy, weight][] */
function fbm(rng: Rng, oct: [number, number, number][]): Field {
  const out = new Float32Array(N);
  let wsum = 0;
  for (const [cx, cy, w] of oct) {
    const l = lattice(rng, cx, cy);
    for (let i = 0; i < N; i++) out[i] += l[i] * w;
    wsum += w;
  }
  for (let i = 0; i < N; i++) out[i] /= wsum;
  return out;
}

const _keys = new Uint32Array(N);
/** Rank-normalise (histogram equalise) to (0,1). Uses a packed native numeric sort (fast). */
function rank(f: Field): Field {
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < N; i++) {
    if (f[i] < mn) mn = f[i];
    if (f[i] > mx) mx = f[i];
  }
  const k = 0xffffff / (mx - mn || 1);
  for (let i = 0; i < N; i++) _keys[i] = ((Math.floor((f[i] - mn) * k) << 8) | i) >>> 0;
  _keys.sort();
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[_keys[i] & 255] = (i + 0.5) / N;
  return out;
}

/**
 * High-pass: subtract `amt` times the wrapped 9x9 box average. Removes tile-sized blotches that
 * would otherwise show up as an obvious repeating pattern when the block is seen in big expanses.
 */
function flatten(f: Field, amt: number): Field {
  const tmp = new Float32Array(N);
  const out = new Float32Array(N);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      let a = 0;
      for (let d = -4; d <= 4; d++) a += f[ix(x + d, y)];
      tmp[y * S + x] = a / 9;
    }
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      let a = 0;
      for (let d = -4; d <= 4; d++) a += tmp[ix(x, y + d)];
      out[y * S + x] = f[y * S + x] - (a / 9) * amt;
    }
  return out;
}

/** Index of the band v falls in for ascending thresholds. */
function q(v: number, th: readonly number[]): number {
  let k = 0;
  while (k < th.length && v >= th[k]) k++;
  return k;
}

function paintField(L: Layer, f: Field, pal: readonly number[], th: readonly number[]): void {
  for (let i = 0; i < N; i++) L.set(i & 15, i >> 4, pal[q(f[i], th)]);
}

/** Tileable 3D value noise, periodic in x, y and time (Catmull-Rom in time). */
function noise3(rng: Rng, cell: number, knots: number, frames: number): Float32Array {
  const slices: Field[] = [];
  for (let k = 0; k < knots; k++) slices.push(lattice(rng, cell, cell));
  const out = new Float32Array(frames * N);
  for (let f = 0; f < frames; f++) {
    const tt = (f * knots) / frames;
    const it = Math.floor(tt);
    const t = tt - it;
    const p0 = slices[(it - 1 + knots) % knots];
    const p1 = slices[it % knots];
    const p2 = slices[(it + 1) % knots];
    const p3 = slices[(it + 2) % knots];
    const t2 = t * t;
    const t3 = t2 * t;
    for (let i = 0; i < N; i++) {
      out[f * N + i] =
        0.5 *
        (2 * p1[i] +
          (-p0[i] + p2[i]) * t +
          (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 +
          (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3);
    }
  }
  return out;
}

// ---- Voronoi (toroidal) ----

interface Vor {
  id: Int16Array;
  f1: Field;
  f2: Field;
  dx: Field;
  dy: Field;
}

function voronoi(pts: number[][], ax = 1, ay = 1): Vor {
  const v: Vor = {
    id: new Int16Array(N),
    f1: new Float32Array(N),
    f2: new Float32Array(N),
    dx: new Float32Array(N),
    dy: new Float32Array(N),
  };
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      let b1 = 1e9;
      let b2 = 1e9;
      let bid = 0;
      let bdx = 0;
      let bdy = 0;
      for (let k = 0; k < pts.length; k++) {
        let dx = x + 0.5 - pts[k][0];
        let dy = y + 0.5 - pts[k][1];
        dx -= S * Math.round(dx / S);
        dy -= S * Math.round(dy / S);
        const d = Math.sqrt(dx * dx * ax + dy * dy * ay) * (pts[k][2] ?? 1);
        if (d < b1) {
          b2 = b1;
          b1 = d;
          bid = k;
          bdx = dx;
          bdy = dy;
        } else if (d < b2) b2 = d;
      }
      const i = y * S + x;
      v.id[i] = bid;
      v.f1[i] = b1;
      v.f2[i] = b2;
      v.dx[i] = bdx;
      v.dy[i] = bdy;
    }
  return v;
}

function jitterGrid(rng: Rng, n: number, j: number): number[][] {
  const pts: number[][] = [];
  const c = S / n;
  for (let gy = 0; gy < n; gy++)
    for (let gx = 0; gx < n; gx++) pts.push([(gx + 0.5 + (rng.next() - 0.5) * j) * c, (gy + 0.5 + (rng.next() - 0.5) * j) * c]);
  return pts;
}

/** Toroidal Poisson-ish scatter. */
function scatter(rng: Rng, count: number, minDist: number): number[][] {
  const pts: number[][] = [];
  for (let tries = 0; tries < count * 40 && pts.length < count; tries++) {
    const p = [rng.range(0, S), rng.range(0, S)];
    let ok = true;
    for (const o of pts) {
      let dx = Math.abs(p[0] - o[0]);
      let dy = Math.abs(p[1] - o[1]);
      dx = Math.min(dx, S - dx);
      dy = Math.min(dy, S - dy);
      if (dx * dx + dy * dy < minDist * minDist) {
        ok = false;
        break;
      }
    }
    if (ok) pts.push(p);
  }
  return pts;
}

/**
 * Evenly spread 1-2 px specks (blue-noise placement). Extreme shades placed this way stay
 * uniform at distance instead of clumping into a visible repeating blotch.
 */
function specks(rng: Rng, count: number, minDist: number, pairChance: number, fn: (x: number, y: number) => void): void {
  for (const [px, py] of scatter(rng, count, minDist)) {
    const x = Math.floor(px);
    const y = Math.floor(py);
    fn(x, y);
    if (rng.chance(pairChance)) {
      if (rng.chance(0.5)) fn(x + 1, y);
      else fn(x, y + 1);
    }
  }
}

// ------------------------------------------------------------------------------------------
// Shared bases
// ------------------------------------------------------------------------------------------

const STONE_PAL = [0x6d6d6d, 0x757575, 0x7d7d7d, 0x858585, 0x8e8e8e];
let _stoneIdx: Uint8Array | null = null;
function stoneIdx(): Uint8Array {
  if (_stoneIdx) return _stoneIdx;
  const r = rngFor('stone-base');
  const f = rank(flatten(fbm(r, [[8, 8, 0.3], [4, 4, 0.55], [4, 2, 0.3], [2, 2, 0.55], [1, 1, 0.55]]), 0.9));
  const out = new Uint8Array(N);
  for (let i = 0; i < N; i++) out[i] = q(f[i], [0.1, 0.32, 0.68, 0.9]);
  // short darker horizontal streaks, evenly spread so they don't clump
  for (const [px, py] of scatter(r, 7, 4.5)) {
    const len = 2 + r.int(2);
    for (let d = 0; d < len; d++) {
      const i = ix(Math.floor(px) + d, Math.floor(py));
      out[i] = Math.max(0, Math.min(out[i], 2) - 1);
    }
  }
  _stoneIdx = out;
  return out;
}
function stoneInto(L: Layer): void {
  const s = stoneIdx();
  for (let i = 0; i < N; i++) L.set(i & 15, i >> 4, STONE_PAL[s[i]]);
}

const DIRT_PAL = [0x5f402a, 0x6a4931, 0x775437, 0x835e3f, 0x8e6847];
let _dirt: Uint8Array | null = null;
function dirtIdx(): Uint8Array {
  if (_dirt) return _dirt;
  const r = rngFor('dirt-base');
  const f = rank(flatten(fbm(r, [[4, 4, 0.3], [2, 2, 0.5], [1, 1, 0.9]]), 0.85));
  const out = new Uint8Array(N);
  for (let i = 0; i < N; i++) out[i] = 1 + q(f[i], [0.3, 0.72, 0.94]);
  specks(r, 15, 3.4, 0.5, (x, y) => (out[ix(x, y)] = 0));
  _dirt = out;
  return out;
}
function dirtInto(L: Layer): void {
  const d = dirtIdx();
  for (let i = 0; i < N; i++) L.set(i & 15, i >> 4, DIRT_PAL[d[i]]);
}

/** Greyscale grass value at (x,y). */
let _grass: Uint8Array | null = null;
function grassVal(): Uint8Array {
  if (_grass) return _grass;
  const r = rngFor('grass-base');
  const f = rank(fbm(r, [[4, 4, 0.25], [2, 2, 0.6], [1, 1, 0.75]]));
  const pal = [150, 162, 174, 186, 198, 212];
  const out = new Uint8Array(N);
  for (let i = 0; i < N; i++) out[i] = pal[q(f[i], [0.05, 0.2, 0.47, 0.76, 0.94])];
  _grass = out;
  return out;
}

/** Per-column fringe depth with an irregular lower edge. */
function fringeDepths(rng: Rng, base: number, vary: number, tufts: number): number[] {
  const n = lattice(rng, 4, 16);
  const d: number[] = [];
  for (let x = 0; x < S; x++) d.push(Math.round(base + (n[x] - 0.5) * 2 * vary + (rng.next() - 0.5) * 1.2));
  for (let k = 0; k < tufts; k++) {
    const x = rng.int(16);
    d[x] += 1 + rng.int(2);
  }
  return d.map((v) => Math.max(1, Math.min(6, v)));
}

function fringeSide(L: Layer, rng: Rng, depth: number[], colorAt: (x: number, y: number, last: boolean) => number, maskVal = 0): void {
  dirtInto(L);
  for (let x = 0; x < S; x++) {
    const dep = depth[x];
    for (let y = 0; y < dep; y++) {
      L.set(x, y, colorAt(x, y, y === dep - 1));
      L.mask[ix(x, y)] = maskVal;
    }
    L.set(x, dep, shade(L.get(x, dep), 0.82));
  }
}

// ------------------------------------------------------------------------------------------
// Terrain generators
// ------------------------------------------------------------------------------------------

function cobble(L: Layer, rng: Rng): Vor {
  const pts = jitterGrid(rng, 3, 0.9);
  for (const p of scatter(rng, 4, 3)) pts.push(p);
  for (const p of pts) p.push(rng.range(0.85, 1.15));
  const v = voronoi(pts);
  const tone = pts.map(() => rng.range(-0.14, 0.14));
  const wn = lattice(rng, 1, 1);
  const pal = [0x5c5c5c, 0x686868, 0x737373, 0x7e7e7e, 0x898989, 0x959595, 0xa2a2a2];
  for (let i = 0; i < N; i++) {
    const x = i & 15;
    const y = i >> 4;
    const edge = v.f2[i] - v.f1[i];
    if (edge < 0.85) {
      L.set(x, y, wn[i] < 0.6 ? 0x414141 : 0x4b4b4b);
      continue;
    }
    const r = v.f1[i];
    const dir = -(v.dx[i] + v.dy[i]) / (Math.abs(v.dx[i]) + Math.abs(v.dy[i]) + 0.5);
    let s = 0.55 + tone[v.id[i]] + 0.2 * dir * Math.min(1, r / 2.2) + (wn[i] - 0.5) * 0.22;
    if (edge < 1.8) s += dir < 0 ? -0.12 : 0.04;
    L.set(x, y, pal[Math.max(0, Math.min(6, Math.round(s * 6)))]);
  }
  return v;
}

const MOSS_PAL = [0x46602a, 0x52702f, 0x5e7f35, 0x6b8e3c, 0x789c44];

function mossOver(L: Layer, rng: Rng, amount: number, crevice: Field | null): void {
  const m = rank(flatten(fbm(rng, [[8, 8, 0.3], [4, 4, 0.6], [2, 2, 0.7], [1, 1, 0.45]]), 0.7));
  const wn = lattice(rng, 1, 1);
  for (let i = 0; i < N; i++) {
    const bias = crevice ? crevice[i] : 0;
    if (m[i] + bias > 1 - amount) {
      const k = Math.min(4, Math.floor((m[i] * 0.6 + wn[i] * 0.4) * 5));
      L.set(i & 15, i >> 4, MOSS_PAL[k]);
    }
  }
}

/**
 * Stone with ore clusters. cols: [dark, mid, light, highlight]. Each cluster is a jittered disc
 * (5-10 px) lit from the top-left, with a soft shadow on the stone below/right of it.
 */
function ore(L: Layer, rng: Rng, cols: number[], opts: { count: number; rMin: number; rMax: number; alt?: number[] }): void {
  stoneInto(L);
  const owner = new Int16Array(N).fill(-1);
  const lit = new Float32Array(N);
  const centres = scatter(rng, opts.count, 6);
  centres.forEach(([cx, cy], id) => {
    const rad = rng.range(opts.rMin, opts.rMax);
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -3; dx <= 3; dx++) {
        const x = Math.floor(cx) + dx;
        const y = Math.floor(cy) + dy;
        const ox = x + 0.5 - cx;
        const oy = y + 0.5 - cy;
        const d = Math.sqrt(ox * ox + oy * oy) + (rng.next() - 0.5) * 1.1;
        if (d > rad) continue;
        const i = ix(x, y);
        if (owner[i] >= 0) continue;
        owner[i] = id;
        lit[i] = -(ox + oy) / (rad + 0.5) + (rng.next() - 0.5) * 0.5;
      }
  });
  // shadow under / right of the clusters, slightly tinted by the ore colour
  for (let i = 0; i < N; i++) {
    if (owner[i] >= 0) continue;
    const x = i & 15;
    const y = i >> 4;
    if (owner[ix(x - 1, y)] >= 0 || owner[ix(x, y - 1)] >= 0) L.set(x, y, shade(mix(L.get(x, y), cols[0], 0.2), 0.8));
    else if (owner[ix(x - 1, y - 1)] >= 0) L.set(x, y, shade(L.get(x, y), 0.9));
  }
  const pals = centres.map((_, i) => (opts.alt && i % 3 === 1 ? opts.alt : cols));
  for (let i = 0; i < N; i++) {
    const id = owner[i];
    if (id < 0) continue;
    const x = i & 15;
    const y = i >> 4;
    let k = lit[i] > 0.45 ? 3 : lit[i] > 0.0 ? 2 : lit[i] > -0.45 ? 1 : 0;
    // pixels on the lower/right rim are always in shade
    if (owner[ix(x, y + 1)] !== id || owner[ix(x + 1, y)] !== id) k = Math.min(k, 1);
    if (owner[ix(x, y - 1)] !== id && owner[ix(x - 1, y)] !== id) k = Math.max(k, 2);
    L.set(x, y, pals[id][k]);
  }
}

function sandLike(L: Layer, rng: Rng, pal: number[]): void {
  const f = rank(flatten(fbm(rng, [[4, 4, 0.25], [2, 2, 0.45], [1, 1, 1.0]]), 0.9));
  paintField(L, f, pal.slice(1), [0.26, 0.68, 0.95]);
  specks(rng, 12, 3.6, 0.25, (x, y) => L.set(x, y, pal[0]));
}

function flat(L: Layer, rng: Rng, base: number, amt = 0.035): void {
  const f = rank(flatten(fbm(rng, [[8, 8, 0.4], [4, 4, 0.4], [2, 2, 0.4], [1, 1, 0.7]]), 0.6));
  const pal = [shade(base, 1 - amt * 1.6), shade(base, 1 - amt * 0.7), base, shade(base, 1 + amt * 0.8)];
  paintField(L, f, pal, [0.06, 0.25, 0.82]);
}

function gravel(L: Layer, rng: Rng): void {
  const pts = scatter(rng, 22, 2.6);
  for (const p of pts) p.push(rng.range(0.85, 1.2));
  const v = voronoi(pts);
  const base = [0x7d7a78, 0x75716f, 0x868280, 0x837b75, 0x8c8785, 0x726c67, 0x7a7774];
  const col = pts.map(() => rng.pick(base));
  const wn = lattice(rng, 1, 1);
  for (let i = 0; i < N; i++) {
    const edge = v.f2[i] - v.f1[i];
    const dir = -(v.dx[i] + v.dy[i]) / (Math.abs(v.dx[i]) + Math.abs(v.dy[i]) + 0.5);
    let f = 1 + dir * 0.08 + (wn[i] - 0.5) * 0.07;
    if (edge < 0.7) f = 0.66 + wn[i] * 0.06;
    else if (edge < 1.4 && dir < 0) f -= 0.08;
    L.set(i & 15, i >> 4, shade(col[v.id[i]], f));
  }
}

function cracks(L: Layer, rng: Rng, count: number, light: number, dark: number): void {
  for (let c = 0; c < count; c++) {
    let x = rng.int(16);
    let y = rng.int(16);
    let dx = rng.chance(0.5) ? 1 : -1;
    let dy = rng.chance(0.5) ? 1 : -1;
    const len = 4 + rng.int(6);
    for (let k = 0; k < len; k++) {
      L.set(x, y, light);
      L.set(x + 1, y + 1, mix(L.get(x + 1, y + 1), dark, 0.5));
      if (rng.chance(0.5)) x += dx;
      else y += dy;
      if (rng.chance(0.15)) dx = -dx;
      if (rng.chance(0.15)) dy = -dy;
    }
  }
}

function lava(ls: Layer[], rng: Rng): void {
  const F = ls.length;
  const a = noise3(rng, 8, 3, F);
  const b = noise3(rng, 4, 3, F);
  const still = lattice(rng, 1, 1);
  const pal = [0x8e1c02, 0xb9310a, 0xd8510e, 0xeb7316, 0xf59a22, 0xfcc03a, 0xffe07a];
  const tmp = new Float32Array(N);
  for (let f = 0; f < F; f++) {
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        // cheap domain warp: offset sample by warp field
        const wx = Math.round((b[f * N + (i ^ 0x88)] - 0.5) * 6);
        const j = ix(x + wx, y + wx);
        tmp[i] = a[f * N + j] * 0.65 + b[f * N + i] * 0.35 + (still[i] - 0.5) * 0.08;
      }
    const r = rank(tmp);
    for (let i = 0; i < N; i++) ls[f].set(i & 15, i >> 4, pal[q(r[i], [0.07, 0.22, 0.5, 0.78, 0.92, 0.98])]);
  }
}

function water(ls: Layer[], rng: Rng): void {
  const F = ls.length;
  const a = noise3(rng, 8, 4, F);
  const b = noise3(rng, 4, 4, F);
  const still = lattice(rng, 1, 1);
  const tmp = new Float32Array(N);
  for (let f = 0; f < F; f++) {
    const o = f * N;
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        // sample with a diagonal skew so ripples read as soft waves rather than cells
        tmp[y * S + x] = a[o + (((x + (y >> 2)) & 15) | (y << 4))] * 0.7 + b[o + y * S + x] * 0.3;
      }
    const ra = rank(tmp);
    for (let i = 0; i < N; i++) {
      const d = Math.abs(ra[i] - 0.5);
      // broad brightness variation from the low-frequency field, offset by half a tile
      const lo = a[o + (i ^ 0x88)];
      let v = lo < 0.4 ? 180 : lo < 0.6 ? 187 : 194;
      if (still[i] > 0.92) v += 4;
      let al = 178;
      if (d < 0.04) {
        v = 234;
        al = 188;
      } else if (d < 0.09) {
        v = 210;
        al = 182;
      }
      ls[f].set(i & 15, i >> 4, grey(v), al);
    }
  }
}

// ------------------------------------------------------------------------------------------
// Wood
// ------------------------------------------------------------------------------------------

/** pal: [groove, dark, mid, light, highlight] */
function bark(L: Layer, rng: Rng, pal: number[], opts: { grooves?: number; streak?: number; streakCol?: number } = {}): void {
  const f = rank(fbm(rng, [[2, 16, 0.5], [1, 8, 1.0], [1, 4, 0.5], [1, 2, 0.25], [1, 1, 0.15]]));
  const sh = new Uint8Array(N);
  for (let i = 0; i < N; i++) sh[i] = 1 + q(f[i], [0.28, 0.72]);
  const ng = opts.grooves ?? 5;
  for (let g = 0; g < ng; g++) {
    let x = rng.int(16);
    const y = rng.int(16);
    const len = 5 + rng.int(10);
    for (let k = 0; k < len; k++) {
      sh[ix(x, y + k)] = 0;
      if (sh[ix(x + 1, y + k)] > 0) sh[ix(x + 1, y + k)] = Math.min(4, sh[ix(x + 1, y + k)] + 1);
      if (rng.chance(0.18)) x += rng.chance(0.5) ? 1 : -1;
    }
  }
  for (let i = 0; i < N; i++) L.set(i & 15, i >> 4, pal[sh[i]]);
  if (opts.streak && opts.streakCol !== undefined) {
    const sf = rank(fbm(rng, [[2, 8, 1], [1, 4, 0.6], [1, 1, 0.3]]));
    for (let i = 0; i < N; i++) if (sf[i] > 1 - opts.streak && sh[i] > 0) L.set(i & 15, i >> 4, mix(L.get(i & 15, i >> 4), opts.streakCol, 0.6));
  }
}

/** ring: [dark, mid, light, highlight]; barkPal as for bark() */
function logTop(L: Layer, rng: Rng, ring: number[], barkPal: number[]): void {
  const n = fbm(rng, [[4, 4, 1], [2, 2, 0.6]]);
  const wn = lattice(rng, 1, 1);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const dx = x - 7.5;
      const dy = y - 7.5;
      const cheb = Math.max(Math.abs(dx), Math.abs(dy));
      if (cheb > 6.6) {
        L.set(x, y, barkPal[1 + Math.min(3, Math.floor(wn[i] * 3.2))]);
        continue;
      }
      if (cheb > 5.6) {
        L.set(x, y, wn[i] < 0.75 ? ring[0] : ring[1]);
        continue;
      }
      const e = Math.sqrt(dx * dx + dy * dy);
      const d = cheb * 0.6 + e * 0.4 + (n[i] - 0.5) * 0.75;
      const ph = d / 2;
      const fr = ph - Math.floor(ph);
      let k = fr < 0.42 ? 1 : 2;
      if (k === 2 && wn[i] > 0.9) k = 3;
      if (k === 1 && wn[i] < 0.1) k = 0;
      if (cheb < 1) k = wn[i] < 0.5 ? 0 : 1;
      L.set(x, y, ring[k]);
    }
}

/** pal: [seam, dark, mid, light, highlight] */
function planks(L: Layer, rng: Rng, pal: number[]): void {
  const grain = rank(fbm(rng, [[8, 1, 0.8], [4, 1, 0.8], [2, 1, 0.4], [1, 1, 0.3]]));
  const joints = [rng.int(4) + 2, rng.int(4) + 10, rng.int(4) + 5, rng.int(4) + 12];
  for (let b = 0; b < 4; b++) {
    const shift = (rng.next() - 0.5) * 0.3;
    const jx = joints[b] & 15;
    for (let r = 0; r < 4; r++) {
      const y = b * 4 + r;
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        let k: number;
        if (r === 3) k = 0;
        else if (x === jx) k = 0;
        else {
          k = 1 + q(grain[i] + shift, [0.25, 0.75]);
          if (r === 0 && k < 3 && grain[i] > 0.5) k++;
          if (x === ((jx + 1) & 15)) k = Math.min(4, k + 1);
        }
        L.set(x, y, pal[k]);
      }
    }
  }
}

interface LeafOpts {
  hole: number;
  base: number;
  step: number;
  range: number;
  shapes: number[][][];
}

const LEAF_SMALL = [
  [
    [0, 0, 1],
    [1, 0, 0],
    [0, 1, 0],
    [1, 1, -1],
  ],
  [
    [1, 0, 1],
    [0, 1, 1],
    [1, 1, 0],
    [2, 1, 0],
    [1, 2, -1],
  ],
  [
    [0, 0, 1],
    [1, 0, 1],
    [2, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
    [2, 1, -1],
  ],
  [
    [0, 0, 1],
    [0, 1, 0],
    [1, 1, 0],
    [1, 2, -1],
  ],
];
const LEAF_NEEDLE = [
  [
    [0, 0, 1],
    [1, 1, 0],
    [2, 2, -1],
  ],
  [
    [2, 0, 1],
    [1, 1, 0],
    [0, 2, -1],
  ],
  [
    [0, 0, 1],
    [1, 0, 0],
    [2, 1, -1],
  ],
  [
    [1, 0, 1],
    [1, 1, 0],
    [0, 2, -1],
    [2, 2, -1],
  ],
];
const LEAF_BIG = [
  [
    [1, 0, 1],
    [2, 0, 1],
    [0, 1, 1],
    [1, 1, 1],
    [2, 1, 0],
    [3, 1, 0],
    [0, 2, 0],
    [1, 2, 0],
    [2, 2, 0],
    [3, 2, -1],
    [1, 3, -1],
    [2, 3, -1],
  ],
  [
    [0, 0, 1],
    [1, 0, 1],
    [0, 1, 1],
    [1, 1, 0],
    [2, 1, 0],
    [1, 2, 0],
    [2, 2, -1],
  ],
];

function leafField(rng: Rng, o: LeafOpts): Int16Array {
  const v = new Int16Array(N).fill(-1);
  let covered = 0;
  for (let guard = 0; covered < N && guard < 1500; guard++) {
    const shape = rng.pick(o.shapes);
    const x = rng.int(16);
    const y = rng.int(16);
    const b = o.base + (rng.next() - 0.5) * o.range;
    for (const [dx, dy, kind] of shape) {
      const i = ix(x + dx, y + dy);
      if (v[i] < 0) covered++;
      v[i] = Math.round(b + kind * o.step + (rng.next() - 0.5) * 6);
    }
  }
  for (let i = 0; i < N; i++) if (v[i] < 0) v[i] = o.base - o.step * 1.5;
  // Holes: many small, evenly spread clusters (big connected holes repeat visibly at distance).
  const target = Math.round(N * o.hole);
  const meanSize = o.hole > 0.25 ? 3 : 2.2;
  const seeds = scatter(rng, Math.ceil(target / meanSize), Math.sqrt(N / (target / meanSize)) * 0.8);
  const hole = new Uint8Array(N);
  let made = 0;
  for (const [sx, sy] of seeds) {
    let x = Math.floor(sx);
    let y = Math.floor(sy);
    const size = 1 + rng.int(Math.round(meanSize * 2 - 1));
    for (let k = 0; k < size && made < target; k++) {
      if (!hole[ix(x, y)]) {
        hole[ix(x, y)] = 1;
        made++;
      }
      if (rng.chance(0.5)) x += rng.chance(0.5) ? 1 : -1;
      else y += rng.chance(0.5) ? 1 : -1;
    }
  }
  const out = new Int16Array(N);
  for (let i = 0; i < N; i++) {
    if (hole[i]) {
      out[i] = -1;
      continue;
    }
    const x = i & 15;
    const y = i >> 4;
    let val = v[i];
    if (hole[ix(x, y - 1)]) val -= o.step * 0.7; // inner shadow below a gap
    else if (hole[ix(x - 1, y)]) val -= o.step * 0.35;
    else if (hole[ix(x, y + 1)] || hole[ix(x + 1, y)]) val += o.step * 0.3; // lit rim
    out[i] = val;
  }
  return out;
}

function leavesGrey(L: Layer, rng: Rng, o: LeafOpts): void {
  const v = leafField(rng, o);
  for (let i = 0; i < N; i++) {
    if (v[i] < 0) L.set(i & 15, i >> 4, 0, 0);
    else L.set(i & 15, i >> 4, grey(Math.round(Math.max(96, Math.min(232, v[i])) / 8) * 8));
  }
}

// ------------------------------------------------------------------------------------------
// Plant helpers (Canvas based)
// ------------------------------------------------------------------------------------------

interface BladeOpts {
  count: number;
  minH: number;
  maxH: number;
  lean: number;
  lo: number;
  hi: number;
  xMin?: number;
  xMax?: number;
  thick?: number;
}

function blades(cv: Canvas, rng: Rng, o: BladeOpts, colorFn: (v: number) => number = grey): void {
  const list: { x: number; h: number; l: number; b: number }[] = [];
  for (let k = 0; k < o.count; k++) {
    const x = rng.range(o.xMin ?? 1, o.xMax ?? 14);
    const lean = (x - 7.5) * 0.25 + (rng.next() - 0.5) * 2 * o.lean;
    list.push({ x, h: Math.round(rng.range(o.minH, o.maxH)), l: lean, b: rng.next() });
  }
  // darker (back) blades first
  list.sort((a, b) => a.b - b.b);
  for (const bl of list) {
    const off = (bl.b - 0.5) * 30;
    for (let k = 0; k < bl.h; k++) {
      const t = bl.h > 1 ? k / (bl.h - 1) : 1;
      const x = bl.x + bl.l * Math.pow(t, 1.6);
      const y = cv.h - 1 - k;
      let v = lerp(o.lo, o.hi, t) + off;
      if (k === bl.h - 1) v += 12;
      cv.put(x, y, colorFn(Math.round(v / 8) * 8));
      if (o.thick && t < o.thick) cv.put(x + (bl.l > 0 ? -1 : 1), y, colorFn(Math.round((v - 16) / 8) * 8));
    }
  }
}

function frond(cv: Canvas, p0: number[], p1: number[], pc: number[], leaflet: number, cols: number[]): void {
  // cols: [rachis, leafDark, leaf, leafLight]
  const pts: number[][] = [];
  for (let s = 0; s <= 60; s++) {
    const t = s / 60;
    const x = (1 - t) * (1 - t) * p0[0] + 2 * (1 - t) * t * pc[0] + t * t * p1[0];
    const y = (1 - t) * (1 - t) * p0[1] + 2 * (1 - t) * t * pc[1] + t * t * p1[1];
    const rx = Math.round(x);
    const ry = Math.round(y);
    const last = pts[pts.length - 1];
    if (!last || last[0] !== rx || last[1] !== ry) pts.push([rx, ry, t]);
  }
  // leaflets first (rachis drawn on top), alternating sides, angled towards the tip
  pts.forEach(([x, y, t], k) => {
    if (k < 2) return;
    const nxt = pts[Math.min(pts.length - 1, k + 1)];
    const prv = pts[Math.max(0, k - 1)];
    let tx = nxt[0] - prv[0];
    let ty = nxt[1] - prv[1];
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    const len = Math.max(1, Math.round(leaflet * Math.pow(1 - t, 0.6)));
    for (const side of t < 0.55 ? [-1, 1] : [k % 2 === 0 ? -1 : 1]) {
      if (t < 0.55 && (k + (side > 0 ? 1 : 0)) % 2 === 1 && len < 2) continue;
      const nx = -ty * side * 0.8 + tx * 0.55;
      const ny = tx * side * 0.8 + ty * 0.55;
      for (let s = 1; s <= len; s++) cv.put(x + nx * s, y + ny * s, s === len ? cols[3] : side < 0 ? cols[2] : mix(cols[1], cols[2], 0.5));
    }
  });
  pts.forEach(([x, y, t]) => cv.put(x, y, t > 0.85 ? cols[2] : cols[1]));
}

function blob(cv: Canvas, cx: number, cy: number, r: number, pal: number[], rng: Rng): void {
  // pal: [dark, mid, light, highlight]
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > r + 0.25) continue;
      const lit = -(dx + dy) / (r + 0.5);
      let k = lit > 0.45 ? 3 : lit > 0 ? 2 : lit > -0.5 ? 1 : 0;
      if (rng.chance(0.15)) k = Math.max(0, k - 1);
      cv.put(x, y, pal[k]);
    }
}

// ------------------------------------------------------------------------------------------
// Generators table
// ------------------------------------------------------------------------------------------

type Gen = (ls: Layer[], rng: Rng) => void;

const GRASS_G = (v: number): number => grey(v);

const STEM = { s: 0x3f7a22, l: 0x4c9a2a, L: 0x6ab83c, d: 0x2e6418 };

const GEN: Record<string, Gen> = {
  // ---------------- natural terrain ----------------
  stone: ([L]) => stoneInto(L),
  cobblestone: ([L], r) => {
    cobble(L, r);
  },
  mossy_cobblestone: ([L], r) => {
    const v = cobble(L, r);
    const crev = new Float32Array(N);
    for (let i = 0; i < N; i++) crev[i] = Math.max(0, 0.35 - (v.f2[i] - v.f1[i]) * 0.14);
    mossOver(L, r, 0.28, crev);
  },
  bedrock: ([L], r) => {
    const f = rank(fbm(r, [[4, 4, 0.5], [2, 2, 1.0], [1, 1, 0.7]]));
    paintField(L, f, [0x1f1f1f, 0x353535, 0x4a4a4a, 0x5f5f5f, 0x787878], [0.2, 0.42, 0.64, 0.84]);
  },
  dirt: ([L]) => dirtInto(L),
  coarse_dirt: ([L], r) => {
    dirtInto(L);
    const pts = scatter(r, 10, 3.2);
    const cols = [0x6f6258, 0x7d6f63, 0x5d5148, 0x8a7a6b];
    for (const [px, py] of pts) {
      const c = r.pick(cols);
      const w = 1 + r.int(2);
      const h = 1 + r.int(2);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) L.set(Math.floor(px) + x, Math.floor(py) + y, x === 0 && y === 0 ? shade(c, 1.12) : c);
      L.set(Math.floor(px) + w, Math.floor(py) + h, shade(L.get(Math.floor(px) + w, Math.floor(py) + h), 0.8));
    }
  },
  grass_top: ([L]) => {
    const g = grassVal();
    for (let i = 0; i < N; i++) L.set(i & 15, i >> 4, grey(g[i]));
  },
  grass_side: ([L], r) => {
    const g = grassVal();
    const dep = fringeDepths(r, 3.3, 0.9, 3);
    fringeSide(L, r, dep, (x, y, last) => grey(g[ix(x, y)] - (last ? 18 : 0)), 255);
  },
  grass_side_snowy: ([L], r) => {
    const dep = fringeDepths(r, 3.4, 0.8, 2);
    const wn = lattice(r, 1, 1);
    fringeSide(L, r, dep, (x, y, last) => (last ? 0xd2dbe4 : wn[ix(x, y)] < 0.2 ? 0xe6edf3 : 0xf3f6f9));
  },
  podzol_top: ([L], r) => {
    const f = rank(fbm(r, [[4, 4, 0.4], [2, 2, 0.6], [1, 1, 0.7]]));
    paintField(L, f, [0x5e3d16, 0x6c4619, 0x7a511f, 0x885d26, 0x94672d], [0.1, 0.32, 0.68, 0.9]);
    for (let k = 0; k < 16; k++) {
      const x = r.int(16);
      const y = r.int(16);
      const d = r.int(3);
      const c = r.chance(0.5) ? 0x3f2810 : 0x4a3014;
      L.set(x, y, c);
      L.set(x + (d === 0 ? 1 : d === 1 ? 1 : 0), y + (d === 1 ? 1 : d === 2 ? 1 : 0), c);
    }
  },
  podzol_side: ([L], r) => {
    const dep = fringeDepths(r, 3.2, 0.9, 2);
    const wn = lattice(r, 1, 1);
    fringeSide(L, r, dep, (x, y, last) => (last ? 0x5a3a15 : wn[ix(x, y)] < 0.2 ? 0x4a3014 : wn[ix(x, y)] < 0.6 ? 0x7a511f : 0x885d26));
  },
  mycelium_top: ([L], r) => {
    const f = rank(fbm(r, [[4, 4, 0.35], [2, 2, 0.6], [1, 1, 0.75]]));
    paintField(L, f, [0x5f565c, 0x6b6169, 0x776c76, 0x837883, 0x918591], [0.08, 0.3, 0.7, 0.92]);
    for (let k = 0; k < 9; k++) L.set(r.int(16), r.int(16), r.chance(0.5) ? 0xa99caa : 0x9d909e);
  },
  mycelium_side: ([L], r) => {
    const dep = fringeDepths(r, 3.2, 0.9, 3);
    const wn = lattice(r, 1, 1);
    fringeSide(L, r, dep, (x, y, last) => (last ? 0x5d5359 : wn[ix(x, y)] < 0.3 ? 0x6b6169 : wn[ix(x, y)] < 0.85 ? 0x7a6f79 : 0x9d909e));
  },
  dirt_path_top: ([L], r) => {
    const f = rank(fbm(r, [[4, 4, 0.5], [2, 2, 0.6], [1, 1, 0.5]]));
    paintField(L, f, [0x7d6136, 0x8b6c3d, 0x977744, 0xa2814b, 0xad8b54], [0.08, 0.3, 0.7, 0.92]);
  },
  dirt_path_side: ([L], r) => {
    const dep = fringeDepths(r, 3.0, 0.6, 1);
    const wn = lattice(r, 1, 1);
    fringeSide(L, r, dep, (x, y, last) => (last ? 0x7a5e34 : wn[ix(x, y)] < 0.3 ? 0x8b6c3d : wn[ix(x, y)] < 0.8 ? 0x977744 : 0xa2814b));
  },
  farmland_top: ([L], r) => {
    const f = rank(fbm(r, [[4, 4, 0.4], [2, 2, 0.5], [1, 1, 0.6]]));
    const pal = [0x2f1d10, 0x3b2615, 0x47301b, 0x533a21, 0x5e4327];
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const row = y & 3;
        let k = 1 + q(f[i], [0.3, 0.75]);
        if (row === 0) k = Math.min(4, k + 1);
        if (row === 3) k = Math.max(0, k - 2);
        L.set(x, y, pal[k]);
      }
  },
  sand: ([L], r) => sandLike(L, r, [0xcdbf86, 0xd6ca93, 0xdcd19d, 0xe2d8a7, 0xe9e0b3]),
  red_sand: ([L], r) => sandLike(L, r, [0x9e4d1a, 0xab561e, 0xb55e23, 0xbe6628, 0xc8702f]),
  gravel: ([L], r) => gravel(L, r),
  clay: ([L], r) => flat(L, r, 0xa2a7b5, 0.03),
  sandstone_top: ([L], r) => flat(L, r, 0xdbcf9c, 0.03),
  sandstone_side: ([L], r) => {
    const f = rank(fbm(r, [[8, 2, 0.5], [4, 1, 0.5], [1, 1, 0.6]]));
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        let base = 0xd8cb96;
        if (y === 0) base = 0xe3d8a8;
        else if (y >= 12) base = 0xc9b780;
        else if (y === 4 || y === 8) base = 0xd0c18a;
        if (y === 11) base = 0xcfbf88;
        const k = q(f[i], [0.15, 0.85]);
        L.set(x, y, shade(base, k === 0 ? 0.96 : k === 2 ? 1.03 : 1));
      }
  },
  sandstone_bottom: ([L], r) => {
    const f = rank(fbm(r, [[4, 4, 0.4], [2, 2, 0.6], [1, 1, 0.9]]));
    paintField(L, f, [0xc4b37e, 0xcfc08a, 0xd7c995, 0xdccf9c, 0xe3d7a7], [0.08, 0.28, 0.65, 0.9]);
  },
  snow: ([L], r) => {
    const f = rank(flatten(fbm(r, [[4, 4, 0.4], [2, 2, 0.5], [1, 1, 0.8]]), 0.85));
    paintField(L, f, [0xeaeff5, 0xf2f5f9, 0xf9fbfd], [0.3, 0.78]);
    specks(r, 10, 4, 0.3, (x, y) => L.set(x, y, 0xdde5ee));
  },
  ice: ([L], r) => {
    const f = rank(fbm(r, [[8, 8, 0.6], [4, 4, 0.5], [1, 1, 0.3]]));
    for (let i = 0; i < N; i++) {
      const k = q(f[i], [0.3, 0.75]);
      L.set(i & 15, i >> 4, [0x8bb0ee, 0x96b9f0, 0xa2c2f3][k], 184);
    }
    for (let s = 0; s < 3; s++) {
      const x0 = r.int(16);
      const y0 = r.int(16);
      const len = 3 + r.int(4);
      for (let k = 0; k < len; k++) L.set(x0 + k, y0 - k, k === 0 || k === len - 1 ? 0xc0d6f8 : 0xdce9fc, 198);
    }
  },
  packed_ice: ([L], r) => {
    const f = rank(fbm(r, [[8, 8, 0.6], [4, 4, 0.5], [2, 2, 0.3], [1, 1, 0.3]]));
    paintField(L, f, [0x84a8e2, 0x8eb1e7, 0x98b9eb, 0xa3c2ee], [0.1, 0.4, 0.8]);
    cracks(L, r, 4, 0xbcd3f4, 0x7095d4);
  },
  blue_ice: ([L], r) => {
    const f = rank(fbm(r, [[8, 8, 0.6], [4, 4, 0.5], [2, 2, 0.3], [1, 1, 0.3]]));
    paintField(L, f, [0x4f80d8, 0x5a8ade, 0x6595e3, 0x71a0e8], [0.1, 0.4, 0.8]);
    cracks(L, r, 4, 0x9cc0f2, 0x3f6cc0);
  },
  terracotta: ([L], r) => flat(L, r, 0x985e43),
  terracotta_orange: ([L], r) => flat(L, r, 0xa2541f),
  terracotta_yellow: ([L], r) => flat(L, r, 0xb98424),
  terracotta_red: ([L], r) => flat(L, r, 0x8e3c2e),
  terracotta_white: ([L], r) => flat(L, r, 0xd0b1a1),
  terracotta_brown: ([L], r) => flat(L, r, 0x4e3324),
  terracotta_light_gray: ([L], r) => flat(L, r, 0x886a61),
  moss_block: ([L], r) => {
    const f = rank(fbm(r, [[4, 4, 0.4], [2, 2, 0.7], [1, 1, 0.6]]));
    paintField(L, f, MOSS_PAL, [0.1, 0.3, 0.68, 0.9]);
  },
  obsidian: ([L], r) => {
    const pts = scatter(r, 9, 4);
    const v = voronoi(pts);
    const tone = pts.map(() => r.int(3));
    const wn = lattice(r, 1, 1);
    const pal = [0x0c0914, 0x120d1e, 0x191328, 0x211934, 0x2c2244];
    for (let i = 0; i < N; i++) {
      const dir = -(v.dx[i] + v.dy[i]);
      let k = tone[v.id[i]] + (wn[i] > 0.8 ? 1 : 0);
      if (v.f2[i] - v.f1[i] < 1 && dir > 0) k += 1;
      L.set(i & 15, i >> 4, pal[Math.min(4, k)]);
    }
    for (let k = 0; k < 5; k++) {
      const x = r.int(16);
      const y = r.int(16);
      L.set(x, y, 0x5b4687);
      L.set(x + 1, y, 0x3d2e60);
    }
  },
  coal_ore: ([L], r) => ore(L, r, [0x161616, 0x232323, 0x313131, 0x474747], { count: 5, rMin: 1.5, rMax: 2.0 }),
  iron_ore: ([L], r) => ore(L, r, [0xa47a5c, 0xc49a7b, 0xd8b293, 0xeacfb4], { count: 4, rMin: 1.4, rMax: 1.9 }),
  copper_ore: ([L], r) =>
    ore(L, r, [0xa5512a, 0xc8693b, 0xe08550, 0xf2aa7a], { count: 5, rMin: 1.3, rMax: 1.8, alt: [0x3c7e68, 0x4f9c82, 0x67b89a, 0x8ad4b6] }),
  gold_ore: ([L], r) => ore(L, r, [0xc08a14, 0xe2b322, 0xf6d63a, 0xfff38a], { count: 4, rMin: 1.4, rMax: 1.9 }),
  gem_ore: ([L], r) => ore(L, r, [0x1f8f8c, 0x34bdb8, 0x5fe2dc, 0xb8fff9], { count: 4, rMin: 1.2, rMax: 1.7 }),
  water: (ls, r) => water(ls, r),
  lava: (ls, r) => lava(ls, r),

  // ---------------- wood ----------------
  oak_log: ([L], r) => bark(L, r, [0x3e2d19, 0x5a4326, 0x67502f, 0x735b36, 0x82693f]),
  oak_log_top: ([L], r) => logTop(L, r, [0x8a6b40, 0x9f7f4c, 0xb18e58, 0xbf9c64], [0x3e2d19, 0x5a4326, 0x67502f, 0x735b36, 0x82693f]),
  oak_leaves: ([L], r) => leavesGrey(L, r, { hole: 0.2, base: 160, step: 22, range: 36, shapes: LEAF_SMALL }),
  oak_planks: ([L], r) => planks(L, r, [0x6c5231, 0x987748, 0xa68350, 0xb18e58, 0xbd9a62]),
  birch_log: ([L], r) => {
    const f = rank(fbm(r, [[4, 16, 0.4], [1, 4, 0.6], [1, 1, 0.5]]));
    paintField(L, f, [0xc6c2b8, 0xd4d0c7, 0xdfdcd4, 0xe9e7e0], [0.1, 0.4, 0.82]);
    const pts = scatter(r, 13, 3.2);
    for (const [px, py] of pts) {
      const x = Math.floor(px);
      const y = Math.floor(py);
      const len = 1 + r.int(5);
      const thick = len >= 3 && r.chance(0.45);
      for (let d = 0; d < len; d++) {
        const end = d === 0 || d === len - 1;
        L.set(x + d, y, end && len > 2 ? 0x4a4540 : 0x2a2622);
        if (thick && !end) L.set(x + d, y + 1, 0x3c3732);
      }
      if (r.chance(0.5)) L.set(x + len, y, 0x9e998f);
    }
  },
  birch_log_top: ([L], r) => logTop(L, r, [0xb8a374, 0xc9b480, 0xd6c28d, 0xe0cd9a], [0x3a3631, 0xcfcbc2, 0xdedbd3, 0xe8e6df, 0xf1efe9]),
  birch_leaves: ([L], r) => leavesGrey(L, r, { hole: 0.2, base: 168, step: 20, range: 30, shapes: LEAF_SMALL }),
  spruce_log: ([L], r) => bark(L, r, [0x24170b, 0x37250f, 0x432e14, 0x4e3719, 0x5a411f], { grooves: 6 }),
  spruce_log_top: ([L], r) => logTop(L, r, [0x6b4c2b, 0x7a5833, 0x87633a, 0x936d41], [0x24170b, 0x37250f, 0x432e14, 0x4e3719, 0x5a411f]),
  spruce_leaves: ([L], r) => leavesGrey(L, r, { hole: 0.12, base: 140, step: 20, range: 30, shapes: LEAF_NEEDLE }),
  spruce_planks: ([L], r) => planks(L, r, [0x3f2c17, 0x5d4229, 0x694b2e, 0x755434, 0x815d3a]),
  jungle_log: ([L], r) => bark(L, r, [0x3a2a10, 0x523d17, 0x5e471c, 0x6a5122, 0x775c29], { streak: 0.22, streakCol: 0x5a6a26 }),
  jungle_log_top: ([L], r) => logTop(L, r, [0x8e6340, 0xa2744c, 0xb08157, 0xbd8e62], [0x3a2a10, 0x523d17, 0x5e471c, 0x6a5122, 0x775c29]),
  jungle_leaves: ([L], r) => leavesGrey(L, r, { hole: 0.16, base: 158, step: 22, range: 32, shapes: LEAF_BIG }),
  acacia_log: ([L], r) => bark(L, r, [0x47423b, 0x5c564e, 0x676159, 0x726c63, 0x857e74], { streak: 0.2, streakCol: 0x9a948a }),
  acacia_log_top: ([L], r) => logTop(L, r, [0xa24a22, 0xb5582b, 0xc36535, 0xcf7240], [0x47423b, 0x5c564e, 0x676159, 0x726c63, 0x857e74]),
  acacia_leaves: ([L], r) => leavesGrey(L, r, { hole: 0.3, base: 166, step: 22, range: 34, shapes: LEAF_SMALL }),
  dark_oak_log: ([L], r) => bark(L, r, [0x1e150a, 0x2e2111, 0x382916, 0x42311b, 0x4e3a21]),
  dark_oak_log_top: ([L], r) => logTop(L, r, [0x4a3520, 0x574026, 0x634a2d, 0x6f5434], [0x1e150a, 0x2e2111, 0x382916, 0x42311b, 0x4e3a21]),
  dark_oak_leaves: ([L], r) => leavesGrey(L, r, { hole: 0.12, base: 150, step: 22, range: 34, shapes: LEAF_SMALL }),
  cherry_log: ([L], r) => bark(L, r, [0x22121a, 0x341c24, 0x40232c, 0x4b2a33, 0x58323b]),
  cherry_log_top: ([L], r) => logTop(L, r, [0xc48a86, 0xd49b95, 0xe0aba3, 0xeab8b0], [0x22121a, 0x341c24, 0x40232c, 0x4b2a33, 0x58323b]),
  cherry_leaves: ([L], r) => {
    const v = leafField(r, { hole: 0.2, base: 160, step: 22, range: 36, shapes: LEAF_SMALL });
    const pinks = [0xc66f9a, 0xd884ac, 0xe69abd, 0xf0b2cd, 0xf8cadd];
    for (let i = 0; i < N; i++) {
      if (v[i] < 0) L.set(i & 15, i >> 4, 0, 0);
      else L.set(i & 15, i >> 4, pinks[Math.max(0, Math.min(4, Math.round((v[i] - 110) / 25)))]);
    }
    for (let k = 0; k < 6; k++) {
      const x = r.int(16);
      const y = r.int(16);
      if (L.alpha(x, y)) L.set(x, y, 0xfde6ef);
    }
  },
  mushroom_stem: ([L], r) => {
    const f = rank(fbm(r, [[1, 8, 1], [1, 4, 0.5], [1, 1, 0.3]]));
    paintField(L, f, [0xc6c0b1, 0xd0cabc, 0xd9d4c7, 0xe2ded2], [0.12, 0.45, 0.85]);
  },
  red_mushroom_block: ([L], r) => {
    const f = rank(fbm(r, [[4, 4, 0.5], [2, 2, 0.5], [1, 1, 0.4]]));
    paintField(L, f, [0x9a221e, 0xab2924, 0xbb312b, 0xc93c34], [0.12, 0.45, 0.85]);
    const spots = scatter(r, 6, 5);
    for (const [sx, sy] of spots) {
      const rad = r.range(1.2, 2.2);
      for (let y = -3; y <= 3; y++)
        for (let x = -3; x <= 3; x++) {
          const d = Math.hypot(x, y);
          if (d <= rad) L.set(Math.floor(sx) + x, Math.floor(sy) + y, d > rad - 0.8 ? 0xd9cfc6 : 0xece6df);
        }
    }
  },
  brown_mushroom_block: ([L], r) => {
    const f = rank(fbm(r, [[4, 4, 0.7], [2, 2, 0.6], [1, 1, 0.4]]));
    paintField(L, f, [0x7a5941, 0x856148, 0x906a4f, 0x9b7457, 0xa67f61], [0.1, 0.35, 0.7, 0.92]);
  },

  // ---------------- plants ----------------
  short_grass: ([L], r) => {
    const cv = new Canvas();
    blades(cv, r, { count: 22, minH: 6, maxH: 14, lean: 1.8, lo: 128, hi: 212, thick: 0.35 });
    cv.toLayer(L);
  },
  fern: ([L], r) => {
    const cv = new Canvas();
    const cols = [grey(120), grey(140), grey(172), grey(204)];
    // back fronds first, arching out and drooping at the tips
    frond(cv, [7, 15], [0, 9], [1, 4], 2.2, cols);
    frond(cv, [8, 15], [15, 9], [14, 4], 2.2, cols);
    frond(cv, [7, 15], [3, 1], [3, 6], 2.4, cols);
    frond(cv, [8, 15], [13, 2], [12, 6], 2.4, cols);
    frond(cv, [7, 15], [8, 0], [6, 6], 2.0, cols);
    cv.toLayer(L);
  },
  tall_grass_bottom: ([L]) => tallGrass().toLayer(L, 16),
  tall_grass_top: ([L]) => tallGrass().toLayer(L, 0),
  dandelion: ([L]) => {
    const cv = new Canvas();
    cv.map(
      [
        '......YYY.......',
        '.....YWWWY......',
        '....YWWOWWY.....',
        '....YWOOOWY.....',
        '....YWWOWWY.....',
        '.....YWWWY......',
        '......YsY.......',
        '.......s........',
        '...L...s...L....',
        '...lL..s..Ll....',
        '....ll.s.ll.....',
        '.....dlsld......',
      ],
      { Y: 0xd9a400, W: 0xffe13a, O: 0xf2a400, ...STEM },
    );
    cv.toLayer(L);
  },
  poppy: ([L]) => {
    const cv = new Canvas();
    cv.map(
      [
        '......rrr.......',
        '....rRRHRr......',
        '...rRRRRRRr.....',
        '...rRRkkRRr.....',
        '...rRRkkRRr.....',
        '....rRRRRr......',
        '.....rrsr.......',
        '.......s........',
        '..L....s........',
        '..lL...s..L.....',
        '...ll..s.Ll.....',
        '....dl.sld......',
      ],
      { r: 0x9e140f, R: 0xd8241b, H: 0xf06048, k: 0x2a1610, ...STEM },
    );
    cv.toLayer(L);
  },
  cornflower: ([L]) => {
    const cv = new Canvas();
    cv.map(
      [
        '.....b.b.b......',
        '....bBcBcBb.....',
        '...bBBBBBBBb....',
        '....cBBnBBc.....',
        '...bBBBBBBBb....',
        '....bBcBcBb.....',
        '.....b.s.b......',
        '.......s........',
        '.......s..L.....',
        '...L...s.Ll.....',
        '...lL..sll......',
        '....ll.sld......',
        '.....dlsl.......',
      ],
      { b: 0x2c4aa6, B: 0x4a78da, c: 0x8fb2ff, n: 0x1c2a6a, ...STEM },
    );
    cv.toLayer(L);
  },
  oxeye_daisy: ([L]) => {
    const cv = new Canvas();
    cv.map(
      [
        '......wWw.......',
        '....wWWWWWw.....',
        '....WWYYYWW.....',
        '...wWWYOYWWw....',
        '....WWYYYWW.....',
        '....wWWWWWw.....',
        '......wsw.......',
        '.......s........',
        '...L...s..L.....',
        '...lL..s.Ll.....',
        '....ll.sll......',
        '.....dlsld......',
      ],
      { w: 0xc4c8cc, W: 0xf3f3ef, Y: 0xf0c418, O: 0xc98a0c, ...STEM },
    );
    cv.toLayer(L);
  },
  allium: ([L]) => {
    const cv = new Canvas();
    cv.map(
      [
        '......pPp.......',
        '....pPqPPp......',
        '....PqPPPPp.....',
        '...pPPqPPPPp....',
        '...pPPPPPPPp....',
        '....pPPPPPp.....',
        '.....pPPPp......',
        '.......s........',
        '.......s........',
        '.......s........',
        '.......s........',
        '....L..s..L.....',
        '....lL.s.Ll.....',
        '.....l.s.l......',
        '.....dlsld......',
      ],
      { p: 0x7a3aa8, P: 0xa65ad6, q: 0xd29cf2, ...STEM },
    );
    cv.toLayer(L);
  },
  orange_tulip: ([L]) => tulip(L, { o: 0xc8520c, O: 0xf07a1a, h: 0xffa54a }),
  pink_tulip: ([L]) => tulip(L, { o: 0xc06a8a, O: 0xeaa0bc, h: 0xffd0e0 }),
  lilac_bottom: ([L], r) => lilac(r).toLayer(L, 16),
  lilac_top: ([L], r) => lilac(r).toLayer(L, 0),
  dead_bush: ([L], r) => {
    const cv = new Canvas();
    const cols = [0x5e3f1d, 0x7a5429, 0x946a36];
    const branch = (x: number, y: number, ang: number, len: number, depth: number): void => {
      const x2 = x + Math.sin(ang) * len;
      const y2 = y - Math.cos(ang) * len;
      cv.line(x, y, x2, y2, cols[Math.min(2, 3 - depth)]);
      if (depth > 0) {
        branch(x2, y2, ang - r.range(0.35, 0.7), len * r.range(0.6, 0.8), depth - 1);
        branch(x2, y2, ang + r.range(0.35, 0.7), len * r.range(0.6, 0.8), depth - 1);
      }
    };
    branch(7.5, 15, -0.5, 4, 3);
    branch(8, 15, 0.45, 4.5, 3);
    branch(7.5, 15, 0, 3, 2);
    cv.toLayer(L);
  },
  sugar_cane: ([L], r) => {
    const cv = new Canvas();
    const stalks = [2, 7, 12];
    const pal = [0x5d8a2c, 0x76a83c, 0x8fc24e, 0xb0dc74];
    for (const sx of stalks) {
      const off = r.int(8);
      for (let y = 0; y < S; y++) {
        const node = (y + off) % 8 === 0;
        cv.put(sx, y, node ? pal[1] : pal[3]);
        cv.put(sx + 1, y, node ? pal[0] : pal[2]);
        if (node) {
          cv.put(sx - 1, y, pal[1]);
          cv.put(sx + 2, y, pal[0]);
        }
      }
      // a leaf from one node
      const ny = (16 - off) % 8;
      const dir = r.chance(0.5) ? 1 : -1;
      for (let k = 1; k <= 3; k++) cv.put(sx + (dir > 0 ? 1 + k : -k), ny - k + 1, pal[2]);
    }
    cv.toLayer(L);
  },
  cactus_side: ([L], r) => {
    const f = rank(fbm(r, [[1, 8, 0.5], [1, 1, 0.5]]));
    const pal = [0x0f4d18, 0x1a6224, 0x24752e, 0x2f8839, 0x45a04e];
    const colTone = [0, 3, 2, 2, 1, 3, 2, 2, 1, 3, 2, 2, 1, 3, 2, 0];
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        if (x === 0 || x === 15) {
          L.set(x, y, 0, 0);
          continue;
        }
        let k = colTone[x];
        if (x === 1 || x === 14) k = 1;
        if (f[y * S + x] > 0.85 && k > 1) k++;
        if (f[y * S + x] < 0.1 && k > 0) k--;
        L.set(x, y, pal[Math.min(4, k)]);
      }
    for (let y = 1; y < S; y += 4)
      for (const x of [4, 8, 12]) {
        const yy = y + (x === 8 ? 2 : 0);
        L.set(x, yy, 0xd8d8a8);
        L.set(x, yy + 1, 0x0c3a12);
      }
  },
  cactus_top: ([L], r) => {
    const wn = lattice(r, 1, 1);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const c = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
        let col = c > 6.6 ? 0x1a6224 : c > 5.6 ? 0x24752e : c > 2.6 ? 0x2f8839 : c > 1.6 ? 0x3e9a47 : 0x5fb466;
        if (c <= 5.6 && c > 2.6 && wn[y * S + x] > 0.85) col = 0x3e9a47;
        if ((x === y || x === 15 - y) && c > 2 && c < 6) col = 0x24752e;
        L.set(x, y, col);
      }
  },
  lily_pad: ([L]) => {
    const cv = new Canvas();
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const dx = x - 7.5;
        const dy = y - 7.5;
        const d = Math.hypot(dx, dy);
        if (d > 7.4) continue;
        const ang = Math.atan2(dy, dx);
        if (Math.abs(ang - 0.785) < 0.3 && d > 0.8) continue; // notch towards bottom-right
        const vein = Math.abs(Math.sin(ang * 3.5)) < 0.2 && d > 1.2 && d < 6.2;
        let v = 176 - (dx + dy) * 2.2;
        if (d > 6.4) v -= 26;
        if (vein) v -= 30;
        if (d < 1.2) v -= 20;
        cv.put(x, y, grey(Math.round(v / 8) * 8));
      }
    cv.toLayer(L);
  },
  seagrass: ([L], r) => {
    const cv = new Canvas();
    blades(cv, r, { count: 9, minH: 9, maxH: 16, lean: 2.0, lo: 0, hi: 1 }, () => 0);
    // recolour by height
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) if (cv.has(x, y)) cv.put(x, y, y < 5 ? 0x5cae3e : y < 10 ? 0x429632 : 0x2f7a26);
    cv.toLayer(L);
  },
  kelp: ([L], r) => {
    const cv = new Canvas();
    const pal = [0x3e5a10, 0x50701a, 0x648822, 0x7c9e2e];
    for (let y = 0; y < S; y++) {
      const x = Math.round(7.5 + Math.sin((y / 16) * Math.PI * 2) * 1.5);
      cv.put(x, y, pal[1]);
      cv.put(x + 1, y, pal[0]);
    }
    for (let k = 0; k < 4; k++) {
      const y0 = k * 4 + 1;
      const x0 = Math.round(7.5 + Math.sin((y0 / 16) * Math.PI * 2) * 1.5);
      const dir = k % 2 === 0 ? -1 : 1;
      for (let s = 1; s <= 4; s++) {
        const xx = dir < 0 ? x0 - s : x0 + 1 + s;
        cv.put(xx, y0 + Math.floor(s / 2), pal[2 + (s % 2)]);
        cv.put(xx, y0 + Math.floor(s / 2) + 1, pal[2]);
      }
    }
    cv.toLayer(L);
  },
  red_mushroom: ([L]) => {
    const cv = new Canvas();
    cv.map(
      [
        '......rrr.......',
        '.....rRWRr......',
        '....rRRRRWr.....',
        '....rWRRRRr.....',
        '.....kkkkk......',
        '......sSs.......',
        '......sSs.......',
        '......sSs.......',
      ],
      { r: 0x9c1a16, R: 0xd8281f, W: 0xf2ece4, k: 0x6a1410, s: 0xc8bfa8, S: 0xe0d8c4 },
    );
    cv.toLayer(L);
  },
  brown_mushroom: ([L]) => {
    const cv = new Canvas();
    cv.map(
      [
        '......bbb.......',
        '....bBBhBBb.....',
        '...bBBBBBBBb....',
        '....kkkkkkk.....',
        '......sSs.......',
        '......sSs.......',
      ],
      { b: 0x6e4c34, B: 0x91694a, h: 0xb08a68, k: 0x4a3222, s: 0xc8bfa8, S: 0xe0d8c4 },
    );
    cv.toLayer(L);
  },
  vine: ([L], r) => {
    // Tileable in both directions: strands follow periodic curves, leaves wrap.
    const cv = new Canvas();
    const leafShapes = [
      [[0, 0, 1], [1, 0, 0], [0, 1, 0], [1, 1, -1], [-1, 1, 1]],
      [[0, 0, 1], [0, 1, 0], [1, 1, 0], [1, 2, -1]],
      [[0, 0, 1], [1, 0, 1], [-1, 1, 1], [0, 1, 0], [1, 1, -1], [0, 2, -1]],
    ];
    const put = (x: number, y: number, v: number): void => cv.put(x & 15, y & 15, grey(v));
    for (let s = 0; s < 3; s++) {
      const x0 = 1.5 + s * 5.3 + r.range(0, 1.5);
      const amp = r.range(0.6, 1.1);
      const ph = r.range(0, 6.28);
      const xs = (y: number): number => Math.round(x0 + Math.sin((y / 16) * Math.PI * 2 + ph) * amp);
      for (let y = 0; y < S; y++) {
        put(xs(y), y, 120);
        if (xs(y) !== xs(y - 1)) put(xs(y - 1), y, 120);
      }
      const leaves = 4 + r.int(2);
      for (let k = 0; k < leaves; k++) {
        const y = Math.floor((k * 16) / leaves + r.range(0, 2));
        const side = k % 2 === 0 ? 1 : -1;
        const x = xs(y) + (side > 0 ? 1 : -2);
        const b = r.range(164, 200);
        for (const [dx, dy, kind] of r.pick(leafShapes)) put(x + dx, y + dy, Math.round((b + kind * 22) / 8) * 8);
      }
    }
    cv.toLayer(L);
  },
  wheat: ([L], r) => {
    const cv = new Canvas();
    const stalkC = [0x8a7a30, 0xa8963f];
    const grain = [0xa87c22, 0xcda03a, 0xe2bf55, 0xf2d880];
    for (const sx of [2, 5, 8, 11, 13]) {
      const top = 1 + r.int(4);
      const lean = r.chance(0.5) ? 1 : 0;
      for (let y = top + 5; y < S; y++) cv.put(sx + (y < 10 ? lean : 0), y, stalkC[y & 1]);
      for (let k = 0; k < 6; k++) {
        const y = top + k;
        const x = sx + lean;
        cv.put(x, y, grain[2]);
        cv.put(x + (k % 2 === 0 ? -1 : 1), y, k % 2 === 0 ? grain[3] : grain[1]);
      }
      cv.put(sx + lean, top - 1, grain[0]);
    }
    cv.toLayer(L);
  },
  coral_tube: ([L], r) => {
    const f = rank(fbm(r, [[4, 4, 0.5], [2, 2, 0.5], [1, 1, 0.4]]));
    paintField(L, f, [0x2c4fb6, 0x3560cb, 0x3e6ed9, 0x4a7de4], [0.15, 0.5, 0.85]);
    for (const [px, py] of scatter(r, 14, 3.2)) {
      const x = Math.floor(px);
      const y = Math.floor(py);
      L.set(x, y, 0x18307a);
      L.set(x + 1, y, 0x22409a);
      L.set(x, y + 1, 0x5a8cf0);
    }
  },
  coral_brain: ([L], r) => {
    const f = rank(fbm(r, [[4, 4, 1], [2, 2, 0.35]]));
    const g = rank(fbm(r, [[8, 8, 1], [4, 4, 0.5]]));
    const pal = [0xa83e6a, 0xc8507e, 0xd8648e, 0xe680a4];
    for (let i = 0; i < N; i++) {
      const a = Math.abs(f[i] - 0.5);
      const b = Math.abs(g[i] - 0.5);
      let k = 2;
      if (a < 0.07 || b < 0.05) k = 0;
      else if (a < 0.13) k = 1;
      else if (a > 0.36) k = 3;
      L.set(i & 15, i >> 4, pal[k]);
    }
  },
  coral_bubble: ([L], r) => {
    const f = rank(fbm(r, [[4, 4, 0.5], [1, 1, 0.5]]));
    paintField(L, f, [0x84208f, 0x9a2ca8, 0xa83cb8], [0.3, 0.75]);
    for (const [px, py] of scatter(r, 9, 4.2)) {
      const rad = r.range(1.1, 2.2);
      for (let y = -3; y <= 3; y++)
        for (let x = -3; x <= 3; x++) {
          const d = Math.hypot(x, y);
          if (d > rad + 0.3) continue;
          const lit = -(x + y);
          L.set(Math.floor(px) + x, Math.floor(py) + y, d > rad - 0.7 ? (lit > 0 ? 0xd27ae0 : 0x6c1878) : 0xb84ccc);
        }
    }
  },
  coral_fire: ([L], r) => {
    const f = rank(fbm(r, [[4, 4, 0.5], [2, 2, 0.6], [1, 1, 0.5]]));
    paintField(L, f, [0x8e1a1e, 0xa8222a, 0xbc2c32, 0xcc3c3e, 0xdc5450], [0.1, 0.3, 0.65, 0.9]);
  },
  coral_horn: ([L], r) => {
    const f = rank(fbm(r, [[4, 4, 0.5], [2, 2, 0.6], [1, 1, 0.5]]));
    paintField(L, f, [0xa48c18, 0xbca224, 0xccb22e, 0xd9c23a, 0xe6d24e], [0.1, 0.3, 0.65, 0.9]);
    for (const [px, py] of scatter(r, 8, 4)) L.set(Math.floor(px), Math.floor(py), 0x8a7210);
  },

  // ---------------- building ----------------
  stone_bricks: ([L], r) => stoneBricks(L, r),
  mossy_stone_bricks: ([L], r) => {
    stoneBricks(L, r);
    mossOver(L, r, 0.3, null);
  },
  bricks: ([L], r) => {
    const f = lattice(r, 1, 1);
    const cols = [0x8f3e2f, 0x9a4535, 0xa54d3b, 0x88392c, 0xa95440];
    for (let row = 0; row < 4; row++) {
      const off = row % 2 === 0 ? 0 : 4;
      for (let b = 0; b < 2; b++) {
        const c = r.pick(cols);
        for (let y = row * 4; y < row * 4 + 4; y++)
          for (let x = off + b * 8; x < off + b * 8 + 8; x++) {
            const lx = x - off - b * 8;
            const ly = y - row * 4;
            let col: number;
            if (ly === 3 || lx === 7) col = f[ix(x, y)] < 0.5 ? 0xb3aba0 : 0xa59c90;
            else {
              col = shade(c, 0.94 + f[ix(x, y)] * 0.12);
              if (ly === 0) col = shade(col, 1.08);
              if (ly === 2) col = shade(col, 0.92);
            }
            L.set(x, y, col);
          }
      }
    }
  },
  glass: ([L]) => {
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const edge = x === 0 || y === 0 || x === 15 || y === 15;
        if (edge) L.set(x, y, x === 0 || y === 0 ? 0xdcecef : 0xa9c3c8);
        else L.set(x, y, 0, 0);
      }
    for (const [x, y] of [
      [3, 4],
      [4, 3],
      [5, 2],
      [3, 5],
      [10, 11],
      [11, 10],
      [12, 9],
    ])
      L.set(x, y, 0xffffff);
  },
  hay_top: ([L], r) => {
    hayStraw(L, r, false);
    const wn = lattice(r, 1, 1);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const c = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
        if (c > 4.6 && c < 5.6) L.set(x, y, wn[y * S + x] < 0.5 ? 0x7a3a18 : 0x8e4a20);
      }
  },
  hay_side: ([L], r) => {
    hayStraw(L, r, true);
    const wn = lattice(r, 1, 1);
    for (const y0 of [3, 11])
      for (let x = 0; x < S; x++) {
        L.set(x, y0, wn[ix(x, y0)] < 0.5 ? 0x9a5426 : 0x8e4a20);
        L.set(x, y0 + 1, wn[ix(x, y0 + 1)] < 0.5 ? 0x7a3a18 : 0x6c3214);
      }
  },
  lantern: ([L]) => {
    const cv = new Canvas();
    cv.map(
      [
        '.......kk.......',
        '......k..k......',
        '.......kk.......',
        '.....mMMMMm.....',
        '.....kmmmmk.....',
        '.....kWYYOk.....',
        '.....kYWYOk.....',
        '.....kYYOOk.....',
        '.....kOOOOk.....',
        '.....mMMMMm.....',
        '......kkkk......',
      ],
      { k: 0x2a2d33, m: 0x474c55, M: 0x6c727c, Y: 0xffcf4a, O: 0xf0942a, W: 0xfff2b4 },
      0,
      3,
    );
    cv.toLayer(L);
  },
  glow_lamp: ([L], r) => {
    const f = rank(fbm(r, [[4, 4, 0.5], [2, 2, 0.5], [1, 1, 0.5]]));
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const c = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
        let col: number;
        if (c > 6.6) col = x === 0 || y === 0 ? 0x5e4228 : 0x3a2816;
        else if (c > 5.6) col = x === 1 || y === 1 ? 0x3a2816 : 0x6e5030;
        else {
          const v = f[y * S + x] * 0.5 + (1 - c / 6) * 0.6;
          col = [0xe8901c, 0xf5a82a, 0xfcc444, 0xffde76, 0xfff2b0][Math.min(4, Math.floor(v * 4.2))];
        }
        L.set(x, y, col);
      }
  },
  white_wool: ([L], r) => {
    const f = rank(fbm(r, [[2, 1, 0.6], [1, 2, 0.6], [4, 4, 0.3], [1, 1, 0.5]]));
    paintField(L, f, [0xd2d6d6, 0xdde0e0, 0xe7eaea, 0xf1f3f3], [0.1, 0.4, 0.8]);
  },
  oak_door: ([L], r) => {
    planksVertical(L, r, [0x6c5231, 0x987748, 0xa68350, 0xb18e58, 0xbd9a62]);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        if (x === 0 || x === 15 || y === 0 || y === 15) L.set(x, y, 0x5e4528);
        const win = y >= 2 && y <= 5 && ((x >= 3 && x <= 6) || (x >= 9 && x <= 12));
        if (win) L.set(x, y, 0, 0);
      }
    L.set(12, 9, 0x2a2a2a);
    L.set(12, 10, 0x4a4a4a);
  },
  bookshelf: ([L], r) => {
    planks(L, rngFor('oak_planks'), [0x6c5231, 0x987748, 0xa68350, 0xb18e58, 0xbd9a62]);
    const books = [0x8e2a22, 0x2c4c8a, 0x3a6e2c, 0x7a5a2a, 0x6a2c6e, 0xb08a2a, 0x2a6a6a, 0x9a4a2a];
    for (const [y0, y1] of [
      [1, 6],
      [9, 14],
    ]) {
      for (let y = y0; y <= y1; y++) for (let x = 1; x < 15; x++) L.set(x, y, 0x2b1c0e);
      let x = 1;
      while (x < 15) {
        const w = r.chance(0.7) ? 1 : 2;
        const top = y0 + r.int(2);
        const c = r.pick(books);
        if (r.chance(0.12)) {
          x += 1;
          continue;
        }
        for (let xx = x; xx < Math.min(15, x + w); xx++)
          for (let y = top; y <= y1; y++) {
            let col = xx === x ? shade(c, 1.15) : c;
            if (y === top + 1) col = shade(col, 1.3);
            L.set(xx, y, col);
          }
        x += w;
      }
    }
  },
  pumpkin_side: ([L], r) => {
    const f = rank(fbm(r, [[1, 8, 0.6], [1, 1, 0.4]]));
    const pal = [0xa65a0c, 0xc06e12, 0xcf7e18, 0xdc8e22, 0xe8a032];
    const rib = [0, 2, 3, 3, 2, 1, 2, 3, 3, 2, 1, 2, 3, 3, 2, 1];
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        let k = rib[x] + (f[y * S + x] > 0.8 ? 1 : f[y * S + x] < 0.15 ? -1 : 0);
        if (y === 0 || y === 15) k = Math.max(0, k - 1);
        L.set(x, y, pal[Math.max(0, Math.min(4, k))]);
      }
  },
  pumpkin_top: ([L], r) => {
    const f = rank(fbm(r, [[2, 2, 0.5], [1, 1, 0.5]]));
    const pal = [0xa65a0c, 0xc06e12, 0xcf7e18, 0xdc8e22, 0xe8a032];
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const dx = x - 7.5;
        const dy = y - 7.5;
        const c = Math.max(Math.abs(dx), Math.abs(dy));
        const ang = Math.atan2(dy, dx);
        // lobes between ribs: bright in the middle of each lobe, dark at the ribs
        const lobe = Math.cos(ang * 5 + 0.4);
        let k = lobe > 0.55 ? 4 : lobe > -0.2 ? 3 : lobe > -0.75 ? 2 : 1;
        if (f[y * S + x] > 0.85) k = Math.min(4, k + 1);
        if (c < 2.6) k = Math.min(k, 2);
        if (c > 6.6) k = Math.max(0, k - 1);
        L.set(x, y, pal[k]);
      }
    for (const [x, y, c] of [
      [7, 7, 0x8a7a34],
      [8, 7, 0x6e5f26],
      [7, 8, 0x6e5f26],
      [8, 8, 0x54471a],
    ] as const)
      L.set(x, y, c);
  },
  melon_side: ([L], r) => {
    const f = rank(fbm(r, [[1, 4, 0.5], [2, 8, 0.4], [1, 1, 0.4]]));
    const wob = lattice(r, 16, 4);
    const pal = [0x4a7012, 0x5c8618, 0x6c981e, 0x7caa26, 0x90bc34];
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const ph = (x + (wob[i] - 0.5) * 2.5) / 4;
        const band = ph - Math.floor(ph);
        let k = band < 0.25 ? 0 : band < 0.5 ? 2 : band < 0.75 ? 3 : 2;
        if (f[i] > 0.85) k = Math.min(4, k + 1);
        if (f[i] < 0.1) k = Math.max(0, k - 1);
        L.set(x, y, pal[k]);
      }
  },

  // ---------------- sky ----------------
  sun: ([L]) => {
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const c = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
        if (c < 4) L.set(x, y, c < 2.6 ? 0xfffff0 : 0xfff6c8, 255);
        else {
          const d = c - 3.5;
          const a = [0, 150, 90, 50, 22][Math.min(4, Math.round(d))];
          L.set(x, y, a ? 0xffdc6a : 0, a);
        }
      }
  },
  moon: (ls) => moon(ls),
};

// ------------------------------------------------------------------------------------------
// Larger helpers referenced by the table
// ------------------------------------------------------------------------------------------

function stoneBricks(L: Layer, rng: Rng): void {
  const f = rank(fbm(rng, [[4, 4, 0.5], [2, 2, 0.5], [1, 1, 0.5]]));
  const pal = [0x5f5f5f, 0x6e6e6e, 0x7a7a7a, 0x858585, 0x919191, 0x9c9c9c];
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const row = y >> 3;
      const ly = y & 7;
      const off = row === 0 ? 0 : 4;
      const lx = (x - off) & 7;
      const i = y * S + x;
      let k: number;
      if (ly === 7 || lx === 7) k = 0;
      else {
        k = 2 + q(f[i], [0.3, 0.75]);
        if (ly === 0 || lx === 0) k = Math.min(5, k + 1);
        if (ly === 6 || lx === 6) k = Math.max(1, k - 1);
      }
      L.set(x, y, pal[k]);
    }
}

function planksVertical(L: Layer, rng: Rng, pal: number[]): void {
  const grain = rank(fbm(rng, [[1, 8, 0.8], [1, 4, 0.8], [1, 2, 0.4], [1, 1, 0.3]]));
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const lx = x % 5;
      let k = 1 + q(grain[i], [0.25, 0.75]);
      if (lx === 0) k = 0;
      else if (lx === 1) k = Math.min(4, k + 1);
      L.set(x, y, pal[k]);
    }
}

function hayStraw(L: Layer, rng: Rng, vertical: boolean): void {
  const f = rank(vertical ? fbm(rng, [[1, 8, 1], [1, 4, 0.6], [1, 1, 0.3]]) : fbm(rng, [[2, 2, 0.6], [1, 1, 0.6]]));
  const pal = [0x9c7814, 0xb48e1a, 0xc8a222, 0xd8b42c, 0xe6c63c];
  paintField(L, f, pal, [0.1, 0.3, 0.65, 0.9]);
  if (!vertical) {
    for (let k = 0; k < 20; k++) {
      const x = rng.int(16);
      const y = rng.int(16);
      const dx = rng.chance(0.5) ? 1 : 0;
      const dy = dx ? (rng.chance(0.5) ? 1 : -1) : 1;
      const c = rng.chance(0.5) ? pal[4] : pal[1];
      for (let s = 0; s < 3; s++) L.set(x + dx * s, y + dy * s, c);
    }
  }
}

function tulip(L: Layer, pal: Record<string, number>): void {
  const cv = new Canvas();
  cv.map(
    [
      '......o.o.......',
      '.....oOoOo......',
      '.....OOhOO......',
      '.....OOOOO......',
      '.....oOOOo......',
      '......ooo.......',
      '.......s........',
      '...L...s........',
      '...lL..s...L....',
      '....lL.s..Ll....',
      '....dl.s.Ll.....',
      '.....l.sld......',
      '.......s........',
    ],
    { ...pal, ...STEM },
  );
  cv.toLayer(L);
}

let _tallGrass: Canvas | null = null;
function tallGrass(): Canvas {
  if (_tallGrass) return _tallGrass;
  const cv = new Canvas(16, 32);
  blades(cv, rngFor('tall_grass'), { count: 22, minH: 16, maxH: 31, lean: 2.5, lo: 120, hi: 214, thick: 0.4 });
  _tallGrass = cv;
  return cv;
}

let _lilac: Canvas | null = null;
function lilac(rng: Rng): Canvas {
  if (_lilac) return _lilac;
  const r = rngFor('lilac');
  const cv = new Canvas(16, 32);
  const leaf = [0x2e5e1c, 0x3e7a26, 0x52942f, 0x6aac3c];
  const flower = [0x7a3e98, 0xa462c4, 0xc58ae0, 0xe2b8f4];
  // stems
  for (const [x1, y1] of [
    [3, 6],
    [7, 2],
    [12, 5],
    [10, 12],
  ])
    cv.line(7.5, 31, x1, y1, 0x3a6a20);
  // leaves on the lower part
  for (let k = 0; k < 14; k++) blob(cv, r.range(2, 13), r.range(14, 30), r.range(1.0, 1.8), leaf, r);
  // flowers
  for (let k = 0; k < 16; k++) blob(cv, r.range(2, 13.5), r.range(2, 15), r.range(1.2, 2.0), flower, r);
  for (let k = 0; k < 4; k++) blob(cv, r.range(2, 13), r.range(15, 22), r.range(1.0, 1.5), flower, r);
  _lilac = cv;
  void rng;
  return cv;
}

function moon(ls: Layer[]): void {
  const base = 0xd8dee8;
  const crater = [
    [3, 3, 2],
    [7, 2, 1],
    [5, 6, 2],
    [8, 7, 1],
    [2, 7, 1],
    [6, 8, 1],
  ];
  const disc = new Int32Array(N).fill(-1);
  const x0 = 3;
  const y0 = 3;
  const sz = 10;
  for (let y = 0; y < sz; y++)
    for (let x = 0; x < sz; x++) {
      const corner = (x === 0 || x === sz - 1) && (y === 0 || y === sz - 1);
      if (corner) continue;
      let c = base;
      if ((x + y) % 7 === 0) c = 0xe6ebf2;
      for (const [cx, cy, s] of crater) {
        if (x >= cx && x < cx + s && y >= cy && y < cy + s) c = s > 1 && x === cx && y === cy ? 0x9aa3b4 : 0xb2bac8;
      }
      if (x === 1 || y === 1) c = mix(c, 0xf0f3f8, 0.4);
      disc[(y0 + y) * S + x0 + x] = c;
    }
  ls.forEach((L, f) => {
    const p = (f * Math.PI) / 4;
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const c = disc[y * S + x];
        if (c < 0) {
          L.set(x, y, 0, 0);
          continue;
        }
        const u = (x - x0 + 0.5 - sz / 2) / (sz / 2); // -1..1
        const v = (y - y0 + 0.5 - sz / 2) / (sz / 2);
        const w = Math.sqrt(Math.max(0, 1 - v * v * 0.6));
        const lit = p <= Math.PI + 1e-6 ? u <= w * Math.cos(p) : u >= -w * Math.cos(p);
        if (lit) L.set(x, y, c, 255);
        else L.set(x, y, shade(c, 0.14), 26);
      }
  });
}

// ------------------------------------------------------------------------------------------
// Post-processing
// ------------------------------------------------------------------------------------------

/** Spread colour of opaque pixels into alpha-0 pixels so mipmaps don't produce dark halos. */
// Ring-by-ring flood: each ring of still-empty pixels takes the average colour of its already
// filled 8-neighbours (clamped at the tile edge), then becomes a source for the next ring.
const _filled = new Uint8Array(N);
const _ringA = new Int32Array(N);
const _ringB = new Int32Array(N);
const _rgb = new Int32Array(N * 3);
function bleed(L: Layer): void {
  const px = L.px;
  const filled = _filled;
  let count = 0;
  for (let i = 0; i < N; i++) {
    filled[i] = px[i * 4 + 3] > 0 ? 1 : 0;
    count += filled[i];
  }
  if (count === 0) {
    for (let i = 0; i < N; i++) px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = 128;
    return;
  }
  if (count === N) return;
  // first ring: empty pixels touching a filled one
  let ring = _ringA;
  let other = _ringB;
  let len = 0;
  for (let i = 0; i < N; i++) {
    if (filled[i]) continue;
    const x = i & 15;
    const y = i >> 4;
    let touch = false;
    for (let dy = -1; dy <= 1 && !touch; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < S && yy < S && filled[yy * S + xx]) {
          touch = true;
          break;
        }
      }
    if (touch) ring[len++] = i;
  }
  while (len > 0) {
    for (let k = 0; k < len; k++) {
      const i = ring[k];
      const x = i & 15;
      const y = i >> 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= S || yy >= S) continue;
          const j = yy * S + xx;
          if (filled[j] !== 1) continue;
          r += px[j * 4];
          g += px[j * 4 + 1];
          b += px[j * 4 + 2];
          n++;
        }
      _rgb[k * 3] = Math.round(r / n);
      _rgb[k * 3 + 1] = Math.round(g / n);
      _rgb[k * 3 + 2] = Math.round(b / n);
    }
    for (let k = 0; k < len; k++) {
      const i = ring[k];
      px[i * 4] = _rgb[k * 3];
      px[i * 4 + 1] = _rgb[k * 3 + 1];
      px[i * 4 + 2] = _rgb[k * 3 + 2];
      filled[i] = 1;
    }
    // next ring: empty neighbours of this ring (mark 2 = queued)
    let nlen = 0;
    for (let k = 0; k < len; k++) {
      const i = ring[k];
      const x = i & 15;
      const y = i >> 4;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= S || yy >= S) continue;
          const j = yy * S + xx;
          if (filled[j] === 0) {
            filled[j] = 2;
            other[nlen++] = j;
          }
        }
    }
    const t = ring;
    ring = other;
    other = t;
    len = nlen;
  }
}

function fallback(L: Layer): void {
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) L.set(x, y, ((x >> 2) + (y >> 2)) & 1 ? 0xff00ff : 0x000000);
}

function finish(spec: TextureSpec, L: Layer): void {
  if (spec.tint === 'full') L.mask.fill(255);
  else if (spec.tint !== 'partial') L.mask.fill(0);
  if (spec.alpha === 'cutout') {
    for (let i = 0; i < N; i++) L.px[i * 4 + 3] = L.px[i * 4 + 3] >= 128 ? 255 : 0;
    bleed(L);
  } else if (spec.alpha !== 'translucent') {
    for (let i = 0; i < N; i++) L.px[i * 4 + 3] = 255;
  }
}

/** Names of textures that have no dedicated generator (for tooling / tests). */
export function missingGenerators(): string[] {
  return TEXTURES.filter((t) => !GEN[t.name]).map((t) => t.name);
}

export function generateTextures(): TextureSet {
  const layers = TEXTURE_LAYER_COUNT;
  const rgba = new Uint8Array(layers * N * 4);
  const mask = new Uint8Array(layers * N);
  let layer = 0;
  for (const spec of TEXTURES) {
    const frames = spec.frames ?? 1;
    const ls: Layer[] = [];
    for (let f = 0; f < frames; f++) {
      const l = layer + f;
      ls.push(new Layer(rgba.subarray(l * N * 4, (l + 1) * N * 4), mask.subarray(l * N, (l + 1) * N)));
    }
    const gen = GEN[spec.name];
    if (gen) gen(ls, rngFor(spec.name));
    else ls.forEach(fallback);
    for (const L of ls) finish(spec, L);
    layer += frames;
  }
  return { layers, rgba, mask };
}

// Meshes every chunk within `r` of a world position exactly like the compute worker does and reports
// quads per pass, plus how many full-cell faces a greedy merge (identical layer/light/AO/tint) would save.
//   npx tsx scripts/scene-quads.ts [seed] [x] [z] [r]
import { CHUNK } from '../src/gen/constants';
import { createContext, generateChunk } from '../src/gen/generateChunk';
import { computeLight } from '../src/mesh/light';
import { buildMesh } from '../src/mesh/mesher';
import { RA, RW } from '../src/mesh/region';
import { computeTints } from '../src/mesh/tints';

const [seed, px, pz, R] = [Number(process.argv[2] ?? 12345), Number(process.argv[3] ?? -24), Number(process.argv[4] ?? 2330), Number(process.argv[5] ?? 12)];
const ctx = createContext(seed);
const cache = new Map<string, Uint8Array>();
const heightCache = new Map<string, number>();
function chunk(cx: number, cz: number): Uint8Array {
  const k = cx + ',' + cz;
  let b = cache.get(k);
  if (!b) {
    const c = generateChunk(ctx, cx, cz);
    b = c.blocks;
    let m = 0;
    for (const h of c.heights) m = Math.max(m, h);
    cache.set(k, b);
    heightCache.set(k, m);
  }
  return b;
}

const light = new Uint8Array(RA * 320);
const tints = new Uint8Array(256 * 9);
const pcx = Math.floor(px / CHUNK);
const pcz = Math.floor(pz / CHUNK);
const totals = { opaque: 0, cutout: 0, translucent: 0, leaves: 0 };
const merged = { opaque: 0, cutout: 0, translucent: 0, leaves: 0 };
const uniformFull = { opaque: 0, cutout: 0, translucent: 0, leaves: 0 };
let chunks = 0;
// per face direction (0..5 box faces, 6 = other) quad counts, and quads left after whole-chunk direction culling
const byDir = new Array(7).fill(0);
let dirKept = 0;
// order of direction groups in the buffer; count drawn quads with a single contiguous range
const ORDER = [0, 4, 2, 1, 5, 3]; // +X +Z +Y(+other) -X -Z -Y
let rangeKept = 0;
let quadBack = 0;
const camY = Number(process.argv[6] ?? 89);
const t0 = performance.now();

/** greedy-merge estimate: count quads after merging uniform full-cell faces */
function analyse(data: Uint32Array): { quads: number; after: number; uniform: number } {
  const quads = data.length / 12;
  const groups = new Map<string, Set<number>>();
  let other = 0;
  let uniform = 0;
  for (let q = 0; q < quads; q++) {
    const o = q * 12;
    const w1 = data[o + 1] & ~1023;
    const w2 = data[o + 2];
    const f = (data[o + 1] >>> 20) & 7;
    let same = f < 6;
    for (let k = 1; k < 4 && same; k++) if ((data[o + k * 3 + 1] & ~1023) !== w1 || data[o + k * 3 + 2] !== w2) same = false;
    let xs = [0, 0], ys = [0, 0], zs = [0, 0];
    if (same) {
      const X = [], Y = [], Z = [];
      for (let k = 0; k < 4; k++) {
        const w0 = data[o + k * 3];
        X.push((w0 & 511) - 32);
        Z.push(((w0 >>> 9) & 511) - 32);
        Y.push(w0 >>> 18);
      }
      xs = [Math.min(...X), Math.max(...X)];
      ys = [Math.min(...Y), Math.max(...Y)];
      zs = [Math.min(...Z), Math.max(...Z)];
      const axis = f < 2 ? 0 : f < 4 ? 1 : 2;
      const ext = [xs[1] - xs[0], ys[1] - ys[0], zs[1] - zs[0]];
      const lo = [xs[0], ys[0], zs[0]];
      for (let a = 0; a < 3; a++) {
        if (a === axis) continue;
        if (ext[a] !== 16 || lo[a] % 16 !== 0) same = false;
      }
      if (ext[axis] !== 0) same = false;
    }
    if (!same) {
      other++;
      continue;
    }
    uniform++;
    const axis = f < 2 ? 0 : f < 4 ? 1 : 2;
    const plane = axis === 0 ? xs[0] : axis === 1 ? ys[0] : zs[0];
    // 2D cell coordinates (u along first tangent, v along second)
    const u = axis === 0 ? zs[0] / 16 : xs[0] / 16;
    const v = axis === 1 ? zs[0] / 16 : ys[0] / 16;
    const key = `${f}|${plane}|${w1}|${w2}`;
    let s = groups.get(key);
    if (!s) groups.set(key, (s = new Set()));
    s.add(v * 64 + u);
  }
  let after = other;
  for (const s of groups.values()) {
    // greedy rectangles: grow along u, then along v
    const cells = [...s].sort((a, b) => a - b);
    const used = new Set<number>();
    for (const c of cells) {
      if (used.has(c)) continue;
      const v0 = Math.floor(c / 64);
      const u0 = c % 64;
      let w = 1;
      while (s.has(v0 * 64 + u0 + w) && !used.has(v0 * 64 + u0 + w)) w++;
      let h = 1;
      outer: for (;;) {
        for (let du = 0; du < w; du++) {
          const k = (v0 + h) * 64 + u0 + du;
          if (!s.has(k) || used.has(k)) break outer;
        }
        h++;
      }
      for (let dv = 0; dv < h; dv++) for (let du = 0; du < w; du++) used.add((v0 + dv) * 64 + u0 + du);
      after++;
    }
  }
  return { quads, after, uniform };
}

for (let dz = -R; dz <= R; dz++) {
  for (let dx = -R; dx <= R; dx++) {
    if (dx * dx + dz * dz > R * R) continue;
    const cx = pcx + dx;
    const cz = pcz + dz;
    const cs: Uint8Array[] = [];
    let maxY = 0;
    for (let oz = -1; oz <= 1; oz++) {
      for (let ox = -1; ox <= 1; ox++) {
        cs.push(chunk(cx + ox, cz + oz));
        maxY = Math.max(maxY, heightCache.get(cx + ox + ',' + (cz + oz))!);
      }
    }
    const H = Math.min(320, maxY + 3);
    const region = new Uint8Array(RA * H);
    let k = 0;
    for (let oz = 0; oz < 3; oz++) {
      for (let ox = 0; ox < 3; ox++) {
        const b = cs[k++];
        for (let y = 0; y < H; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) region[(y * RW + oz * 16 + z) * RW + ox * 16 + x] = b[(y << 8) | (z << 4) | x];
      }
    }
    computeLight(region, H, light);
    computeTints(ctx.terrain, cx * CHUNK, cz * CHUNK, tints);
    const m = buildMesh({ blocks: region, light, H, tints, seed, wx0: cx * CHUNK, wz0: cz * CHUNK });
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    // directions that can face the camera for some block of this chunk
    const vis = [px > x0, px < x0 + 16, camY > m.minY, camY < m.maxY, pz > z0, pz < z0 + 16];
    for (const pass of ['opaque', 'cutout', 'translucent', 'leaves'] as const) {
      const d = m[pass];
      for (let q = 0; q < d.length / 12; q++) {
        const f = (d[q * 12 + 1] >>> 20) & 7;
        const dir = f < 6 && pass !== 'cutout' ? f : 6;
        byDir[dir]++;
        if (dir === 6 || vis[dir]) dirKept++;
        if (dir < 6) {
          const w0 = d[q * 12];
          const X = x0 + ((w0 & 511) - 32) / 16, Z = z0 + (((w0 >>> 9) & 511) - 32) / 16, Y = (w0 >>> 18) / 16;
          const fd = [px - X, X - px, camY - Y, Y - camY, pz - Z, Z - pz][dir];
          if (fd <= 0) quadBack++;
        }
      }
      if (pass !== 'cutout') {
        const cnt = new Array(6).fill(0);
        let other = 0;
        for (let q = 0; q < d.length / 12; q++) {
          const f = (d[q * 12 + 1] >>> 20) & 7;
          if (f < 6) cnt[f]++;
          else other++;
        }
        const nearLeaves = pass === 'leaves' && Math.hypot(x0 + 8 - px, z0 + 8 - pz) < 88;
        let lo = 6, hi = -1;
        ORDER.forEach((f, k) => {
          if (vis[f] || f === 2) { lo = Math.min(lo, k); hi = Math.max(hi, k); }
        });
        let kept = other;
        ORDER.forEach((f, k) => { if (nearLeaves || (k >= lo && k <= hi)) kept += cnt[f]; });
        rangeKept += kept;
      } else rangeKept += d.length / 12;
      const a = analyse(m[pass]);
      totals[pass] += a.quads;
      merged[pass] += a.after;
      uniformFull[pass] += a.uniform;
    }
    chunks++;
  }
}
const all = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
console.log(`chunks ${chunks} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
for (const p of Object.keys(totals) as (keyof typeof totals)[]) {
  console.log(`${p.padEnd(12)} quads ${String(totals[p]).padStart(8)}  uniform-full ${((uniformFull[p] / Math.max(1, totals[p])) * 100).toFixed(0).padStart(3)}%  after-merge ${String(merged[p]).padStart(8)} (${((merged[p] / Math.max(1, totals[p])) * 100).toFixed(0)}%)`);
}
const tq = all(totals);
console.log('by dir +X -X +Y -Y +Z -Z other:', byDir.map((v) => ((v / tq) * 100).toFixed(1) + '%').join(' '));
console.log(`chunk-level direction culling keeps ${dirKept} (${((dirKept / tq) * 100).toFixed(0)}%), per-quad backfacing ${((quadBack / tq) * 100).toFixed(0)}%`);
console.log(`single contiguous range (near leaves uncut) keeps ${rangeKept} (${((rangeKept / tq) * 100).toFixed(0)}%)`);
console.log(`total quads ${all(totals)} -> ${all(merged)} (${((all(merged) / all(totals)) * 100).toFixed(0)}%), tris ${all(totals) * 2} -> ${all(merged) * 2}`);

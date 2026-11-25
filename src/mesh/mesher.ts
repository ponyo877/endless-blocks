import { ANIM, AO_OCC, B, EMIT, OPAQUE, RENDER, Render, SHAPE, Shape, TEX, TINT, Tint, WATERY, isLeaves } from '../gen/blocks';
import { hash32 } from '../gen/rng';
import { RA, RC, RW } from './region';

// Builds packed vertex data for the centre chunk of a region.
// Vertex = 3 x uint32:
//   w0: x16+32 (9b) | z16+32 (9b) << 9 | y16 (14b) << 18        positions in 1/16 block, chunk-local
//   w1: u (5b) | v (5b) << 5 | layer (10b) << 10 | shade (3b) << 20 | ao (2b) << 23 | flags (7b) << 25
//   w2: sky (6b, sum of 4) | blk (6b) << 6 | r (7b) << 12 | g (7b) << 19 | b (6b) << 26
// Quads are 4 vertices; the index buffer is shared (0,1,2, 2,3,0).

export const FLAG_ANIM = 1;
export const FLAG_WATER = 2;
export const FLAG_EMISSIVE = 4;

export interface MeshInput {
  blocks: Uint8Array;
  light: Uint8Array;
  H: number;
  /** per centre column (z*16+x)*9: grass rgb, foliage rgb, water rgb */
  tints: Uint8Array;
  seed: number;
  wx0: number;
  wz0: number;
}

export interface MeshOutput {
  opaque: Uint32Array;
  cutout: Uint32Array;
  translucent: Uint32Array;
  leaves: Uint32Array;
  minY: number;
  maxY: number;
}

class Buf {
  data: Uint32Array;
  n = 0;
  constructor(cap = 12 * 4096) {
    this.data = new Uint32Array(cap);
  }
  reserve(k: number): void {
    if (this.n + k > this.data.length) {
      const d = new Uint32Array(Math.max(this.data.length * 2, this.n + k));
      d.set(this.data.subarray(0, this.n));
      this.data = d;
    }
  }
  take(): Uint32Array {
    const out = this.data.slice(0, this.n);
    this.n = 0;
    return out;
  }
}

const bufs = [new Buf(), new Buf(), new Buf(), new Buf()];

// face: 0 +X, 1 -X, 2 +Y, 3 -Y, 4 +Z, 5 -Z
const NORMALS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** corners (BL, BR, TR, TL) as unit-cube coordinates, for full-cell faces */
const CORNERS: number[][][] = [
  [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]],
  [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
  [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]],
  [[1, 0, 1], [0, 0, 1], [0, 0, 0], [1, 0, 0]],
  [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
  [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],
];

// Per face & corner: region-index deltas for side1, side2, corner cells relative to the "front" cell,
// plus their dy for bounds checks.
const AO_D = new Int32Array(6 * 4 * 3);
const AO_DY = new Int8Array(6 * 4 * 3);
(() => {
  for (let f = 0; f < 6; f++) {
    const n = NORMALS[f];
    const axis = n[0] !== 0 ? 0 : n[1] !== 0 ? 1 : 2;
    const t1 = axis === 0 ? 1 : 0; // first tangent axis
    const t2 = axis === 2 ? 1 : 2; // second tangent axis
    for (let c = 0; c < 4; c++) {
      const cc = CORNERS[f][c];
      const s1 = cc[t1] ? 1 : -1;
      const s2 = cc[t2] ? 1 : -1;
      const v1 = [0, 0, 0];
      const v2 = [0, 0, 0];
      v1[t1] = s1;
      v2[t2] = s2;
      const vc = [v1[0] + v2[0], v1[1] + v2[1], v1[2] + v2[2]];
      const vs = [v1, v2, vc];
      for (let k = 0; k < 3; k++) {
        const v = vs[k];
        AO_D[(f * 4 + c) * 3 + k] = (v[1] * RW + v[2]) * RW + v[0];
        AO_DY[(f * 4 + c) * 3 + k] = v[1];
      }
    }
  }
})();

const SHADE_PLANT = 6;

export function buildMesh(inp: MeshInput): MeshOutput {
  const { blocks, light, H, tints, seed, wx0, wz0 } = inp;
  const [opaque, cutout, translucent, leafBuf] = bufs;
  opaque.n = cutout.n = translucent.n = leafBuf.n = 0;
  let minY = 1 << 30;
  let maxY = -1;

  // tint of current column
  let tr = 255;
  let tg = 255;
  let tb = 255;
  let colTint = 0;

  const getId = (i: number, y: number): number => (y < 0 ? B.BEDROCK : y >= H ? B.AIR : blocks[i]);
  const getL = (i: number, y: number): number => (y < 0 ? 0 : y >= H ? 0xf0 : light[i]);

  const corner = new Int32Array(12); // x16,y16,z16 for 4 corners
  const cu = new Int32Array(4);
  const cv = new Int32Array(4);
  const cao = new Int32Array(4);
  const csky = new Int32Array(4);
  const cblk = new Int32Array(4);

  function tintFor(id: number): void {
    const t = TINT[id];
    if (t === Tint.NONE) {
      tr = 255; tg = 255; tb = 255;
    } else if (t === Tint.GRASS) {
      tr = tints[colTint]; tg = tints[colTint + 1]; tb = tints[colTint + 2];
    } else if (t === Tint.FOLIAGE) {
      tr = tints[colTint + 3]; tg = tints[colTint + 4]; tb = tints[colTint + 5];
    } else if (t === Tint.WATER) {
      tr = tints[colTint + 6]; tg = tints[colTint + 7]; tb = tints[colTint + 8];
    } else if (t === Tint.BIRCH) {
      tr = 128; tg = 167; tb = 85;
    } else if (t === Tint.SPRUCE) {
      tr = 97; tg = 153; tb = 97;
    } else {
      tr = 34; tg = 132; tb = 48;
    }
  }

  function emit(buf: Buf, layer: number, shade: number, flags: number, flip: boolean, lx: number, lz: number, by: number): void {
    buf.reserve(12);
    const d = buf.data;
    let n = buf.n;
    const w2t = ((tr >> 1) << 12) | ((tg >> 1) << 19) | ((tb >> 2) << 26);
    const ox = lx * 16 + 32;
    const oz = lz * 16 + 32;
    const oy = by * 16;
    for (let k = 0; k < 4; k++) {
      const c = flip ? (k + 1) & 3 : k;
      const x16 = ox + corner[c * 3];
      const y16 = oy + corner[c * 3 + 1];
      const z16 = oz + corner[c * 3 + 2];
      d[n++] = (x16 & 511) | ((z16 & 511) << 9) | (y16 << 18);
      d[n++] = (cu[c] & 31) | ((cv[c] & 31) << 5) | (layer << 10) | (shade << 20) | (cao[c] << 23) | (flags << 25);
      d[n++] = (csky[c] | (cblk[c] << 6) | w2t) >>> 0;
    }
    buf.n = n;
    if (by < minY) minY = by;
    if (by + 1 > maxY) maxY = by + 1;
  }

  /**
   * Emit an axis-aligned face of a box (coords in 1/16 within the cell).
   * mode 0: smooth light + AO sampled from the cell in front; 1: own cell light, no AO;
   * 2: smooth light + AO sampled around the own cell (partial-height tops).
   */
  function boxFace(
    buf: Buf, f: number, i: number, y: number, lx: number, lz: number,
    x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
    layer: number, flags: number, mode: number, uvOverride: number[] | null,
  ): void {
    // corners from the box
    const C = CORNERS[f];
    for (let c = 0; c < 4; c++) {
      const cc = C[c];
      corner[c * 3] = cc[0] ? x1 : x0;
      corner[c * 3 + 1] = cc[1] ? y1 : y0;
      corner[c * 3 + 2] = cc[2] ? z1 : z0;
    }
    // uvs
    let u0: number, u1: number, v0: number, v1: number;
    if (uvOverride) {
      [u0, v0, u1, v1] = uvOverride;
    } else if (f === 0) { u0 = 16 - z1; u1 = 16 - z0; v0 = 16 - y1; v1 = 16 - y0; }
    else if (f === 1) { u0 = z0; u1 = z1; v0 = 16 - y1; v1 = 16 - y0; }
    else if (f === 4) { u0 = x0; u1 = x1; v0 = 16 - y1; v1 = 16 - y0; }
    else if (f === 5) { u0 = 16 - x1; u1 = 16 - x0; v0 = 16 - y1; v1 = 16 - y0; }
    else if (f === 2) { u0 = x0; u1 = x1; v0 = z0; v1 = z1; }
    else { u0 = 16 - x1; u1 = 16 - x0; v0 = z0; v1 = z1; }
    cu[0] = u0; cv[0] = v1;
    cu[1] = u1; cv[1] = v1;
    cu[2] = u1; cv[2] = v0;
    cu[3] = u0; cv[3] = v0;

    let flip = false;
    if (mode === 1) {
      const l = getL(i, y);
      for (let c = 0; c < 4; c++) {
        cao[c] = 3;
        csky[c] = (l >> 4) * 4;
        cblk[c] = (l & 15) * 4;
      }
    } else {
      const n = NORMALS[f];
      let fi = i;
      let fy = y;
      if (mode === 0) {
        fi = i + (n[1] * RW + n[2]) * RW + n[0];
        fy = y + n[1];
      }
      const lc = getL(fi, fy);
      for (let c = 0; c < 4; c++) {
        const base = (f * 4 + c) * 3;
        const i1 = fi + AO_D[base];
        const i2 = fi + AO_D[base + 1];
        const i3 = fi + AO_D[base + 2];
        const y1_ = fy + AO_DY[base];
        const y2_ = fy + AO_DY[base + 1];
        const y3_ = fy + AO_DY[base + 2];
        const b1 = getId(i1, y1_);
        const b2 = getId(i2, y2_);
        const b3 = getId(i3, y3_);
        const o1 = AO_OCC[b1];
        const o2 = AO_OCC[b2];
        const o3 = AO_OCC[b3];
        cao[c] = o1 && o2 ? 0 : 3 - (o1 + o2 + o3);
        const p1 = OPAQUE[b1];
        const p2 = OPAQUE[b2];
        const l1 = p1 ? lc : getL(i1, y1_);
        const l2 = p2 ? lc : getL(i2, y2_);
        const l3 = (p1 && p2) || OPAQUE[b3] ? lc : getL(i3, y3_);
        csky[c] = (lc >> 4) + (l1 >> 4) + (l2 >> 4) + (l3 >> 4);
        cblk[c] = (lc & 15) + (l1 & 15) + (l2 & 15) + (l3 & 15);
      }
      const v0b = cao[0] * 24 + csky[0] + cblk[0];
      const v1b = cao[1] * 24 + csky[1] + cblk[1];
      const v2b = cao[2] * 24 + csky[2] + cblk[2];
      const v3b = cao[3] * 24 + csky[3] + cblk[3];
      flip = v0b + v2b < v1b + v3b;
    }
    emit(buf, layer, f, flags, flip, lx, lz, y);
  }

  function crossPlant(buf: Buf, i: number, y: number, lx: number, lz: number, layer: number, offset: boolean): void {
    let ox = 0;
    let oz = 0;
    if (offset) {
      const h = hash32(wx0 + lx, wz0 + lz, seed, 77);
      ox = (h & 7) - 3;
      oz = ((h >>> 3) & 7) - 3;
    }
    const l = getL(i, y);
    for (let c = 0; c < 4; c++) {
      cao[c] = 3;
      csky[c] = (l >> 4) * 4;
      cblk[c] = (l & 15) * 4;
    }
    cu[0] = 0; cv[0] = 16;
    cu[1] = 16; cv[1] = 16;
    cu[2] = 16; cv[2] = 0;
    cu[3] = 0; cv[3] = 0;
    const a = 1;
    const b = 15;
    // plane 1
    corner.set([a + ox, 0, a + oz, b + ox, 0, b + oz, b + ox, 16, b + oz, a + ox, 16, a + oz]);
    emit(buf, layer, SHADE_PLANT, 0, false, lx, lz, y);
    corner.set([a + ox, 0, b + oz, b + ox, 0, a + oz, b + ox, 16, a + oz, a + ox, 16, b + oz]);
    emit(buf, layer, SHADE_PLANT, 0, false, lx, lz, y);
  }

  // vertical range of the centre chunk that contains blocks
  let yMax = H - 1;
  outer: for (; yMax >= 0; yMax--) {
    const base = yMax * RA;
    for (let z = RC; z < RC + 16; z++) {
      for (let x = RC; x < RC + 16; x++) if (blocks[base + z * RW + x] !== B.AIR) break outer;
    }
  }

  for (let y = 0; y <= yMax; y++) {
    for (let lz = 0; lz < 16; lz++) {
      const z = lz + RC;
      for (let lx = 0; lx < 16; lx++) {
        const x = lx + RC;
        const i = (y * RW + z) * RW + x;
        const id = blocks[i];
        if (id === B.AIR) continue;
        colTint = (lz * 16 + lx) * 9;
        const shape = SHAPE[id];
        const render = RENDER[id];
        tintFor(id);
        const buf = render === Render.OPAQUE ? opaque : render === Render.CUTOUT ? (isLeaves(id) ? leafBuf : cutout) : translucent;
        const flags = (ANIM[id] > 1 ? FLAG_ANIM : 0) | (WATERY[id] && shape === Shape.LIQUID ? FLAG_WATER : 0) | (EMIT[id] >= 14 ? FLAG_EMISSIVE : 0);

        if (shape === Shape.CUBE) {
          const leaves = isLeaves(id);
          for (let f = 0; f < 6; f++) {
            if (f === 3 && y === 0) continue;
            const n = NORMALS[f];
            const ny = y + n[1];
            const ni = i + (n[1] * RW + n[2]) * RW + n[0];
            const nb = getId(ni, ny);
            if (OPAQUE[nb]) continue;
            if (nb === id && (leaves || render !== Render.OPAQUE)) continue;
            // faces into pitch-dark cave air can never be seen from the sky-bound camera
            if (nb === B.AIR && getL(ni, ny) === 0) continue;
            if (id === B.ICE && WATERY[nb]) continue;
            boxFace(buf, f, i, y, lx, lz, 0, 0, 0, 16, 16, 16, TEX[id * 6 + f], flags, 0, null);
          }
        } else if (shape === Shape.LIQUID) {
          const above = getId(i + RA, y + 1);
          const sameAbove = id === B.WATER ? WATERY[above] : above === id;
          const top = sameAbove ? 16 : 14;
          for (let f = 0; f < 6; f++) {
            if (f === 3 && y === 0) continue;
            const n = NORMALS[f];
            const ny = y + n[1];
            const ni = i + (n[1] * RW + n[2]) * RW + n[0];
            const nb = getId(ni, ny);
            if (OPAQUE[nb]) continue;
            if (id === B.WATER ? WATERY[nb] : nb === id) continue;
            if (nb === B.ICE) continue;
            if (f === 2 && sameAbove) continue;
            boxFace(buf, f, i, y, lx, lz, 0, 0, 0, 16, top, 16, TEX[id * 6 + f], flags, 0, null);
          }
          if (id === B.WATER) {
            // underwater plants are separate blocks; nothing more
          }
        } else if (shape === Shape.CROSS) {
          const offset = id !== B.SUGAR_CANE && id !== B.KELP && id !== B.SEAGRASS && id !== B.WHEAT;
          crossPlant(buf, i, y, lx, lz, TEX[id * 6], offset);
          if (WATERY[id]) {
            // waterlogged plant: draw water surface above if open
            const above = getId(i + RA, y + 1);
            if (!WATERY[above] && !OPAQUE[above]) {
              tintFor(B.WATER);
              boxFace(translucent, 2, i, y, lx, lz, 0, 0, 0, 16, 14, 16, TEX[B.WATER * 6 + 2], FLAG_ANIM | FLAG_WATER, 0, null);
            }
          }
        } else if (shape === Shape.SNOW_LAYER) {
          boxFace(buf, 2, i, y, lx, lz, 0, 0, 0, 16, 2, 16, TEX[id * 6 + 2], flags, 2, null);
          for (const f of [0, 1, 4, 5]) {
            const n = NORMALS[f];
            const nb = getId(i + n[2] * RW + n[0], y);
            if (OPAQUE[nb] || nb === B.SNOW_LAYER) continue;
            boxFace(buf, f, i, y, lx, lz, 0, 0, 0, 16, 2, 16, TEX[id * 6 + f], flags, 1, null);
          }
        } else if (shape === Shape.PATH) {
          for (let f = 0; f < 6; f++) {
            if (f === 3 && y === 0) continue;
            const n = NORMALS[f];
            const nb = getId(i + (n[1] * RW + n[2]) * RW + n[0], y + n[1]);
            if (OPAQUE[nb] && f !== 2) continue;
            boxFace(buf, f, i, y, lx, lz, 0, 0, 0, 16, 15, 16, TEX[id * 6 + f], flags, f === 2 ? 2 : 0, null);
          }
        } else if (shape === Shape.CACTUS) {
          for (let f = 0; f < 6; f++) {
            const n = NORMALS[f];
            if (f === 2 || f === 3) {
              const nb = getId(i + n[1] * RA, y + n[1]);
              if (OPAQUE[nb] || nb === B.CACTUS) continue;
              boxFace(buf, f, i, y, lx, lz, 0, 0, 0, 16, 16, 16, TEX[id * 6 + f], flags, 0, null);
            } else {
              // inset 1px
              const x0 = f === 0 ? 15 : f === 1 ? 1 : 0;
              const x1 = f === 0 ? 15 : f === 1 ? 1 : 16;
              const z0 = f === 4 ? 15 : f === 5 ? 1 : 0;
              const z1 = f === 4 ? 15 : f === 5 ? 1 : 16;
              boxFace(buf, f, i, y, lx, lz, x0, 0, z0, x1, 16, z1, TEX[id * 6 + f], flags, 1, [0, 0, 16, 16]);
            }
          }
        } else if (shape === Shape.FLAT) {
          // lily pad, randomly rotated uv
          const h = hash32(wx0 + lx, wz0 + lz, seed, 91) & 3;
          boxFace(buf, 2, i, y, lx, lz, 0, 0, 0, 16, 1, 16, TEX[id * 6 + 2], flags, 1, null);
          if (h) {
            const n = buf.n;
            // rotate uv indices by h (cheap: swap u/v pairs on the 4 emitted vertices)
            const d = buf.data;
            const us: number[] = [];
            for (let k = 0; k < 4; k++) us.push(d[n - 12 + k * 3 + 1] & 1023);
            for (let k = 0; k < 4; k++) {
              const w = d[n - 12 + k * 3 + 1];
              d[n - 12 + k * 3 + 1] = (w & ~1023) | us[(k + h) & 3];
            }
          }
        } else if (shape === Shape.VINE) {
          const f = id === B.VINE_N ? 4 : id === B.VINE_S ? 5 : id === B.VINE_E ? 1 : 0;
          const p = f === 4 ? 1 : f === 5 ? 15 : f === 1 ? 15 : 1;
          const x0 = f === 0 || f === 1 ? p : 0;
          const x1 = f === 0 || f === 1 ? p : 16;
          const z0 = f === 4 || f === 5 ? p : 0;
          const z1 = f === 4 || f === 5 ? p : 16;
          boxFace(buf, f, i, y, lx, lz, x0, 0, z0, x1, 16, z1, TEX[id * 6 + f], flags, 1, [0, 0, 16, 16]);
        } else if (shape === Shape.LANTERN) {
          const L = TEX[id * 6];
          for (let f = 0; f < 6; f++) {
            boxFace(buf, f, i, y, lx, lz, 5, 0, 5, 11, 7, 11, L, flags, 1, null);
          }
        }
      }
    }
  }

  return {
    opaque: opaque.take(),
    cutout: cutout.take(),
    translucent: translucent.take(),
    leaves: leafBuf.take(),
    minY: maxY < 0 ? 0 : minY,
    maxY: maxY < 0 ? 0 : maxY,
  };
}

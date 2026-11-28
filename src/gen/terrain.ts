import { CELL_XZ, CELL_Y, CORNERS_Y, HEIGHT, SEA } from './constants';
import { Biome, C_COAST, C_MUSHROOM, C_OCEAN, Climate, ClimateSample, mountainFactor, newClimate, pickBiome, smooth } from './climate';
import { Octaves } from './noise';
import { Rng, hash32 } from './rng';
import { dpow } from './dmath';

// Terrain density sampled on a 4 x 8 x 4 cell lattice ("corner columns" every 4 blocks)
// and trilinearly interpolated, as in modern voxel-game generators. All functions are pure
// functions of (seed, coordinates); caches are only for speed.

export interface CornerColumn {
  /** terrain density at y = 0, 8, ..., 320 (41 values). >0 = solid */
  dens: Float32Array;
  /** cave density (lazily computed). <0 = carved */
  cave: Float32Array | null;
  H: number;
  S: number;
  biome: number;
  t: number;
  h: number;
  c: number;
  e: number;
  pv: number;
  w: number;
  /** top solid y of this exact column (interpolated), -1 if none */
  top: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

const NOISE_CUT = 1.7;

export class Terrain {
  readonly seed: number;
  readonly climate: Climate;
  private readonly n3: Octaves;
  private readonly detail: Octaves;
  private readonly jag: Octaves;
  private readonly terrace: Octaves;
  private readonly cheese: Octaves;
  private readonly spagA: Octaves;
  private readonly spagB: Octaves;
  private readonly spagThick: Octaves;
  private readonly entrance: Octaves;
  private readonly cache = new Map<number, CornerColumn>();
  private readonly cacheLimit: number;
  private readonly cs: ClimateSample = newClimate();

  constructor(seed: number, cacheLimit = 6000) {
    this.seed = seed;
    this.cacheLimit = cacheLimit;
    this.climate = new Climate(seed);
    this.n3 = new Octaves(new Rng(hash32(seed, 201)), 1 / 84, [1, 0.85, 0.55, 0.3]);
    this.detail = new Octaves(new Rng(hash32(seed, 202)), 1 / 70, [1, 0.6, 0.3]);
    this.jag = new Octaves(new Rng(hash32(seed, 203)), 1 / 46, [1, 0.5, 0.25]);
    this.terrace = new Octaves(new Rng(hash32(seed, 204)), 1 / 300, [1, 0.5]);
    this.cheese = new Octaves(new Rng(hash32(seed, 211)), 1 / 72, [1, 0.5]);
    this.spagA = new Octaves(new Rng(hash32(seed, 212)), 1 / 58, [1, 0.3]);
    this.spagB = new Octaves(new Rng(hash32(seed, 213)), 1 / 58, [1, 0.3]);
    this.spagThick = new Octaves(new Rng(hash32(seed, 214)), 1 / 120, [1]);
    this.entrance = new Octaves(new Rng(hash32(seed, 215)), 1 / 90, [1, 0.5]);
  }

  /** base height H and vertical noise scale S for a corner column */
  private shape(X: number, Z: number, s: ClimateSample, out: CornerColumn): void {
    const { c, e, pv, w, t } = s;
    let H: number;
    if (c < 0.08) H = lerp(27, 37, c / 0.08);
    else if (c < C_OCEAN) H = lerp(37, 55, (c - 0.08) / (C_OCEAN - 0.08));
    else if (c < C_COAST) H = lerp(55, 65, (c - C_OCEAN) / (C_COAST - C_OCEAN));
    else H = 65 + (c - C_COAST) * 34;

    const inland = smooth(C_COAST - 0.03, 0.55, c);
    const hillAmp = lerp(17, 4, e) * inland;
    H += pv * hillAmp;
    H += this.detail.sample2(X, Z) * lerp(7, 2.5, e) * smooth(C_OCEAN - 0.05, C_COAST + 0.1, c);

    const m = mountainFactor(c, e);
    const peak = Math.max(0, pv);
    H += m * (dpow(peak, 1.15) * 128 + 12);

    // jagged peaks
    const J = m * smooth(0.55, 0.92, pv);
    if (J > 0) {
      const r = 1 - Math.abs(this.jag.sample2(X, Z)) * 2.2;
      H += J * Math.max(0, r) * Math.max(0, r) * 42;
    }

    // badlands mesas: terrace the land in hot, dry plateau regions
    const hot = smooth(0.82, 0.9, t) * smooth(0.4, 0.3, s.h);
    const mesa = hot * smooth(0.1, 0.4, pv) * inland * (1 - m);
    if (mesa > 0.01) {
      const lift = 28 * mesa;
      const raised = H + lift;
      const step = 9;
      const k = raised / step;
      const fl = Math.floor(k);
      const fr = k - fl;
      const terr = (fl + smooth(0.75, 0.95, fr)) * step;
      const tn = 0.5 + 0.5 * this.terrace.sample2(X, Z);
      H = lerp(H, terr, mesa * smooth(0.25, 0.55, tn + 0.3));
    }

    // rivers carve valley floors below sea level
    const r = smooth(-0.72, -0.95, pv) * smooth(C_OCEAN + 0.03, C_COAST + 0.06, c);
    if (r > 0) H = lerp(H, SEA - 5, r);

    // mushroom islands rise from the deep ocean
    if (c < C_MUSHROOM * 1.8) {
      const k = smooth(C_MUSHROOM * 1.8, C_MUSHROOM * 0.6, c) * smooth(0.48, 0.6, Math.abs(w));
      if (k > 0) H = lerp(H, 68 + this.detail.sample2(X, Z) * 6, k);
    }

    let S = lerp(4.8, 2.6, e) * (0.6 + 0.4 * inland) + 1.2;
    S += m * 20 + J * 8 + mesa * 2;
    if (c < C_OCEAN) S = Math.max(S, 3.5);
    if (r > 0) S = lerp(S, 3, r);
    out.H = H;
    out.S = S;
  }

  private key(ix: number, iz: number): number {
    return (ix + 1048576) * 2097152 + (iz + 1048576);
  }

  /** corner column at world (ix*4, iz*4) */
  corner(ix: number, iz: number): CornerColumn {
    const k = this.key(ix, iz);
    let col = this.cache.get(k);
    if (col) return col;
    if (this.cache.size >= this.cacheLimit) {
      // drop oldest quarter (Map preserves insertion order)
      let n = this.cacheLimit >> 2;
      for (const kk of this.cache.keys()) {
        this.cache.delete(kk);
        if (--n <= 0) break;
      }
    }
    col = this.computeCorner(ix, iz);
    this.cache.set(k, col);
    return col;
  }

  private computeCorner(ix: number, iz: number): CornerColumn {
    const X = ix * CELL_XZ;
    const Z = iz * CELL_XZ;
    const s = this.climate.sample(X, Z, this.cs);
    const col: CornerColumn = {
      dens: new Float32Array(CORNERS_Y),
      cave: null,
      H: 0,
      S: 1,
      biome: pickBiome(s),
      t: s.t,
      h: s.h,
      c: s.c,
      e: s.e,
      pv: s.pv,
      w: s.w,
      top: -1,
    };
    this.shape(X, Z, s, col);
    const { H, S } = col;
    const dens = col.dens;
    for (let cy = 0; cy < CORNERS_Y; cy++) {
      const y = cy * CELL_Y;
      const base = (H - y) / S;
      if (base > NOISE_CUT || base < -NOISE_CUT) {
        dens[cy] = base;
      } else {
        dens[cy] = base + this.n3.sample3v(X, y, Z, 1.35) * 1.15;
      }
    }
    dens[0] = Math.max(dens[0], 1); // y=0 always solid
    // own top
    for (let cy = CORNERS_Y - 2; cy >= 0; cy--) {
      const a = dens[cy];
      const b = dens[cy + 1];
      if (a > 0 || b > 0) {
        for (let y = CELL_Y - 1; y >= 0; y--) {
          if (lerp(a, b, y / CELL_Y) > 0) {
            col.top = cy * CELL_Y + y;
            break;
          }
        }
        if (col.top >= 0) break;
      }
    }
    return col;
  }

  /** cave density for a corner column; positive = rock stays */
  caveOf(ix: number, iz: number): Float32Array {
    const col = this.corner(ix, iz);
    if (col.cave) return col.cave;
    const X = ix * CELL_XZ;
    const Z = iz * CELL_XZ;
    const cave = new Float32Array(CORNERS_Y);
    const H = col.H;
    const nearWater = H < SEA + 4 || col.c < C_COAST + 0.02;
    const ent = this.entrance.sample2(X, Z);
    const thick = 0.085 + 0.035 * this.spagThick.sample2(X, Z);
    for (let cy = 0; cy < CORNERS_Y; cy++) {
      const y = cy * CELL_Y;
      if (y < 4 || col.dens[cy] < -0.6 || y > H + 6) {
        cave[cy] = 1;
        continue;
      }
      // cheese caverns, kept away from the surface
      const n = this.cheese.sample3v(X, y, Z, 1.7);
      let cheese = (0.36 - n) * 5;
      if (y > H - 14) cheese += (y - (H - 14)) * 0.25;
      // spaghetti tunnels
      const a = this.spagA.sample3v(X, y, Z, 1.25);
      const b = this.spagB.sample3v(X, y, Z, 1.25);
      let spag = (Math.abs(a) + Math.abs(b) - thick) * 9;
      if (y > H - 7 && ent < 0.18) spag += (y - (H - 7)) * 0.2;
      let v = Math.min(cheese, spag);
      if (nearWater && y > H - 12) v = Math.max(v, (y - (H - 12)) * 0.3);
      cave[cy] = v;
    }
    col.cave = cave;
    return cave;
  }

  /** bilinear blend of the 4 corner columns around block column (x,z) into out (41) */
  blendColumn(x: number, z: number, out: Float32Array, caves: Float32Array | null): void {
    const ix = Math.floor(x / CELL_XZ);
    const iz = Math.floor(z / CELL_XZ);
    const fx = (x - ix * CELL_XZ) / CELL_XZ;
    const fz = (z - iz * CELL_XZ) / CELL_XZ;
    const c00 = this.corner(ix, iz).dens;
    const c10 = this.corner(ix + 1, iz).dens;
    const c01 = this.corner(ix, iz + 1).dens;
    const c11 = this.corner(ix + 1, iz + 1).dens;
    for (let i = 0; i < CORNERS_Y; i++) {
      out[i] = lerp(lerp(c00[i], c10[i], fx), lerp(c01[i], c11[i], fx), fz);
    }
    if (caves) {
      const k00 = this.caveOf(ix, iz);
      const k10 = this.caveOf(ix + 1, iz);
      const k01 = this.caveOf(ix, iz + 1);
      const k11 = this.caveOf(ix + 1, iz + 1);
      for (let i = 0; i < CORNERS_Y; i++) {
        caves[i] = lerp(lerp(k00[i], k10[i], fx), lerp(k01[i], k11[i], fx), fz);
      }
    }
  }

  private readonly tmp = new Float32Array(CORNERS_Y);
  private readonly tmpCave = new Float32Array(CORNERS_Y);

  /** exact top solid terrain y (before caves & features) of a block column; -1 if none */
  columnTop(x: number, z: number): number {
    const v = this.tmp;
    this.blendColumn(x, z, v, null);
    return topOfBlended(v);
  }

  /** is the block at (x,y,z) carved by caves (only meaningful where terrain is solid) */
  carved(x: number, y: number, z: number): boolean {
    const v = this.tmp;
    const k = this.tmpCave;
    this.blendColumn(x, z, v, k);
    return valueAt(k, y) < 0;
  }

  /** biome at block column with fuzzy (jittered) borders on the 4-block lattice */
  biomeAt(x: number, z: number): number {
    const h = hash32(x, z, this.seed);
    const jx = ((h & 255) / 255 - 0.5) * 3;
    const jz = (((h >>> 8) & 255) / 255 - 0.5) * 3;
    const ix = Math.round((x + jx) / CELL_XZ);
    const iz = Math.round((z + jz) / CELL_XZ);
    return this.corner(ix, iz).biome;
  }

  /** smooth terrain slope (blocks per block) at a block column, from corner-column tops */
  slopeAt(x: number, z: number): number {
    const ix = Math.floor(x / CELL_XZ);
    const iz = Math.floor(z / CELL_XZ);
    const fx = (x - ix * CELL_XZ) / CELL_XZ;
    const fz = (z - iz * CELL_XZ) / CELL_XZ;
    const s00 = this.cornerSlope(ix, iz);
    const s10 = this.cornerSlope(ix + 1, iz);
    const s01 = this.cornerSlope(ix, iz + 1);
    const s11 = this.cornerSlope(ix + 1, iz + 1);
    return lerp(lerp(s00, s10, fx), lerp(s01, s11, fx), fz);
  }

  private cornerSlope(ix: number, iz: number): number {
    const tx1 = this.corner(ix + 1, iz).top;
    const tx0 = this.corner(ix - 1, iz).top;
    const tz1 = this.corner(ix, iz + 1).top;
    const tz0 = this.corner(ix, iz - 1).top;
    const gx = (tx1 - tx0) / (2 * CELL_XZ);
    const gz = (tz1 - tz0) / (2 * CELL_XZ);
    return Math.sqrt(gx * gx + gz * gz);
  }

  /** climate-ish values at block column (bilinear of corners), used for colours / features */
  cornerAt(x: number, z: number): CornerColumn {
    return this.corner(Math.round(x / CELL_XZ), Math.round(z / CELL_XZ));
  }

  clearCache(): void {
    this.cache.clear();
  }
}

export function valueAt(v: Float32Array, y: number): number {
  const cy = y >> 3;
  const ty = (y & 7) / CELL_Y;
  return lerp(v[cy], v[cy + 1], ty);
}

export function topOfBlended(v: Float32Array): number {
  for (let cy = CORNERS_Y - 2; cy >= 0; cy--) {
    const a = v[cy];
    const b = v[cy + 1];
    if (a > 0 || b > 0) {
      for (let y = CELL_Y - 1; y >= 0; y--) {
        if (lerp(a, b, y / CELL_Y) > 0) return cy * CELL_Y + y;
      }
    }
  }
  return -1;
}

export { Biome, HEIGHT };

import { C_COAST, C_OCEAN } from '../gen/climate';
import { CHUNK, SEA } from '../gen/constants';
import { PlacementCache } from '../gen/features/placement';
import { extent } from '../gen/features/trees';
import { Perlin } from '../gen/noise';
import { Rng, hash32, hashFloat } from '../gen/rng';
import { Structures } from '../gen/structures';
import { Surface } from '../gen/surface';
import { Terrain } from '../gen/terrain';

// Deterministic infinite flight path. Depends only on the seed: horizontal route from a
// receding-horizon beam search over the (exact) terrain heights, smoothed with a uniform cubic
// B-spline, densified to 1-block arc-length samples; altitude from an obstacle-aware profile
// (max filter -> slope limits -> box blur) so it is always above the terrain and trees.

const STEP = 24; // waypoint spacing
const HEADINGS = 7;
const TURN = (12 * Math.PI) / 180;
const DEPTH = 8;
const BEAM = 4;
const R_FILTER = 12;
const UP = 0.42;
const DOWN = 0.36;
const LOOK = 600; // altitude commits trail the known obstacle frontier by this much
const CLEAR = 4; // minimum clearance over obstacles

export const enum Mode {
  CRUISE = 0,
  LOW = 1,
  VISTA = 2,
}

interface BeamState {
  x: number;
  z: number;
  h: number;
  cost: number;
  ocean: number;
  first: number; // heading of first move
}

class Grow {
  a: Float64Array;
  n = 0;
  constructor(cap = 4096) {
    this.a = new Float64Array(cap);
  }
  push(v: number): void {
    if (this.n >= this.a.length) {
      const b = new Float64Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
}

export interface PathBatch {
  s0: number;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
}

export class PathPlanner {
  readonly terrain: Terrain;
  private readonly placements: PlacementCache;
  private readonly structures: Structures;
  private readonly seenVillages = new Set<number>();
  private readonly goalNoise: Perlin;
  private readonly treeMaps = new Map<number, Int16Array>();
  private readonly visited = new Map<number, number>();
  // waypoints
  private readonly wx: number[] = [];
  private readonly wz: number[] = [];
  private heading: number;
  private ocean = 0;
  // dense samples (index k = arc length in blocks)
  private readonly sx = new Grow();
  private readonly sz = new Grow();
  private readonly req = new Grow();
  private readonly ground = new Grow();
  private readonly pre = new Grow();
  private readonly fin = new Grow();
  private segDone = 0; // next spline segment to densify
  private carry = 0; // arc length already travelled into the next sample
  private preCommitted = 0;
  private finCommitted = 0;
  private sent = 0;
  readonly startX: number;
  readonly startZ: number;

  constructor(readonly seed: number) {
    this.terrain = new Terrain(seed, 24000);
    const surface = new Surface(seed);
    this.structures = new Structures(seed, this.terrain);
    this.placements = new PlacementCache(seed, this.terrain, surface, this.structures);
    this.goalNoise = new Perlin(new Rng(hash32(seed, 901)));
    const rng = new Rng(hash32(seed, 902));
    this.heading = rng.next() * Math.PI * 2;
    const start = this.findStart(rng);
    this.startX = start[0];
    this.startZ = start[1];
    const dx = Math.cos(this.heading);
    const dz = Math.sin(this.heading);
    this.wx.push(start[0] - dx * STEP * 2, start[0] - dx * STEP);
    this.wz.push(start[1] - dz * STEP * 2, start[1] - dz * STEP);
    this.wx.push(start[0]);
    this.wz.push(start[1]);
  }

  private findStart(rng: Rng): [number, number] {
    const t = this.terrain;
    const ox = Math.round((rng.next() - 0.5) * 4000);
    const oz = Math.round((rng.next() - 0.5) * 4000);
    for (let r = 0; r < 400; r++) {
      const a = r * 2.399963;
      const d = 64 * Math.sqrt(r);
      const x = Math.round(ox + Math.cos(a) * d);
      const z = Math.round(oz + Math.sin(a) * d);
      const c = t.cornerAt(x, z);
      const top = t.columnTop(x, z);
      if (c.c > C_COAST + 0.06 && top > SEA + 2 && top < 110) return [x, z];
    }
    return [ox, oz];
  }

  // ------------------------------------------------------------------ helpers

  private surfaceTop(x: number, z: number): number {
    return Math.max(this.terrain.columnTop(Math.floor(x), Math.floor(z)), SEA - 1);
  }

  private treeTop(x: number, z: number): number {
    const bx = Math.floor(x);
    const bz = Math.floor(z);
    const cx = Math.floor(bx / CHUNK);
    const cz = Math.floor(bz / CHUNK);
    const k = (cx + 1048576) * 2097152 + (cz + 1048576);
    let m = this.treeMaps.get(k);
    if (!m) {
      if (this.treeMaps.size > 4000) {
        let n = 1000;
        for (const kk of this.treeMaps.keys()) {
          this.treeMaps.delete(kk);
          if (--n <= 0) break;
        }
      }
      m = new Int16Array(256).fill(-1);
      const ox = cx * CHUNK;
      const oz = cz * CHUNK;
      for (let ncz = cz - 1; ncz <= cz + 1; ncz++) {
        for (let ncx = cx - 1; ncx <= cx + 1; ncx++) {
          for (const p of this.placements.get(ncx, ncz)) {
            const e = extent(p);
            const r = e.radius + 1;
            for (let dz = -r; dz <= r + 1; dz++) {
              for (let dx = -r; dx <= r + 1; dx++) {
                const lx = p.x + dx - ox;
                const lz = p.z + dz - oz;
                if (lx < 0 || lx >= 16 || lz < 0 || lz >= 16) continue;
                const i = lz * 16 + lx;
                if (e.top > m[i]) m[i] = e.top;
              }
            }
          }
        }
      }
      this.treeMaps.set(k, m);
    }
    return m[(bz - cz * CHUNK) * 16 + (bx - cx * CHUNK)];
  }

  private landBias = 0;
  private landWeight = 0;

  private goal(s: number): number {
    const g = this.goalNoise.noise2(s / 5200, 0.5) * 2.6;
    if (this.landWeight <= 0) return g;
    // blend toward the sensed land direction
    const x = Math.cos(g) * (1 - this.landWeight) + Math.cos(this.landBias) * this.landWeight;
    const z = Math.sin(g) * (1 - this.landWeight) + Math.sin(this.landBias) * this.landWeight;
    return Math.atan2(z, x);
  }

  /** look far ahead (continentalness only) and steer toward land when the sea dominates */
  private senseLand(x0: number, z0: number): void {
    const cl = this.terrain.climate;
    let vx = 0;
    let vz = 0;
    let seaAhead = 0;
    let n = 0;
    const tmp = { t: 0, h: 0, c: 0, e: 0, w: 0, pv: 0 };
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      for (const d of [350, 800, 1400]) {
        const c = cl.sample(x0 + Math.cos(a) * d, z0 + Math.sin(a) * d, tmp).c;
        const land = c > C_COAST + 0.02 ? 1 : 0;
        // prefer land roughly ahead
        const ahead = Math.cos(a - this.heading);
        const w = land * (0.6 + 0.4 * ahead) / Math.sqrt(d);
        vx += Math.cos(a) * w;
        vz += Math.sin(a) * w;
        if (ahead > 0.5) {
          seaAhead += 1 - land;
          n++;
        }
      }
    }
    const here = cl.sample(x0, z0, tmp).c;
    const seaFrac = n ? seaAhead / n : 0;
    const overSea = here < C_COAST ? 1 : 0;
    this.landWeight = Math.min(0.85, Math.max(0, seaFrac - 0.25) * 1.2 + overSea * 0.45);
    if (vx !== 0 || vz !== 0) this.landBias = Math.atan2(vz, vx);
    else this.landWeight = 0;
  }

  mode(k: number): Mode {
    const km = Math.floor(k / 900);
    const r = hashFloat(this.seed, km, 31);
    return r < 0.58 ? Mode.CRUISE : r < 0.8 ? Mode.LOW : Mode.VISTA;
  }

  private cellKey(x: number, z: number): number {
    return (Math.floor(x / 128) + 65536) * 131072 + (Math.floor(z / 128) + 65536);
  }

  private stepCost(x: number, z: number, h: number, dh: number, ocean: number, kApprox: number): { cost: number; ocean: number } {
    const t = this.terrain;
    const top = t.columnTop(Math.floor(x), Math.floor(z));
    const c = t.cornerAt(x, z);
    const water = top < SEA - 1;
    const river = water && c.pv < -0.75 && c.c > C_COAST;
    let cost = 0;
    const mode = this.mode(kApprox);
    const g = Math.max(top, SEA - 1);
    if (mode === Mode.VISTA) cost -= Math.min(1.2, Math.max(0, g - 90) * 0.008);
    else cost += Math.max(0, g - 72) * 0.011;
    let oc = ocean;
    if (water && !river) {
      oc++;
      cost += 0.3 + Math.min(3, oc * 0.3) + Math.max(0, C_OCEAN - c.c) * 6;
    } else {
      oc = 0;
      if (river) cost -= 0.25;
      else if (c.c < C_COAST + 0.05 && c.c > C_OCEAN) cost -= 0.18;
    }
    const turn = dh / 0.35;
    cost += turn * turn * 0.35;
    cost += (this.visited.get(this.cellKey(x, z)) ?? 0) * 1.6;
    // villages are worth a detour (until we've flown over them), but not across the sea
    if (!water) {
      const v = this.structures.nearestVillage(x, z, this.seenVillages);
      if (v && v.d < 400) cost -= 0.55 * (1 - v.d / 400);
    }
    cost += (1 - Math.cos(h - this.goal(kApprox))) * 0.9;
    return { cost, ocean: oc };
  }

  private nextWaypoint(): void {
    const n = this.wx.length;
    const x0 = this.wx[n - 1];
    const z0 = this.wz[n - 1];
    const kApprox = (n - 3) * STEP;
    if (n % 4 === 0) this.senseLand(x0, z0);
    let beams: BeamState[] = [{ x: x0, z: z0, h: this.heading, cost: 0, ocean: this.ocean, first: this.heading }];
    for (let d = 0; d < DEPTH; d++) {
      const next: BeamState[] = [];
      for (const b of beams) {
        for (let i = 0; i < HEADINGS; i++) {
          const dh = (i - (HEADINGS >> 1)) * TURN;
          const h = b.h + dh;
          const x = b.x + Math.cos(h) * STEP;
          const z = b.z + Math.sin(h) * STEP;
          const r = this.stepCost(x, z, h, Math.abs(dh), b.ocean, kApprox + (d + 1) * STEP);
          next.push({ x, z, h, cost: b.cost + r.cost * Math.pow(0.93, d), ocean: r.ocean, first: d === 0 ? h : b.first });
        }
      }
      next.sort((a, b) => a.cost - b.cost);
      beams = next.slice(0, BEAM);
    }
    const h = beams[0].first;
    // limit turn per waypoint
    let dh = h - this.heading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    const lim = (25 * Math.PI) / 180;
    this.heading += Math.max(-lim, Math.min(lim, dh));
    const x = x0 + Math.cos(this.heading) * STEP;
    const z = z0 + Math.sin(this.heading) * STEP;
    const top = this.terrain.columnTop(Math.floor(x), Math.floor(z));
    this.ocean = top < SEA - 1 ? this.ocean + 1 : 0;
    this.wx.push(x);
    this.wz.push(z);
    const nv = this.structures.nearestVillage(x, z, this.seenVillages);
    if (nv && nv.d < 36) this.seenVillages.add(nv.key);
    const ck = this.cellKey(x, z);
    this.visited.set(ck, (this.visited.get(ck) ?? 0) + 1);
  }

  /** densify spline segment j (needs waypoints j-1..j+2) into 1-block samples */
  private densify(j: number): void {
    const p0x = this.wx[j - 1], p1x = this.wx[j], p2x = this.wx[j + 1], p3x = this.wx[j + 2];
    const p0z = this.wz[j - 1], p1z = this.wz[j], p2z = this.wz[j + 1], p3z = this.wz[j + 2];
    const N = 32;
    const px = new Float64Array(N + 1);
    const pz = new Float64Array(N + 1);
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const t2 = t * t;
      const t3 = t2 * t;
      const b0 = (1 - t) * (1 - t) * (1 - t);
      const b1 = 3 * t3 - 6 * t2 + 4;
      const b2 = -3 * t3 + 3 * t2 + 3 * t + 1;
      const b3 = t3;
      px[i] = (b0 * p0x + b1 * p1x + b2 * p2x + b3 * p3x) / 6;
      pz[i] = (b0 * p0z + b1 * p1z + b2 * p2z + b3 * p3z) / 6;
    }
    let need = 1 - this.carry; // distance until next sample
    if (this.sx.n === 0) {
      this.sx.push(px[0]);
      this.sz.push(pz[0]);
      need = 1;
    }
    for (let i = 0; i < N; i++) {
      const ax = px[i], az = pz[i];
      const dx = px[i + 1] - ax;
      const dz = pz[i + 1] - az;
      const len = Math.sqrt(dx * dx + dz * dz);
      let pos = 0;
      while (len - pos >= need) {
        pos += need;
        const f = pos / len;
        this.sx.push(ax + dx * f);
        this.sz.push(az + dz * f);
        need = 1;
      }
      need -= len - pos;
    }
    this.carry = 1 - need;
  }

  /** obstacle requirement for samples that don't have it yet */
  private fillReq(): void {
    const n = this.sx.n;
    for (let k = this.req.n; k < n - 1; k++) {
      const a = Math.max(0, k - 1);
      const tx = this.sx.a[k + 1] - this.sx.a[a];
      const tz = this.sz.a[k + 1] - this.sz.a[a];
      const tl = Math.sqrt(tx * tx + tz * tz) || 1;
      const nx = -tz / tl;
      const nz = tx / tl;
      let g = 0;
      let o = 0;
      for (let j = -3; j <= 3; j++) {
        const x = this.sx.a[k] + nx * j;
        const z = this.sz.a[k] + nz * j;
        const s = this.surfaceTop(x, z);
        if (s > g) g = s;
        const tt = this.treeTop(x, z);
        const st = this.structures.topAt(Math.floor(x), Math.floor(z));
        const ob = Math.max(s, tt, st);
        if (ob > o) o = ob;
      }
      this.req.push(o + 1 + CLEAR);
      this.ground.push(g + 1);
    }
  }

  private windowMax(arr: Grow, k: number, r: number): number {
    let m = -1e9;
    const lo = Math.max(0, k - r);
    const hi = Math.min(arr.n - 1, k + r);
    for (let i = lo; i <= hi; i++) if (arr.a[i] > m) m = arr.a[i];
    return m;
  }

  private preferred(k: number): number {
    const mode = this.mode(k);
    if (mode === Mode.VISTA) return this.windowMax(this.ground, k, 80) + 16;
    if (mode === Mode.LOW) return this.windowMax(this.ground, k, 16) + 6;
    return this.windowMax(this.ground, k, 28) + 12;
  }

  private updateProfile(): void {
    const K = this.req.n;
    const P = this.preCommitted;
    const end = K - 90; // preferred() looks up to 80 ahead
    if (end - P < 2 * R_FILTER) return;
    const m = end - R_FILTER;
    const a = new Float64Array(m - P);
    for (let i = P; i < m; i++) {
      let v = this.windowMax(this.req, i, R_FILTER);
      const pr = this.preferred(i);
      if (pr > v) v = pr;
      a[i - P] = v;
    }
    // climb early enough for what's ahead
    for (let i = a.length - 2; i >= 0; i--) a[i] = Math.max(a[i], a[i + 1] - UP);
    // descend gently from what's behind
    let prev = P > 0 ? this.pre.a[P - 1] : a[0];
    for (let i = 0; i < a.length; i++) {
      a[i] = Math.max(a[i], prev - DOWN);
      prev = a[i];
    }
    // commit the part far enough behind the obstacle frontier
    const commitTo = m - LOOK;
    for (let i = P; i < commitTo; i++) {
      this.pre.push(a[i - P]);
    }
    this.preCommitted = Math.max(P, commitTo);
    // box blur into fin
    for (let i = this.finCommitted; i < this.preCommitted - R_FILTER; i++) {
      let s = 0;
      let c = 0;
      for (let j = i - R_FILTER; j <= i + R_FILTER; j++) {
        const jj = j < 0 ? 0 : j;
        s += this.pre.a[jj];
        c++;
      }
      this.fin.push(s / c);
      this.finCommitted = i + 1;
    }
  }

  /** plan until at least `k` final samples exist; returns the newly committed batch */
  planUntil(k: number, budgetMs = 30): PathBatch | null {
    const t0 = performance.now();
    while (this.finCommitted < k && performance.now() - t0 < budgetMs) {
      this.nextWaypoint();
      const n = this.wx.length;
      while (this.segDone + 3 <= n - 1) {
        if (this.segDone >= 1) this.densify(this.segDone);
        this.segDone++;
      }
      this.fillReq();
      this.updateProfile();
    }
    if (this.finCommitted <= this.sent) return null;
    const s0 = this.sent;
    const n = this.finCommitted - s0;
    const out: PathBatch = { s0, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };
    for (let i = 0; i < n; i++) {
      out.x[i] = this.sx.a[s0 + i];
      out.y[i] = this.fin.a[s0 + i];
      out.z[i] = this.sz.a[s0 + i];
    }
    this.sent = this.finCommitted;
    return out;
  }

  /** debugging: requirement at sample k */
  reqAt(k: number): number {
    return this.req.a[k];
  }

  get committed(): number {
    return this.finCommitted;
  }
}

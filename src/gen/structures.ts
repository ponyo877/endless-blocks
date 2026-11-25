import { B } from './blocks';
import { BIOMES, Biome } from './climate';
import { CHUNK, SEA } from './constants';
import type { Writer } from './features/trees';
import { Rng, hash32 } from './rng';
import type { Terrain } from './terrain';

// Sparse hand-made structures: small villages, desert pyramids and ruined watchtowers.
// One candidate per GRID x GRID chunk cell; a plan is a pure function of (seed, cell) and the
// terrain, so every chunk it overlaps rebuilds exactly the same blocks.

export const GRID = 16; // chunks per cell side
const CELL_BLOCKS = GRID * CHUNK;

export const enum SType {
  VILLAGE = 0,
  PYRAMID = 1,
  TOWER = 2,
}

interface Box {
  x0: number;
  z0: number;
  x1: number; // inclusive
  z1: number;
  top: number; // highest y written inside this box
}

interface Palette {
  wall: number;
  frame: number;
  roof: number;
  floor: number;
  base: number;
  flatRoof: boolean;
}

interface House extends Box {
  y: number; // floor level (first air block above the floor)
  h: number; // wall height
  door: number; // 0 +x, 1 -x, 2 +z, 3 -z
  decor: number;
}

interface Farm extends Box {
  y: number;
  alongX: boolean;
}

interface Lamp {
  x: number;
  z: number;
  y: number;
}

export interface Structure {
  type: SType;
  x: number;
  z: number;
  y: number;
  bbox: Box;
  /** column footprints with their top heights (for the planner and tree rejection) */
  parts: Box[];
  pal: Palette;
  houses: House[];
  farms: Farm[];
  paths: [number, number][];
  lamps: Lamp[];
  seed: number;
  size: number; // pyramid half-size / tower radius
  height: number;
}

const VILLAGE_BIOMES = new Set<number>([
  Biome.PLAINS, Biome.SUNFLOWER_PLAINS, Biome.MEADOW, Biome.SAVANNA, Biome.DESERT, Biome.TAIGA, Biome.SNOWY_PLAINS,
]);

function palette(biome: number): Palette {
  switch (biome) {
    case Biome.DESERT:
      return { wall: B.SANDSTONE, frame: B.T_YELLOW, roof: B.SANDSTONE, floor: B.SANDSTONE, base: B.SANDSTONE, flatRoof: true };
    case Biome.SAVANNA:
      return { wall: B.T_WHITE, frame: B.ACACIA_LOG, roof: B.HAY, floor: B.OAK_PLANKS, base: B.COBBLESTONE, flatRoof: false };
    case Biome.TAIGA:
      return { wall: B.SPRUCE_PLANKS, frame: B.SPRUCE_LOG, roof: B.SPRUCE_PLANKS, floor: B.SPRUCE_PLANKS, base: B.MOSSY_COBBLE, flatRoof: false };
    case Biome.SNOWY_PLAINS:
      return { wall: B.SPRUCE_PLANKS, frame: B.SPRUCE_LOG, roof: B.SNOW, floor: B.SPRUCE_PLANKS, base: B.COBBLESTONE, flatRoof: false };
    default:
      return { wall: B.OAK_PLANKS, frame: B.OAK_LOG, roof: B.SPRUCE_PLANKS, floor: B.OAK_PLANKS, base: B.COBBLESTONE, flatRoof: false };
  }
}

function overlaps(a: Box, b: Box, gap: number): boolean {
  return a.x0 - gap <= b.x1 && b.x0 - gap <= a.x1 && a.z0 - gap <= b.z1 && b.z0 - gap <= a.z1;
}

export class Structures {
  private readonly cache = new Map<number, Structure | null>();
  private readonly tmp: Structure[] = [];

  constructor(private readonly seed: number, private readonly terrain: Terrain) {}

  /** structure planned in grid cell (gx, gz), or null */
  cell(gx: number, gz: number): Structure | null {
    const k = (gx + 65536) * 131072 + (gz + 65536);
    if (this.cache.has(k)) return this.cache.get(k)!;
    if (this.cache.size > 400) {
      let n = 100;
      for (const kk of this.cache.keys()) {
        this.cache.delete(kk);
        if (--n <= 0) break;
      }
    }
    const s = this.plan(gx, gz);
    this.cache.set(k, s);
    return s;
  }

  /** structures whose bounding box intersects the block rectangle */
  near(x0: number, z0: number, x1: number, z1: number, out: Structure[] = this.tmp): Structure[] {
    out.length = 0;
    const g0x = Math.floor((x0 - 128) / CELL_BLOCKS);
    const g1x = Math.floor((x1 + 128) / CELL_BLOCKS);
    const g0z = Math.floor((z0 - 128) / CELL_BLOCKS);
    const g1z = Math.floor((z1 + 128) / CELL_BLOCKS);
    for (let gz = g0z; gz <= g1z; gz++) {
      for (let gx = g0x; gx <= g1x; gx++) {
        const s = this.cell(gx, gz);
        if (!s) continue;
        const b = s.bbox;
        if (b.x0 <= x1 && x0 <= b.x1 && b.z0 <= z1 && z0 <= b.z1) out.push(s);
      }
    }
    return out;
  }

  /** highest structure block in column (x, z), or -1 */
  topAt(x: number, z: number): number {
    let top = -1;
    for (const s of this.near(x, z, x, z)) {
      for (const p of s.parts) if (x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1 && p.top > top) top = p.top;
    }
    return top;
  }

  /** trees are not placed on structure grounds */
  blocksTree(x: number, z: number): boolean {
    for (const s of this.near(x - 8, z - 8, x + 8, z + 8)) {
      const b = s.bbox;
      if (x >= b.x0 - 6 && x <= b.x1 + 6 && z >= b.z0 - 6 && z <= b.z1 + 6) return true;
    }
    return false;
  }

  /** nearest village centre to (x, z) within the 3x3 cells around it (for the planner) */
  nearestVillage(x: number, z: number, skip?: Set<number>): { x: number; z: number; d: number; key: number } | null {
    const gx = Math.floor(x / CELL_BLOCKS);
    const gz = Math.floor(z / CELL_BLOCKS);
    let best: { x: number; z: number; d: number; key: number } | null = null;
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const s = this.cell(gx + dx, gz + dz);
        if (!s || s.type !== SType.VILLAGE) continue;
        const key = (gx + dx + 65536) * 131072 + (gz + dz + 65536);
        if (skip && skip.has(key)) continue;
        const d = Math.hypot(s.x - x, s.z - z);
        if (!best || d < best.d) best = { x: s.x, z: s.z, d, key };
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ planning

  private plan(gx: number, gz: number): Structure | null {
    const rng = new Rng(hash32(this.seed, gx, gz, 0x57c7));
    const t = this.terrain;
    const x = gx * CELL_BLOCKS + 64 + rng.int(CELL_BLOCKS - 128);
    const z = gz * CELL_BLOCKS + 64 + rng.int(CELL_BLOCKS - 128);
    const typeRoll = rng.next();
    const seed = rng.nextU32();
    const biome = t.biomeAt(x, z);
    const info = BIOMES[biome];
    if (!info || info.ocean || info.river) return null;
    const top = t.columnTop(x, z);
    if (top < SEA + 1) return null;
    // flatness probe
    let lo = top;
    let hi = top;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const h = t.columnTop(Math.round(x + Math.cos(a) * 22), Math.round(z + Math.sin(a) * 22));
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    const r = new Rng(seed);
    if (VILLAGE_BIOMES.has(biome) && typeRoll < 0.72 && hi - lo <= 9 && lo >= SEA) {
      return this.planVillage(x, z, top, biome, r, seed);
    }
    if (biome === Biome.DESERT && typeRoll >= 0.72 && hi - lo <= 7) return this.planPyramid(x, z, top, r, seed);
    if (!VILLAGE_BIOMES.has(biome) && typeRoll < 0.28 && hi - lo <= 14 && biome !== Biome.SWAMP && biome !== Biome.MUSHROOM_FIELDS) {
      return this.planTower(x, z, top, r, seed);
    }
    return null;
  }

  private base(type: SType, x: number, z: number, y: number, pal: Palette, seed: number): Structure {
    return {
      type, x, z, y, pal, seed,
      bbox: { x0: x, z0: z, x1: x, z1: z, top: y },
      parts: [], houses: [], farms: [], paths: [], lamps: [], size: 0, height: 0,
    };
  }

  private addPart(s: Structure, b: Box): void {
    s.parts.push(b);
    const bb = s.bbox;
    bb.x0 = Math.min(bb.x0, b.x0);
    bb.z0 = Math.min(bb.z0, b.z0);
    bb.x1 = Math.max(bb.x1, b.x1);
    bb.z1 = Math.max(bb.z1, b.z1);
    bb.top = Math.max(bb.top, b.top);
  }

  private planVillage(cx: number, cz: number, top: number, biome: number, rng: Rng, seed: number): Structure {
    const t = this.terrain;
    const pal = palette(biome);
    const s = this.base(SType.VILLAGE, cx, cz, top + 1, pal, seed);
    // well
    this.addPart(s, { x0: cx - 2, z0: cz - 2, x1: cx + 1, z1: cz + 1, top: top + 5 });
    const taken: Box[] = [{ x0: cx - 4, z0: cz - 4, x1: cx + 3, z1: cz + 3, top: 0 }];
    const n = 5 + rng.int(5);
    const a0 = rng.next() * Math.PI * 2;
    for (let i = 0; i < n * 3 && s.houses.length < n; i++) {
      const a = a0 + i * 2.39996 + rng.range(-0.2, 0.2);
      const d = 13 + rng.int(22) + (i > n ? 8 : 0);
      const w = 5 + rng.int(3);
      const dd = 5 + rng.int(3);
      const hx = Math.round(cx + Math.cos(a) * d - w / 2);
      const hz = Math.round(cz + Math.sin(a) * d - dd / 2);
      const box = { x0: hx, z0: hz, x1: hx + w - 1, z1: hz + dd - 1, top: 0 };
      if (taken.some((b) => overlaps(b, box, 3))) continue;
      // ground: highest corner, all corners within reach
      let hi = -1;
      let lo = 1e9;
      for (const [px, pz] of [[box.x0, box.z0], [box.x1, box.z0], [box.x0, box.z1], [box.x1, box.z1], [(box.x0 + box.x1) >> 1, (box.z0 + box.z1) >> 1]]) {
        const h = t.columnTop(px, pz);
        hi = Math.max(hi, h);
        lo = Math.min(lo, h);
      }
      if (lo < SEA || hi - lo > 4 || Math.abs(hi - top) > 7) continue;
      const wallH = 3 + (rng.chance(0.3) ? 1 : 0);
      const roofH = pal.flatRoof ? 1 : Math.ceil(Math.min(w, dd) / 2) + 1;
      // door faces the well
      const mx = (box.x0 + box.x1) / 2 - cx;
      const mz = (box.z0 + box.z1) / 2 - cz;
      const door = Math.abs(mx) > Math.abs(mz) ? (mx > 0 ? 1 : 0) : mz > 0 ? 3 : 2;
      const house: House = { ...box, y: hi + 1, h: wallH, door, decor: rng.int(4), top: hi + 1 + wallH + roofH + 1 };
      taken.push(box);
      s.houses.push(house);
      this.addPart(s, { x0: box.x0 - 1, z0: box.z0 - 1, x1: box.x1 + 1, z1: box.z1 + 1, top: house.top });
      // path from the door to the well
      const ddx = door === 0 ? 1 : door === 1 ? -1 : 0;
      const ddz = door === 2 ? 1 : door === 3 ? -1 : 0;
      let px = door === 0 ? box.x1 + 1 : door === 1 ? box.x0 - 1 : (box.x0 + box.x1) >> 1;
      let pz = door === 2 ? box.z1 + 1 : door === 3 ? box.z0 - 1 : (box.z0 + box.z1) >> 1;
      px += ddx;
      pz += ddz;
      for (let k = 0; k < 80; k++) {
        s.paths.push([px, pz]);
        const ex = cx - px;
        const ez = cz - pz;
        if (Math.abs(ex) <= 2 && Math.abs(ez) <= 2) break;
        if (Math.abs(ex) >= Math.abs(ez)) px += Math.sign(ex);
        else pz += Math.sign(ez);
      }
    }
    // farms
    const nf = biome === Biome.DESERT ? 1 : 1 + rng.int(3);
    for (let i = 0; i < nf * 4 && s.farms.length < nf; i++) {
      const a = rng.next() * Math.PI * 2;
      const d = 20 + rng.int(18);
      const alongX = rng.chance(0.5);
      const w = alongX ? 9 : 7;
      const dd = alongX ? 7 : 9;
      const fx = Math.round(cx + Math.cos(a) * d - w / 2);
      const fz = Math.round(cz + Math.sin(a) * d - dd / 2);
      const box = { x0: fx, z0: fz, x1: fx + w - 1, z1: fz + dd - 1, top: 0 };
      if (taken.some((b) => overlaps(b, box, 2))) continue;
      const h = t.columnTop(fx + (w >> 1), fz + (dd >> 1));
      let ok = h >= SEA;
      for (const [px, pz] of [[box.x0, box.z0], [box.x1, box.z0], [box.x0, box.z1], [box.x1, box.z1]]) {
        if (Math.abs(t.columnTop(px, pz) - h) > 2) ok = false;
      }
      if (!ok) continue;
      taken.push(box);
      const farm: Farm = { ...box, y: h, alongX, top: h + 2 };
      s.farms.push(farm);
      this.addPart(s, { ...box, top: h + 2 });
    }
    // lamp posts along paths
    for (let i = 0; i < s.paths.length; i += 11) {
      const [px, pz] = s.paths[i];
      const lx = px + 1;
      const lz = pz + 1;
      const box = { x0: lx, z0: lz, x1: lx, z1: lz, top: 0 };
      if (taken.some((b) => overlaps(b, box, 0))) continue;
      const y = t.columnTop(lx, lz) + 1;
      s.lamps.push({ x: lx, z: lz, y });
      this.addPart(s, { ...box, top: y + 3 });
    }
    // paths themselves
    for (const [px, pz] of s.paths) this.addPart(s, { x0: px, z0: pz, x1: px, z1: pz, top: t.columnTop(px, pz) + 1 });
    return s;
  }

  private planPyramid(x: number, z: number, top: number, rng: Rng, seed: number): Structure {
    const s = this.base(SType.PYRAMID, x, z, top + 1, palette(Biome.DESERT), seed);
    s.size = 9 + rng.int(3);
    s.height = s.size;
    this.addPart(s, { x0: x - s.size, z0: z - s.size, x1: x + s.size, z1: z + s.size, top: top + s.size + 1 });
    // corner towers on the front side
    for (const sx of [-1, 1]) {
      const tx = x + sx * s.size;
      this.addPart(s, { x0: tx - 2, z0: z - s.size - 2, x1: tx + 2, z1: z - s.size + 2, top: top + 1 + s.size + 3 });
    }
    return s;
  }

  private planTower(x: number, z: number, top: number, rng: Rng, seed: number): Structure {
    const s = this.base(SType.TOWER, x, z, top + 1, palette(Biome.PLAINS), seed);
    s.size = 3;
    s.height = 13 + rng.int(9);
    this.addPart(s, { x0: x - 4, z0: z - 4, x1: x + 4, z1: z + 4, top: top + 1 + s.height + 2 });
    return s;
  }

  // ------------------------------------------------------------------ building

  build(s: Structure, w: Writer): void {
    switch (s.type) {
      case SType.VILLAGE:
        this.buildVillage(s, w);
        break;
      case SType.PYRAMID:
        this.buildPyramid(s, w);
        break;
      case SType.TOWER:
        this.buildTower(s, w);
        break;
    }
  }

  /** fill from the ground up to y0-1 with `id`, and clear plants on the way */
  private foundation(w: Writer, x: number, z: number, y0: number, id: number): void {
    const g = this.terrain.columnTop(x, z);
    for (let y = Math.max(1, g + 1); y < y0; y++) w.set(x, y, z, id);
  }

  private buildVillage(s: Structure, w: Writer): void {
    const t = this.terrain;
    const pal = s.pal;
    const desert = pal.flatRoof;
    // paths
    const pathId = desert ? B.DIRT_PATH : B.DIRT_PATH;
    for (const [px, pz] of s.paths) {
      const g = t.columnTop(px, pz);
      const cur = w.get(px, g, pz);
      if (cur === B.WATER) w.set(px, g, pz, B.OAK_PLANKS);
      else w.set(px, g, pz, pathId);
      for (let y = g + 1; y <= g + 3; y++) if (isPlant(w.get(px, y, pz))) w.set(px, y, pz, B.AIR);
    }
    // well
    const wy = s.y;
    for (let dz = -2; dz <= 1; dz++) {
      for (let dx = -2; dx <= 1; dx++) {
        const x = s.x + dx;
        const z = s.z + dz;
        this.foundation(w, x, z, wy - 1, pal.base);
        const inner = dx >= -1 && dx <= 0 && dz >= -1 && dz <= 0;
        w.set(x, wy - 1, z, inner ? B.WATER : pal.base);
        w.set(x, wy, z, inner ? B.AIR : pal.base);
        const corner = (dx === -2 || dx === 1) && (dz === -2 || dz === 1);
        for (let y = wy + 1; y <= wy + 3; y++) w.set(x, y, z, corner ? pal.frame : B.AIR);
        w.set(x, wy + 4, z, desert ? B.SANDSTONE : pal.roof === B.SNOW ? B.SPRUCE_PLANKS : pal.roof);
      }
    }
    w.set(s.x - 1, wy + 3, s.z - 1, B.LANTERN);
    // houses
    for (const h of s.houses) this.buildHouse(h, pal, w);
    // farms
    for (const f of s.farms) {
      for (let z = f.z0; z <= f.z1; z++) {
        for (let x = f.x0; x <= f.x1; x++) {
          const edge = x === f.x0 || x === f.x1 || z === f.z0 || z === f.z1;
          const mid = f.alongX ? z === ((f.z0 + f.z1) >> 1) : x === ((f.x0 + f.x1) >> 1);
          this.foundation(w, x, z, f.y, B.DIRT);
          for (let y = f.y + 1; y <= f.y + 4; y++) if (w.get(x, y, z) !== B.AIR && y > f.y) w.set(x, y, z, B.AIR);
          if (edge) {
            w.set(x, f.y, z, pal.frame === B.T_YELLOW ? B.SANDSTONE : pal.frame);
          } else if (mid) {
            w.set(x, f.y, z, B.WATER);
          } else {
            w.set(x, f.y, z, B.FARMLAND);
            w.set(x, f.y + 1, z, B.WHEAT);
          }
        }
      }
    }
    // lamps
    for (const l of s.lamps) {
      this.foundation(w, l.x, l.z, l.y, pal.base);
      w.set(l.x, l.y, l.z, pal.frame === B.T_YELLOW ? B.SANDSTONE : pal.frame);
      w.set(l.x, l.y + 1, l.z, pal.frame === B.T_YELLOW ? B.SANDSTONE : pal.frame);
      w.set(l.x, l.y + 2, l.z, B.LANTERN);
    }
  }

  private buildHouse(h: House, pal: Palette, w: Writer): void {
    const { x0, z0, x1, z1, y } = h;
    const top = y + h.h - 1; // last wall row
    const cxm = (x0 + x1) >> 1;
    const czm = (z0 + z1) >> 1;
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        this.foundation(w, x, z, y - 1, pal.base);
        w.set(x, y - 1, z, (x === x0 || x === x1 || z === z0 || z === z1) ? pal.base : pal.floor);
        const edgeX = x === x0 || x === x1;
        const edgeZ = z === z0 || z === z1;
        for (let yy = y; yy <= top; yy++) {
          let id: number = B.AIR;
          if (edgeX && edgeZ) id = pal.frame;
          else if (edgeX || edgeZ) {
            id = pal.wall;
            // windows in the middle of each wall, 2nd row
            if (yy === y + 1 && ((edgeX && Math.abs(z - czm) <= 0) || (edgeZ && Math.abs(x - cxm) <= 0))) id = B.GLASS;
          }
          w.set(x, yy, z, id);
        }
        // clear anything above the walls up to the roof (bumps of terrain / grass)
        for (let yy = top + 1; yy <= top + 8; yy++) {
          const cur = w.get(x, yy, z);
          if (cur !== B.AIR && !isRoofish(cur)) w.set(x, yy, z, B.AIR);
        }
      }
    }
    // door: 2-high opening, plus a step and a lantern beside it
    let dx = cxm;
    let dz = czm;
    let ox = 0;
    let oz = 0;
    if (h.door === 0) { dx = x1; ox = 1; }
    else if (h.door === 1) { dx = x0; ox = -1; }
    else if (h.door === 2) { dz = z1; oz = 1; }
    else { dz = z0; oz = -1; }
    w.set(dx, y, dz, B.AIR);
    w.set(dx, y + 1, dz, B.AIR);
    w.set(dx + ox, y - 1, dz + oz, pal.base);
    for (let yy = y; yy <= y + 2; yy++) if (isPlant(w.get(dx + ox, yy, dz + oz)) || isSolidTerrain(w.get(dx + ox, yy, dz + oz))) w.set(dx + ox, yy, dz + oz, B.AIR);
    if (h.decor !== 3) {
      // lantern hanging next to the door, outside
      const lx = dx + ox + (oz !== 0 ? 1 : 0);
      const lz = dz + oz + (ox !== 0 ? 1 : 0);
      w.set(lx, y + 2, lz, B.LANTERN);
    }
    // interior: a lamp in the ceiling and a little furniture
    w.set(cxm, top, czm, B.GLOW_LAMP);
    if (h.decor === 0) w.set(x0 + 1, y, z0 + 1, B.BOOKSHELF);
    if (h.decor === 1) w.set(x1 - 1, y, z1 - 1, B.HAY);
    if (h.decor === 2) w.set(x0 + 1, y, z1 - 1, B.PUMPKIN);

    // roof
    if (pal.flatRoof) {
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) w.set(x, top + 1, z, pal.roof);
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        if (x === x0 || x === x1 || z === z0 || z === z1) w.set(x, top + 2, z, (x + z) % 2 === 0 ? pal.frame : pal.roof);
      }
      return;
    }
    // gable along the longer side, one-block overhang
    const alongX = x1 - x0 >= z1 - z0;
    const half = alongX ? (z1 - z0 + 2) / 2 : (x1 - x0 + 2) / 2;
    for (let i = 0; i <= Math.ceil(half); i++) {
      const yy = top + 1 + i;
      if (alongX) {
        const a = z0 - 1 + i;
        const b = z1 + 1 - i;
        if (a > b) break;
        for (let x = x0 - 1; x <= x1 + 1; x++) {
          w.set(x, yy, a, pal.roof);
          w.set(x, yy, b, pal.roof);
        }
        // gable ends
        for (let z = a + 1; z <= b - 1; z++) {
          w.set(x0, yy, z, pal.wall);
          w.set(x1, yy, z, pal.wall);
        }
      } else {
        const a = x0 - 1 + i;
        const b = x1 + 1 - i;
        if (a > b) break;
        for (let z = z0 - 1; z <= z1 + 1; z++) {
          w.set(a, yy, z, pal.roof);
          w.set(b, yy, z, pal.roof);
        }
        for (let x = a + 1; x <= b - 1; x++) {
          w.set(x, yy, z0, pal.wall);
          w.set(x, yy, z1, pal.wall);
        }
      }
    }
  }

  private buildPyramid(s: Structure, w: Writer): void {
    const n = s.size;
    const y0 = s.y;
    for (let dz = -n - 2; dz <= n + 2; dz++) {
      for (let dx = -n - 2; dx <= n + 2; dx++) {
        const x = s.x + dx;
        const z = s.z + dz;
        const r = Math.max(Math.abs(dx), Math.abs(dz));
        if (r <= n) {
          this.foundation(w, x, z, y0, B.SANDSTONE);
          const h = n - r; // layers above y0
          for (let y = y0; y <= y0 + h; y++) {
            const band = (y - y0) % 4 === 2;
            w.set(x, y, z, band ? (r % 2 === 0 ? B.T_ORANGE : B.T_YELLOW) : B.SANDSTONE);
          }
          for (let y = y0 + h + 1; y <= y0 + h + 4; y++) if (w.get(x, y, z) !== B.AIR && !isRoofish(w.get(x, y, z))) w.set(x, y, z, B.AIR);
        }
      }
    }
    // entrance towers on the -z side
    for (const sx of [-1, 1]) {
      const tx = s.x + sx * n;
      const tz = s.z - n;
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const x = tx + dx;
          const z = tz + dz;
          this.foundation(w, x, z, y0, B.SANDSTONE);
          const edge = Math.abs(dx) === 2 || Math.abs(dz) === 2;
          for (let y = y0; y <= y0 + n + 2; y++) {
            const band = (y - y0) % 5 === 3;
            w.set(x, y, z, edge ? (band ? B.T_ORANGE : B.SANDSTONE) : B.SANDSTONE);
          }
          if (edge && (dx + dz) % 2 === 0) w.set(x, y0 + n + 3, z, B.SANDSTONE);
        }
      }
      w.set(tx, y0 + n + 3, tz, B.LANTERN);
    }
    // doorway
    for (let y = y0; y <= y0 + 2; y++) for (let dx = -1; dx <= 1; dx++) w.set(s.x + dx, y, s.z - n, B.AIR);
    w.set(s.x, y0 + 3, s.z - n, B.T_ORANGE);
  }

  private buildTower(s: Structure, w: Writer): void {
    const rng = new Rng(s.seed ^ 0x70e2);
    const y0 = s.y;
    const H = s.height;
    for (let dz = -4; dz <= 4; dz++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.hypot(dx, dz);
        if (d > 3.6) continue;
        const x = s.x + dx;
        const z = s.z + dz;
        this.foundation(w, x, z, y0, B.STONE_BRICKS);
        const wall = d > 2.4;
        // ruined top: wall height varies around the rim
        const ang = Math.atan2(dz, dx);
        const ruin = Math.floor(2.5 + 2.5 * Math.sin(ang * 2 + (s.seed % 7)) + 1.5 * Math.sin(ang * 5 + (s.seed % 3)));
        const hh = wall ? H - Math.max(0, ruin) : 0;
        for (let y = y0; y < y0 + Math.max(hh, 1); y++) {
          if (!wall && y > y0) {
            w.set(x, y, z, B.AIR);
            continue;
          }
          const mossy = rng.chance(0.18 + 0.4 * Math.max(0, 1 - (y - y0) / 6));
          let id: number = mossy ? B.MOSSY_STONE_BRICKS : B.STONE_BRICKS;
          if (!wall) id = B.COBBLESTONE;
          // windows
          if (wall && (y - y0) % 6 === 3 && (Math.abs(dx) <= 0 || Math.abs(dz) <= 0)) id = B.AIR;
          w.set(x, y, z, id);
        }
        if (!wall) for (let y = y0 + 1; y < y0 + H + 2; y++) w.set(x, y, z, B.AIR);
        // floor for the lookout
        if (!wall && (y0 + H - 4) > y0) w.set(x, y0 + H - 4, z, B.SPRUCE_PLANKS);
      }
    }
    // door
    for (let y = y0; y <= y0 + 1; y++) w.set(s.x, y, s.z - 3, B.AIR);
    w.set(s.x, y0 + H - 3, s.z, B.LANTERN);
  }
}

function isPlant(id: number): boolean {
  return (id >= B.SHORT_GRASS && id <= B.LILY_PAD) || id === B.RED_MUSHROOM || id === B.BROWN_MUSHROOM || id === B.SNOW_LAYER;
}

function isSolidTerrain(id: number): boolean {
  return id === B.STONE || id === B.DIRT || id === B.GRASS || id === B.SAND || id === B.SANDSTONE || id === B.GRAVEL ||
    id === B.GRASS_SNOWY || id === B.SNOW || id === B.COARSE_DIRT || id === B.PODZOL || id === B.RED_SAND ||
    (id >= B.TERRACOTTA && id <= B.T_LGRAY) || id === B.CLAY || id === B.MOSS || (id >= B.COAL_ORE && id <= B.GEM_ORE);
}

function isRoofish(id: number): boolean {
  return id === B.LANTERN;
}

import { B } from '../blocks';
import { Biome } from '../climate';
import { CHUNK, SEA } from '../constants';
import { Rng, hash32 } from '../rng';
import type { Surface } from '../surface';
import type { Structures } from '../structures';
import type { Terrain } from '../terrain';
import { Placement, Tree } from './trees';

// Where trees / large features go. A pure function of (seed, origin chunk), so every chunk that
// a tree overlaps reconstructs the same placement list.

interface TreeConf {
  density: number; // expected trees per chunk
  types: [number, number][]; // [type, weight]
}

const NONE: TreeConf = { density: 0, types: [] };

const CONF: Partial<Record<number, TreeConf>> = {
  [Biome.PLAINS]: { density: 0.18, types: [[Tree.OAK, 8], [Tree.FANCY_OAK, 2]] },
  [Biome.SUNFLOWER_PLAINS]: { density: 0.12, types: [[Tree.OAK, 8], [Tree.BIRCH, 2]] },
  [Biome.FOREST]: { density: 9, types: [[Tree.OAK, 66], [Tree.BIRCH, 26], [Tree.FANCY_OAK, 8]] },
  [Biome.FLOWER_FOREST]: { density: 4, types: [[Tree.OAK, 6], [Tree.BIRCH, 3], [Tree.FANCY_OAK, 1]] },
  [Biome.BIRCH_FOREST]: { density: 9, types: [[Tree.BIRCH, 7], [Tree.TALL_BIRCH, 3]] },
  [Biome.DARK_FOREST]: { density: 13, types: [[Tree.DARK_OAK, 62], [Tree.OAK, 14], [Tree.BIRCH, 10], [Tree.RED_MUSHROOM, 3], [Tree.BROWN_MUSHROOM, 3], [Tree.FANCY_OAK, 8]] },
  [Biome.TAIGA]: { density: 8, types: [[Tree.SPRUCE, 9], [Tree.PINE, 1]] },
  [Biome.SNOWY_TAIGA]: { density: 6, types: [[Tree.SPRUCE, 1]] },
  [Biome.GIANT_TAIGA]: { density: 8, types: [[Tree.PINE, 45], [Tree.SPRUCE, 47], [Tree.BOULDER, 8]] },
  [Biome.SNOWY_PLAINS]: { density: 0.12, types: [[Tree.SPRUCE, 1]] },
  [Biome.ICE_SPIKES]: { density: 1.2, types: [[Tree.ICE_SPIKE, 1]] },
  [Biome.SAVANNA]: { density: 1.3, types: [[Tree.ACACIA, 8], [Tree.OAK, 2]] },
  [Biome.SAVANNA_PLATEAU]: { density: 1.6, types: [[Tree.ACACIA, 8], [Tree.OAK, 2]] },
  [Biome.JUNGLE]: { density: 20, types: [[Tree.MEGA_JUNGLE, 13], [Tree.JUNGLE, 37], [Tree.JUNGLE_BUSH, 40], [Tree.FANCY_OAK, 10]] },
  [Biome.SPARSE_JUNGLE]: { density: 3, types: [[Tree.JUNGLE, 6], [Tree.JUNGLE_BUSH, 4]] },
  [Biome.SWAMP]: { density: 2, types: [[Tree.SWAMP_OAK, 1]] },
  [Biome.MUSHROOM_FIELDS]: { density: 0.7, types: [[Tree.RED_MUSHROOM, 1], [Tree.BROWN_MUSHROOM, 1]] },
  [Biome.MEADOW]: { density: 0.1, types: [[Tree.OAK, 1], [Tree.BIRCH, 2], [Tree.FANCY_OAK, 1]] },
  [Biome.CHERRY_GROVE]: { density: 2.6, types: [[Tree.CHERRY, 1]] },
  [Biome.GROVE]: { density: 7, types: [[Tree.SPRUCE, 1]] },
  [Biome.WOODED_BADLANDS]: { density: 3, types: [[Tree.OAK, 1]] },
  [Biome.WINDSWEPT_HILLS]: { density: 0.9, types: [[Tree.SPRUCE, 2], [Tree.OAK, 1]] },
};

export const ATTEMPTS = 32;

export function treeConf(biome: number): TreeConf {
  return CONF[biome] ?? NONE;
}

function pick(types: [number, number][], r: number): number {
  let total = 0;
  for (const [, w] of types) total += w;
  let acc = 0;
  const target = r * total;
  for (const [t, w] of types) {
    acc += w;
    if (target < acc) return t;
  }
  return types[types.length - 1][0];
}

const GROUND_OK = new Set<number>([B.GRASS, B.DIRT, B.PODZOL, B.COARSE_DIRT, B.GRASS_SNOWY, B.MYCELIUM, B.SNOW, B.MOSS]);

export class PlacementCache {
  private readonly map = new Map<number, Placement[]>();
  constructor(
    private readonly seed: number,
    private readonly terrain: Terrain,
    private readonly surface: Surface,
    private readonly structures: Structures | null = null,
  ) {}

  get(ocx: number, ocz: number): Placement[] {
    const k = (ocx + 1048576) * 2097152 + (ocz + 1048576);
    let v = this.map.get(k);
    if (v) return v;
    if (this.map.size > 600) {
      let n = 150;
      for (const kk of this.map.keys()) {
        this.map.delete(kk);
        if (--n <= 0) break;
      }
    }
    v = this.compute(ocx, ocz);
    this.map.set(k, v);
    return v;
  }

  private compute(ocx: number, ocz: number): Placement[] {
    const out: Placement[] = [];
    const rng = new Rng(hash32(this.seed, ocx, ocz, 0x7ee5));
    const t = this.terrain;
    for (let i = 0; i < ATTEMPTS; i++) {
      const lx = rng.int(CHUNK);
      const lz = rng.int(CHUNK);
      const roll = rng.next();
      const typeRoll = rng.next();
      const seed = rng.nextU32();
      const x = ocx * CHUNK + lx;
      const z = ocz * CHUNK + lz;
      const biome = t.biomeAt(x, z);
      const conf = treeConf(biome);
      if (conf.density <= 0 || roll >= conf.density / ATTEMPTS) continue;
      if (this.structures && this.structures.blocksTree(x, z)) continue;
      const type = pick(conf.types, typeRoll);
      const top = t.columnTop(x, z);
      if (top < SEA) continue;
      const slope = t.slopeAt(x, z);
      if (slope > (type === Tree.ICE_SPIKE ? 1.6 : 1.15)) continue;
      const corner = t.cornerAt(x, z);
      const ground = this.surface.topBlock(biome, top, slope, x, z, corner.t);
      if (!GROUND_OK.has(ground)) continue;
      if (t.carved(x, top, z)) continue;
      // 2x2 trees need flat-ish ground under all four trunks
      if (type === Tree.PINE || type === Tree.DARK_OAK || type === Tree.MEGA_JUNGLE) {
        if (t.columnTop(x + 1, z) < top - 1 || t.columnTop(x, z + 1) < top - 1 || t.columnTop(x + 1, z + 1) < top - 1) continue;
      }
      out.push({ type, x, y: top + 1, z, seed });
    }
    return out;
  }
}

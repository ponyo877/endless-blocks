import { B, OPAQUE, REPLACEABLE, isLeaves } from './blocks';
import { BIOMES, Biome } from './climate';
import { CHUNK, CHUNK_VOLUME, CORNERS_Y, HEIGHT, SEA, idx } from './constants';
import { PlacementCache } from './features/placement';
import { Structures } from './structures';
import { MAX_TREE_RADIUS, Writer, buildTree, extent } from './features/trees';
import { Rng, hash32, hashFloat } from './rng';
import { Surface, isFrozen } from './surface';
import { Terrain, valueAt } from './terrain';

export interface GenContext {
  seed: number;
  terrain: Terrain;
  surface: Surface;
  structures: Structures;
  placements: PlacementCache;
}

export function createContext(seed: number): GenContext {
  const terrain = new Terrain(seed);
  const surface = new Surface(seed);
  const structures = new Structures(seed, terrain);
  return { seed, terrain, surface, structures, placements: new PlacementCache(seed, terrain, surface, structures) };
}

export interface ChunkData {
  cx: number;
  cz: number;
  blocks: Uint8Array;
  /** highest non-air y per column (x + z*16), -1 = none */
  heights: Int16Array;
  /** block id at heights[] */
  topIds: Uint8Array;
  /** biome per column */
  biomes: Uint8Array;
}

const blend = new Float32Array(CORNERS_Y);
const blendCave = new Float32Array(CORNERS_Y);

export function generateChunk(ctx: GenContext, cx: number, cz: number): ChunkData {
  const { terrain, surface, seed } = ctx;
  const blocks = new Uint8Array(CHUNK_VOLUME);
  const terrainTop = new Int16Array(256);
  const biomes = new Uint8Array(256);
  const ox = cx * CHUNK;
  const oz = cz * CHUNK;

  // ---- 1. density fill + caves
  for (let z = 0; z < CHUNK; z++) {
    for (let x = 0; x < CHUNK; x++) {
      const wx = ox + x;
      const wz = oz + z;
      terrain.blendColumn(wx, wz, blend, blendCave);
      let top = -1;
      const col = (z << 4) | x;
      for (let y = HEIGHT - 1; y >= 0; y--) {
        const d = valueAt(blend, y);
        let id: number;
        if (d > 0) {
          if (top < 0) top = y;
          if (valueAt(blendCave, y) < 0) id = y < 9 ? B.LAVA : B.AIR;
          else id = B.STONE;
        } else {
          id = y < SEA ? B.WATER : B.AIR;
        }
        if (id !== B.AIR) blocks[(y << 8) | col] = id;
      }
      terrainTop[col] = top;
      biomes[col] = terrain.biomeAt(wx, wz);
      // bedrock floor
      blocks[col] = B.BEDROCK;
      const hb = hash32(wx, wz, seed, 3);
      for (let y = 1; y < 4; y++) if ((hb >>> (y * 3)) % 4 === 0) blocks[(y << 8) | col] = B.BEDROCK;
    }
  }

  // ---- 2. surface rules
  for (let z = 0; z < CHUNK; z++) {
    for (let x = 0; x < CHUNK; x++) {
      const col = (z << 4) | x;
      const top = terrainTop[col];
      if (top < 1) continue;
      const wx = ox + x;
      const wz = oz + z;
      const biome = biomes[col];
      const badlands = biome === Biome.BADLANDS || biome === Biome.WOODED_BADLANDS;
      if (top >= SEA - 1) {
        const slope = terrain.slopeAt(wx, wz);
        const corner = terrain.cornerAt(wx, wz);
        const topId = surface.topBlock(biome, top, slope, wx, wz, corner.t);
        let fill = surface.filler(topId, biome);
        const depth = topId === B.SAND || topId === B.RED_SAND ? surface.fillerDepth(wx, wz) + 1 : surface.fillerDepth(wx, wz);
        for (let d = 0; d <= depth + (topId === B.SAND ? 4 : 0); d++) {
          const y = top - d;
          if (y < 1) break;
          const i = (y << 8) | col;
          if (blocks[i] !== B.STONE) continue;
          if (d === 0) blocks[i] = topId;
          else if (d <= depth) {
            if (fill === -1) blocks[i] = surface.band(wx, y, wz);
            else if (fill !== B.STONE) blocks[i] = fill;
          } else if (topId === B.SAND) blocks[i] = B.SANDSTONE;
        }
        if (badlands) {
          for (let y = top - 1; y > SEA - 8; y--) {
            const i = (y << 8) | col;
            if (blocks[i] === B.STONE) blocks[i] = surface.band(wx, y, wz);
          }
        }
      } else {
        // underwater floor
        const floor = surface.floorBlock(biome, top, wx, wz);
        const depth = 3;
        for (let d = 0; d <= depth; d++) {
          const y = top - d;
          if (y < 1) break;
          const i = (y << 8) | col;
          if (blocks[i] === B.STONE) blocks[i] = floor === B.CLAY && d > 1 ? B.STONE : floor;
        }
      }
    }
  }

  // ---- 3. ores
  placeOres(blocks, seed, cx, cz);

  // ---- 4. trees & large features from the 3x3 neighbourhood (global raster order)
  const writer: Writer = {
    get(x, y, z) {
      const lx = x - ox;
      const lz = z - oz;
      if (lx < 0 || lx >= CHUNK || lz < 0 || lz >= CHUNK || y < 0 || y >= HEIGHT) return B.AIR;
      return blocks[idx(lx, y, lz)];
    },
    set(x, y, z, id) {
      const lx = x - ox;
      const lz = z - oz;
      if (lx < 0 || lx >= CHUNK || lz < 0 || lz >= CHUNK || y < 0 || y >= HEIGHT) return;
      blocks[idx(lx, y, lz)] = id;
    },
  };
  for (let ncz = cz - 1; ncz <= cz + 1; ncz++) {
    for (let ncx = cx - 1; ncx <= cx + 1; ncx++) {
      const list = ctx.placements.get(ncx, ncz);
      for (const p of list) {
        if (p.x + MAX_TREE_RADIUS < ox || p.x - MAX_TREE_RADIUS >= ox + CHUNK) continue;
        if (p.z + MAX_TREE_RADIUS < oz || p.z - MAX_TREE_RADIUS >= oz + CHUNK) continue;
        const e = extent(p);
        if (p.x + e.radius + 1 < ox || p.x - e.radius - 1 >= ox + CHUNK) continue;
        if (p.z + e.radius + 1 < oz || p.z - e.radius - 1 >= oz + CHUNK) continue;
        buildTree(p, writer);
      }
    }
  }

  // ---- 5. small vegetation, snow, ice
  decorate(ctx, blocks, terrainTop, biomes, cx, cz);

  // ---- 5b. villages, pyramids, towers
  for (const st of ctx.structures.near(ox - 1, oz - 1, ox + CHUNK, oz + CHUNK, [])) ctx.structures.build(st, writer);

  // ---- 6. column summary
  const heights = new Int16Array(256);
  const topIds = new Uint8Array(256);
  for (let col = 0; col < 256; col++) {
    let y = HEIGHT - 1;
    while (y >= 0 && blocks[(y << 8) | col] === B.AIR) y--;
    heights[col] = y;
    topIds[col] = y >= 0 ? blocks[(y << 8) | col] : 0;
  }
  return { cx, cz, blocks, heights, topIds, biomes };
}

// ------------------------------------------------------------------ ores

interface OreConf {
  id: number;
  veins: number;
  size: number;
  minY: number;
  maxY: number;
}
const ORES: OreConf[] = [
  { id: B.COAL_ORE, veins: 18, size: 10, minY: 6, maxY: 200 },
  { id: B.IRON_ORE, veins: 10, size: 7, minY: 5, maxY: 130 },
  { id: B.COPPER_ORE, veins: 7, size: 9, minY: 20, maxY: 110 },
  { id: B.GOLD_ORE, veins: 3, size: 6, minY: 4, maxY: 40 },
  { id: B.GEM_ORE, veins: 1, size: 5, minY: 3, maxY: 18 },
];

function placeOres(blocks: Uint8Array, seed: number, cx: number, cz: number): void {
  const rng = new Rng(hash32(seed, cx, cz, 0x0e5));
  for (const o of ORES) {
    for (let v = 0; v < o.veins; v++) {
      let x = rng.int(CHUNK);
      let y = rng.irange(o.minY, o.maxY);
      let z = rng.int(CHUNK);
      const n = rng.irange(Math.ceil(o.size / 2), o.size);
      for (let k = 0; k < n; k++) {
        if (x >= 0 && x < CHUNK && z >= 0 && z < CHUNK && y > 0 && y < HEIGHT) {
          const i = idx(x, y, z);
          if (blocks[i] === B.STONE) blocks[i] = o.id;
        }
        const r = rng.int(6);
        if (r === 0) x++;
        else if (r === 1) x--;
        else if (r === 2) y++;
        else if (r === 3) y--;
        else if (r === 4) z++;
        else z--;
      }
    }
  }
}

// ------------------------------------------------------------------ vegetation

interface VegConf {
  grass: number;
  tall: number;
  fern: number;
  flowers: number;
  palette: number[];
  tallFlower?: number;
  deadBush?: number;
  cactus?: number;
  mushroom?: number;
  pumpkin?: number;
}

const P_PLAINS = [B.DANDELION, B.POPPY, B.DANDELION, B.OXEYE, B.CORNFLOWER, B.POPPY];
const P_FLOWER = [B.DANDELION, B.POPPY, B.ALLIUM, B.OXEYE, B.CORNFLOWER, B.ORANGE_TULIP, B.PINK_TULIP];
const P_FOREST = [B.DANDELION, B.POPPY];
const P_MEADOW = [B.CORNFLOWER, B.ALLIUM, B.OXEYE, B.DANDELION, B.POPPY];
const P_CHERRY = [B.PINK_TULIP, B.ALLIUM, B.PINK_TULIP];

const VEG: Partial<Record<number, VegConf>> = {
  [Biome.PLAINS]: { grass: 0.32, tall: 0.07, fern: 0, flowers: 0.025, palette: P_PLAINS, pumpkin: 0.0006 },
  [Biome.SUNFLOWER_PLAINS]: { grass: 0.28, tall: 0.05, fern: 0, flowers: 0.12, palette: P_FLOWER, tallFlower: 0.02 },
  [Biome.FOREST]: { grass: 0.22, tall: 0.03, fern: 0.02, flowers: 0.015, palette: P_FOREST, tallFlower: 0.004 },
  [Biome.FLOWER_FOREST]: { grass: 0.15, tall: 0.02, fern: 0, flowers: 0.3, palette: P_FLOWER, tallFlower: 0.03 },
  [Biome.BIRCH_FOREST]: { grass: 0.22, tall: 0.03, fern: 0.01, flowers: 0.015, palette: P_FOREST },
  [Biome.DARK_FOREST]: { grass: 0.14, tall: 0.03, fern: 0.03, flowers: 0.005, palette: P_FOREST, mushroom: 0.02 },
  [Biome.TAIGA]: { grass: 0.14, tall: 0.03, fern: 0.25, flowers: 0, palette: [] , mushroom: 0.004},
  [Biome.SNOWY_TAIGA]: { grass: 0.02, tall: 0, fern: 0.08, flowers: 0, palette: [] },
  [Biome.GIANT_TAIGA]: { grass: 0.12, tall: 0.05, fern: 0.3, flowers: 0, palette: [], mushroom: 0.01, deadBush: 0.003 },
  [Biome.SAVANNA]: { grass: 0.42, tall: 0.16, fern: 0, flowers: 0.004, palette: P_PLAINS },
  [Biome.SAVANNA_PLATEAU]: { grass: 0.4, tall: 0.14, fern: 0, flowers: 0.004, palette: P_PLAINS },
  [Biome.JUNGLE]: { grass: 0.38, tall: 0.1, fern: 0.16, flowers: 0.004, palette: P_FOREST },
  [Biome.SPARSE_JUNGLE]: { grass: 0.35, tall: 0.08, fern: 0.12, flowers: 0.006, palette: P_FOREST },
  [Biome.SWAMP]: { grass: 0.22, tall: 0.02, fern: 0.02, flowers: 0.006, palette: [B.ALLIUM], mushroom: 0.01 },
  [Biome.MEADOW]: { grass: 0.5, tall: 0.2, fern: 0, flowers: 0.08, palette: P_MEADOW },
  [Biome.CHERRY_GROVE]: { grass: 0.36, tall: 0.04, fern: 0, flowers: 0.07, palette: P_CHERRY },
  [Biome.WINDSWEPT_HILLS]: { grass: 0.16, tall: 0.02, fern: 0, flowers: 0.005, palette: P_PLAINS },
  [Biome.WOODED_BADLANDS]: { grass: 0.2, tall: 0.02, fern: 0, flowers: 0, palette: [], deadBush: 0.02 },
  [Biome.BADLANDS]: { grass: 0, tall: 0, fern: 0, flowers: 0, palette: [], deadBush: 0.012, cactus: 0.003 },
  [Biome.DESERT]: { grass: 0, tall: 0, fern: 0, flowers: 0, palette: [], deadBush: 0.006, cactus: 0.006 },
  [Biome.MUSHROOM_FIELDS]: { grass: 0, tall: 0, fern: 0, flowers: 0, palette: [], mushroom: 0.012 },
  [Biome.BEACH]: { grass: 0.04, tall: 0, fern: 0, flowers: 0, palette: [] },
  [Biome.RIVER]: { grass: 0.15, tall: 0.02, fern: 0, flowers: 0.01, palette: P_PLAINS },
  [Biome.GROVE]: { grass: 0.01, tall: 0, fern: 0.04, flowers: 0, palette: [] },
};

function decorate(ctx: GenContext, blocks: Uint8Array, terrainTop: Int16Array, biomes: Uint8Array, cx: number, cz: number): void {
  const { seed, surface } = ctx;
  const ox = cx * CHUNK;
  const oz = cz * CHUNK;
  for (let z = 0; z < CHUNK; z++) {
    for (let x = 0; x < CHUNK; x++) {
      const col = (z << 4) | x;
      const wx = ox + x;
      const wz = oz + z;
      const biome = biomes[col];
      const info = BIOMES[biome];
      // highest non-air
      let y = HEIGHT - 1;
      while (y > 0 && blocks[(y << 8) | col] === B.AIR) y--;
      const topId = blocks[(y << 8) | col];
      const h1 = hashFloat(wx, wz, seed, 21);
      const h2 = hashFloat(wx, wz, seed, 22);
      const h3 = hashFloat(wx, wz, seed, 23);
      const above = (y + 1) << 8 | col;

      if (topId === B.WATER) {
        // water column: find floor
        let fy = y;
        while (fy > 0 && (blocks[(fy << 8) | col] === B.WATER)) fy--;
        const depth = y - fy;
        const floorId = blocks[(fy << 8) | col];
        const frozen = isFrozen(biome);
        if (y === SEA - 1 && frozen && (biome !== Biome.FROZEN_OCEAN || h3 > 0.12)) {
          blocks[(y << 8) | col] = B.ICE;
          continue;
        }
        if (y === SEA - 1 && biome === Biome.SWAMP && h1 < 0.05 && depth <= 3) {
          blocks[above] = B.LILY_PAD;
        }
        if (OPAQUE[floorId] && depth >= 2 && !frozen) {
          if (biome === Biome.WARM_OCEAN && h2 < 0.3) {
            const corals = [B.CORAL_TUBE, B.CORAL_BRAIN, B.CORAL_BUBBLE, B.CORAL_FIRE, B.CORAL_HORN];
            const c = corals[Math.floor(h3 * 5)];
            const hgt = 1 + Math.floor(h1 * Math.min(3, depth - 1));
            for (let k = 1; k <= hgt; k++) blocks[((fy + k) << 8) | col] = c;
          } else if ((info.ocean && biome !== Biome.WARM_OCEAN) && h2 < 0.06 && depth >= 4) {
            const hgt = 1 + Math.floor(h1 * (depth - 2));
            for (let k = 1; k <= hgt; k++) blocks[((fy + k) << 8) | col] = B.KELP;
          } else if (h2 < (info.ocean || info.river ? 0.3 : 0.1)) {
            blocks[((fy + 1) << 8) | col] = B.SEAGRASS;
          }
        }
        continue;
      }

      const veg = VEG[biome];
      if (veg && y + 2 < HEIGHT && blocks[above] === B.AIR && y >= SEA - 1) {
        if (topId === B.GRASS) {
          let r = h1;
          if (veg.pumpkin && r < veg.pumpkin) {
            blocks[above] = B.PUMPKIN;
          } else if ((r -= veg.pumpkin ?? 0) < veg.flowers && veg.palette.length) {
            blocks[above] = veg.palette[Math.floor(h2 * veg.palette.length)];
          } else if ((r -= veg.flowers) < (veg.tallFlower ?? 0)) {
            blocks[above] = B.LILAC;
            blocks[above + 256] = B.LILAC_TOP;
          } else if ((r -= veg.tallFlower ?? 0) < veg.tall) {
            blocks[above] = B.TALL_GRASS;
            blocks[above + 256] = B.TALL_GRASS_TOP;
          } else if ((r -= veg.tall) < veg.fern) {
            blocks[above] = B.FERN;
          } else if ((r -= veg.fern) < veg.grass) {
            blocks[above] = B.SHORT_GRASS;
          } else if ((r -= veg.grass) < (veg.mushroom ?? 0)) {
            blocks[above] = h2 < 0.5 ? B.RED_MUSHROOM : B.BROWN_MUSHROOM;
          }
          // sugar cane next to water (interior columns only)
          if (blocks[above] === B.AIR && y === SEA - 1 && x > 0 && x < 15 && z > 0 && z < 15 && h3 < 0.12) {
            const w = blocks[(y << 8) | col - 1] === B.WATER || blocks[(y << 8) | col + 1] === B.WATER ||
              blocks[(y << 8) | col - 16] === B.WATER || blocks[(y << 8) | col + 16] === B.WATER;
            if (w) {
              const hgt = 1 + Math.floor(h2 * 3);
              for (let k = 1; k <= hgt; k++) blocks[((y + k) << 8) | col] = B.SUGAR_CANE;
            }
          }
        } else if (topId === B.PODZOL || topId === B.COARSE_DIRT) {
          if (h1 < veg.fern) blocks[above] = B.FERN;
          else if (h1 < veg.fern + (veg.deadBush ?? 0)) blocks[above] = B.DEAD_BUSH;
          else if (h1 < veg.fern + (veg.deadBush ?? 0) + (veg.mushroom ?? 0)) blocks[above] = B.BROWN_MUSHROOM;
        } else if (topId === B.SAND || topId === B.RED_SAND || (topId >= B.TERRACOTTA && topId <= B.T_LGRAY)) {
          if (veg.cactus && h1 < veg.cactus && (topId === B.SAND || topId === B.RED_SAND) && x > 0 && x < 15 && z > 0 && z < 15) {
            // keep cacti apart: neighbours must be air
            const hgt = 1 + Math.floor(h2 * 3);
            for (let k = 1; k <= hgt; k++) blocks[((y + k) << 8) | col] = B.CACTUS;
          } else if (veg.deadBush && h1 < (veg.cactus ?? 0) + veg.deadBush) {
            blocks[above] = B.DEAD_BUSH;
          }
        } else if (topId === B.MYCELIUM) {
          if (veg.mushroom && h1 < veg.mushroom) blocks[above] = h2 < 0.5 ? B.RED_MUSHROOM : B.BROWN_MUSHROOM;
        }
      }

      // snow cover
      const corner = ctx.terrain.cornerAt(wx, wz);
      const snowy = info.precip === 'snow' || terrainTop[col] > surface.snowLine(corner.t, wx, wz);
      if (snowy) {
        let sy = HEIGHT - 2;
        while (sy > 0 && blocks[(sy << 8) | col] === B.AIR) sy--;
        const sid = blocks[(sy << 8) | col];
        if (REPLACEABLE[sid] && sid !== B.AIR && sid !== B.WATER && sid !== B.SNOW_LAYER && !isTallTop(sid)) {
          // replace low plant with snow layer
          blocks[(sy << 8) | col] = B.SNOW_LAYER;
        } else if ((OPAQUE[sid] || isLeaves(sid)) && sid !== B.ICE && sid !== B.PACKED_ICE && sid !== B.LAVA) {
          blocks[((sy + 1) << 8) | col] = B.SNOW_LAYER;
          if (sid === B.GRASS) blocks[(sy << 8) | col] = B.GRASS_SNOWY;
        }
      }
    }
  }
}

function isTallTop(id: number): boolean {
  return id === B.TALL_GRASS_TOP || id === B.LILAC_TOP;
}

import { B } from './blocks';
import { Biome } from './climate';
import { SEA } from './constants';
import { Octaves } from './noise';
import { Rng, hash32, hashFloat } from './rng';

// Surface rules: which blocks form the top layers of a column, per biome / height / slope.

export class Surface {
  readonly patch: Octaves;
  readonly patch2: Octaves;
  readonly snowN: Octaves;
  readonly bandOffset: Octaves;
  readonly bands: Uint8Array;
  readonly seed: number;

  constructor(seed: number) {
    this.seed = seed;
    this.patch = new Octaves(new Rng(hash32(seed, 301)), 1 / 24, [1, 0.5]);
    this.patch2 = new Octaves(new Rng(hash32(seed, 302)), 1 / 40, [1, 0.5]);
    this.snowN = new Octaves(new Rng(hash32(seed, 303)), 1 / 50, [1, 0.5]);
    this.bandOffset = new Octaves(new Rng(hash32(seed, 304)), 1 / 160, [1]);
    // badlands strata
    const rng = new Rng(hash32(seed, 305));
    const bands = new Uint8Array(96).fill(B.TERRACOTTA);
    const put = (id: number, count: number, minW: number, maxW: number) => {
      for (let i = 0; i < count; i++) {
        const at = rng.int(96);
        const w = rng.irange(minW, maxW);
        for (let k = 0; k < w; k++) bands[(at + k) % 96] = id;
      }
    };
    put(B.T_ORANGE, 14, 1, 3);
    put(B.T_YELLOW, 6, 1, 2);
    put(B.T_BROWN, 5, 1, 2);
    put(B.T_RED, 6, 1, 2);
    put(B.T_WHITE, 4, 1, 1);
    put(B.T_LGRAY, 4, 1, 2);
    this.bands = bands;
  }

  band(x: number, y: number, z: number): number {
    const off = Math.round(this.bandOffset.sample2(x, z) * 4);
    return this.bands[(((y + off) % 96) + 96) % 96];
  }

  snowLine(t: number, x: number, z: number): number {
    return 168 + (t - 0.4) * 60 + this.snowN.sample2(x, z) * 10;
  }

  /**
   * Top block for a land column (top >= SEA - 1). Shared by the chunk generator and feature
   * placement so that both agree on what the ground is.
   */
  topBlock(biome: number, top: number, slope: number, x: number, z: number, t: number): number {
    const p = this.patch.sample2(x, z);
    const snowLine = this.snowLine(t, x, z);
    const steep = slope > 1.25;
    const veryHigh = top > snowLine;
    switch (biome) {
      case Biome.DESERT:
        return B.SAND;
      case Biome.BEACH:
        return top <= SEA + 2 ? B.SAND : steep ? B.STONE : B.GRASS;
      case Biome.SNOWY_BEACH:
        return top <= SEA + 2 ? B.SAND : B.GRASS_SNOWY;
      case Biome.STONY_SHORE:
        return p > 0.25 ? B.GRAVEL : B.STONE;
      case Biome.BADLANDS:
        return top < 74 + p * 6 ? B.RED_SAND : this.band(x, top, z);
      case Biome.WOODED_BADLANDS:
        if (top > 92 && !steep) return p > 0.2 ? B.COARSE_DIRT : B.GRASS;
        return top < 74 + p * 6 ? B.RED_SAND : this.band(x, top, z);
      case Biome.MUSHROOM_FIELDS:
        return B.MYCELIUM;
      case Biome.GIANT_TAIGA:
        return p > 0.32 ? B.PODZOL : p < -0.35 ? B.COARSE_DIRT : B.GRASS;
      case Biome.SAVANNA:
      case Biome.SAVANNA_PLATEAU:
        return steep ? B.STONE : p > 0.38 ? B.COARSE_DIRT : B.GRASS;
      case Biome.STONY_PEAKS:
        return p > 0.3 ? B.GRAVEL : B.STONE;
      case Biome.FROZEN_PEAKS:
        if (steep && slope > 1.8) return p > 0 ? B.PACKED_ICE : B.STONE;
        return p > 0.35 ? B.PACKED_ICE : B.SNOW;
      case Biome.JAGGED_PEAKS:
        return steep ? B.STONE : B.SNOW;
      case Biome.SNOWY_SLOPES:
        return steep && slope > 1.6 ? B.STONE : B.SNOW;
      case Biome.GROVE:
        return veryHigh ? B.SNOW : B.GRASS_SNOWY;
      case Biome.WINDSWEPT_HILLS:
        if (steep) return p > 0.1 ? B.GRAVEL : B.STONE;
        return veryHigh ? B.SNOW : B.GRASS;
      case Biome.SNOWY_PLAINS:
      case Biome.ICE_SPIKES:
      case Biome.SNOWY_TAIGA:
        return steep && slope > 1.8 ? B.STONE : B.GRASS_SNOWY;
      default:
        if (veryHigh) return steep ? B.STONE : B.SNOW;
        if (steep && (slope > 1.9 || top > 110)) return B.STONE;
        return B.GRASS;
    }
  }

  /** filler block below the top for a given top block */
  filler(topId: number, biome: number): number {
    switch (topId) {
      case B.SAND:
        return B.SAND;
      case B.RED_SAND:
        return B.RED_SAND;
      case B.GRAVEL:
      case B.STONE:
        return B.STONE;
      case B.SNOW:
        return biome === Biome.FROZEN_PEAKS || biome === Biome.JAGGED_PEAKS || biome === Biome.SNOWY_SLOPES ? B.SNOW : B.DIRT;
      case B.PACKED_ICE:
        return B.PACKED_ICE;
      default:
        if (topId >= B.TERRACOTTA && topId <= B.T_LGRAY) return -1; // bands continue
        return B.DIRT;
    }
  }

  /** underwater floor block */
  floorBlock(biome: number, top: number, x: number, z: number): number {
    const p = this.patch2.sample2(x, z);
    switch (biome) {
      case Biome.FROZEN_OCEAN:
      case Biome.COLD_OCEAN:
        return top < 48 || p > 0.2 ? B.GRAVEL : B.SAND;
      case Biome.OCEAN:
        return top < 44 && p > -0.1 ? B.GRAVEL : B.SAND;
      case Biome.WARM_OCEAN:
      case Biome.LUKEWARM_OCEAN:
      case Biome.BEACH:
      case Biome.DESERT:
        return B.SAND;
      case Biome.RIVER:
      case Biome.FROZEN_RIVER:
        return p > 0.3 ? B.CLAY : p < -0.25 ? B.GRAVEL : B.SAND;
      case Biome.SWAMP:
        return p > 0.1 ? B.CLAY : B.DIRT;
      case Biome.BADLANDS:
      case Biome.WOODED_BADLANDS:
        return B.RED_SAND;
      case Biome.MUSHROOM_FIELDS:
        return B.DIRT;
      case Biome.STONY_SHORE:
      case Biome.STONY_PEAKS:
        return B.GRAVEL;
      default:
        return p > 0.35 ? B.CLAY : p < -0.3 ? B.GRAVEL : B.DIRT;
    }
  }

  fillerDepth(x: number, z: number): number {
    return 3 + Math.floor(hashFloat(x, z, this.seed, 9) * 2);
  }
}

export function isFrozen(biome: number): boolean {
  return biome === Biome.FROZEN_OCEAN || biome === Biome.FROZEN_RIVER || biome === Biome.SNOWY_PLAINS ||
    biome === Biome.ICE_SPIKES || biome === Biome.SNOWY_TAIGA || biome === Biome.SNOWY_BEACH ||
    biome === Biome.SNOWY_SLOPES || biome === Biome.GROVE || biome === Biome.FROZEN_PEAKS || biome === Biome.JAGGED_PEAKS;
}

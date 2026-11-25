import { DoubleNoise, Octaves } from './noise';
import { Rng, hash32 } from './rng';

// Multi-noise climate: temperature, humidity, continentalness, erosion, weirdness (-> peaks & valleys).
// Raw noise values are "uniformised" through a normal CDF so thresholds read as area fractions.

export interface ClimateSample {
  /** temperature 0..1 */
  t: number;
  /** humidity 0..1 */
  h: number;
  /** continentalness 0..1 (0 = deep ocean, 1 = far inland) */
  c: number;
  /** erosion 0..1 (0 = mountainous, 1 = flat) */
  e: number;
  /** weirdness -1..1 */
  w: number;
  /** peaks & valleys -1..1 (-1 = valley / river, 1 = peak) */
  pv: number;
}

export function newClimate(): ClimateSample {
  return { t: 0, h: 0, c: 0, e: 0, w: 0, pv: 0 };
}

// Standard deviations of the raw DoubleNoise outputs, measured empirically (see test/climate.test.ts).
const SIGMA = { t: 0.1265, h: 0.1258, c: 0.1155, e: 0.1281, w: 0.132 };

function erf(x: number): number {
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

function uniformise(v: number, sigma: number): number {
  return 0.5 * (1 + erf(v / (sigma * Math.SQRT2)));
}

export class Climate {
  readonly temp: DoubleNoise;
  readonly humid: DoubleNoise;
  readonly cont: DoubleNoise;
  readonly erosion: DoubleNoise;
  readonly weird: DoubleNoise;
  readonly shiftX: Octaves;
  readonly shiftZ: Octaves;
  static sigma = SIGMA;

  constructor(seed: number) {
    this.temp = new DoubleNoise(new Rng(hash32(seed, 101)), 1 / 1700, [1, 0.9, 0.6, 0.3]);
    this.humid = new DoubleNoise(new Rng(hash32(seed, 102)), 1 / 950, [1, 0.9, 0.6, 0.3]);
    this.cont = new DoubleNoise(new Rng(hash32(seed, 103)), 1 / 1250, [1, 1, 0.9, 0.7, 0.5, 0.4]);
    this.erosion = new DoubleNoise(new Rng(hash32(seed, 104)), 1 / 760, [1, 0.9, 0.5, 0.3]);
    this.weird = new DoubleNoise(new Rng(hash32(seed, 105)), 1 / 340, [1, 0.8, 0.4, 0.2]);
    this.shiftX = new Octaves(new Rng(hash32(seed, 106)), 1 / 220, [1, 0.6, 0.3]);
    this.shiftZ = new Octaves(new Rng(hash32(seed, 107)), 1 / 220, [1, 0.6, 0.3]);
  }

  /** raw (non-uniformised) samples, used for calibration */
  raw(x: number, z: number, out: number[]): void {
    const sx = x + this.shiftX.sample2(x, z) * 40;
    const sz = z + this.shiftZ.sample2(x, z) * 40;
    out[0] = this.temp.sample2(sx, sz);
    out[1] = this.humid.sample2(sx, sz);
    out[2] = this.cont.sample2(sx, sz);
    out[3] = this.erosion.sample2(sx, sz);
    out[4] = this.weird.sample2(sx, sz);
  }

  sample(x: number, z: number, out: ClimateSample): ClimateSample {
    const sx = x + this.shiftX.sample2(x, z) * 40;
    const sz = z + this.shiftZ.sample2(x, z) * 40;
    out.t = uniformise(this.temp.sample2(sx, sz), SIGMA.t);
    out.h = uniformise(this.humid.sample2(sx, sz), SIGMA.h);
    out.c = uniformise(this.cont.sample2(sx, sz), SIGMA.c);
    out.e = uniformise(this.erosion.sample2(sx, sz), SIGMA.e);
    const w = uniformise(this.weird.sample2(sx, sz), SIGMA.w) * 2 - 1;
    out.w = w;
    out.pv = 1 - Math.abs(3 * Math.abs(w) - 2);
    return out;
  }
}

// ---------------------------------------------------------------- biomes

export const Biome = {
  OCEAN: 0,
  WARM_OCEAN: 1,
  LUKEWARM_OCEAN: 2,
  COLD_OCEAN: 3,
  FROZEN_OCEAN: 4,
  RIVER: 5,
  FROZEN_RIVER: 6,
  BEACH: 7,
  SNOWY_BEACH: 8,
  STONY_SHORE: 9,
  PLAINS: 10,
  SUNFLOWER_PLAINS: 11,
  SNOWY_PLAINS: 12,
  ICE_SPIKES: 13,
  FOREST: 14,
  FLOWER_FOREST: 15,
  BIRCH_FOREST: 16,
  DARK_FOREST: 17,
  TAIGA: 18,
  SNOWY_TAIGA: 19,
  GIANT_TAIGA: 20,
  SAVANNA: 21,
  SAVANNA_PLATEAU: 22,
  DESERT: 23,
  BADLANDS: 24,
  WOODED_BADLANDS: 25,
  JUNGLE: 26,
  SPARSE_JUNGLE: 27,
  SWAMP: 28,
  MUSHROOM_FIELDS: 29,
  MEADOW: 30,
  CHERRY_GROVE: 31,
  SNOWY_SLOPES: 32,
  GROVE: 33,
  FROZEN_PEAKS: 34,
  JAGGED_PEAKS: 35,
  STONY_PEAKS: 36,
  WINDSWEPT_HILLS: 37,
} as const;

export const BIOME_COUNT = 38;

export type Precip = 'rain' | 'snow' | 'none';

export interface BiomeInfo {
  id: number;
  name: string;
  ja: string;
  temp: number; // 0..1 for colour, snow below 0.15
  downfall: number; // 0..1
  precip: Precip;
  grass?: [number, number, number];
  foliage?: [number, number, number];
  water: [number, number, number];
  ocean?: boolean;
  river?: boolean;
}

const W_DEFAULT: [number, number, number] = [63, 118, 228];

function bi(id: number, name: string, ja: string, temp: number, downfall: number, precip: Precip, extra: Partial<BiomeInfo> = {}): BiomeInfo {
  return { id, name, ja, temp, downfall, precip, water: W_DEFAULT, ...extra };
}

export const BIOMES: BiomeInfo[] = [
  bi(Biome.OCEAN, 'Ocean', '海', 0.5, 0.5, 'rain', { ocean: true }),
  bi(Biome.WARM_OCEAN, 'Warm Ocean', '暖かい海', 0.5, 0.5, 'rain', { ocean: true, water: [67, 213, 238] }),
  bi(Biome.LUKEWARM_OCEAN, 'Lukewarm Ocean', 'ぬるい海', 0.5, 0.5, 'rain', { ocean: true, water: [69, 173, 242] }),
  bi(Biome.COLD_OCEAN, 'Cold Ocean', '冷たい海', 0.5, 0.5, 'rain', { ocean: true, water: [61, 87, 214] }),
  bi(Biome.FROZEN_OCEAN, 'Frozen Ocean', '凍った海', 0.0, 0.5, 'snow', { ocean: true, water: [57, 56, 201] }),
  bi(Biome.RIVER, 'River', '川', 0.5, 0.5, 'rain', { river: true }),
  bi(Biome.FROZEN_RIVER, 'Frozen River', '凍った川', 0.0, 0.5, 'snow', { river: true, water: [57, 56, 201] }),
  bi(Biome.BEACH, 'Beach', '砂浜', 0.8, 0.4, 'rain'),
  bi(Biome.SNOWY_BEACH, 'Snowy Beach', '雪の砂浜', 0.05, 0.3, 'snow', { water: [61, 87, 214] }),
  bi(Biome.STONY_SHORE, 'Stony Shore', '石の海岸', 0.2, 0.3, 'rain'),
  bi(Biome.PLAINS, 'Plains', '平原', 0.8, 0.4, 'rain'),
  bi(Biome.SUNFLOWER_PLAINS, 'Flower Plains', '花の平原', 0.8, 0.4, 'rain'),
  bi(Biome.SNOWY_PLAINS, 'Snowy Plains', '雪原', 0.0, 0.5, 'snow'),
  bi(Biome.ICE_SPIKES, 'Ice Spikes', '氷樹', 0.0, 0.5, 'snow'),
  bi(Biome.FOREST, 'Forest', '森林', 0.7, 0.8, 'rain'),
  bi(Biome.FLOWER_FOREST, 'Flower Forest', '花の森', 0.7, 0.8, 'rain'),
  bi(Biome.BIRCH_FOREST, 'Birch Forest', '白樺の森', 0.6, 0.6, 'rain'),
  bi(Biome.DARK_FOREST, 'Dark Forest', '暗い森', 0.7, 0.8, 'rain', { grass: [80, 122, 50], foliage: [62, 110, 38] }),
  bi(Biome.TAIGA, 'Taiga', 'タイガ', 0.25, 0.8, 'rain'),
  bi(Biome.SNOWY_TAIGA, 'Snowy Taiga', '雪のタイガ', 0.0, 0.4, 'snow', { water: [61, 87, 214] }),
  bi(Biome.GIANT_TAIGA, 'Old Growth Taiga', '巨大なタイガ', 0.3, 0.8, 'rain'),
  bi(Biome.SAVANNA, 'Savanna', 'サバンナ', 1.0, 0.0, 'none'),
  bi(Biome.SAVANNA_PLATEAU, 'Savanna Plateau', 'サバンナの台地', 1.0, 0.0, 'none'),
  bi(Biome.DESERT, 'Desert', '砂漠', 1.0, 0.0, 'none'),
  bi(Biome.BADLANDS, 'Badlands', '荒野', 1.0, 0.0, 'none', { grass: [144, 129, 77], foliage: [158, 129, 77] }),
  bi(Biome.WOODED_BADLANDS, 'Wooded Badlands', '森のある荒野', 1.0, 0.0, 'none', { grass: [144, 129, 77], foliage: [158, 129, 77] }),
  bi(Biome.JUNGLE, 'Jungle', 'ジャングル', 0.95, 0.9, 'rain'),
  bi(Biome.SPARSE_JUNGLE, 'Sparse Jungle', 'まばらなジャングル', 0.95, 0.8, 'rain'),
  bi(Biome.SWAMP, 'Swamp', '湿地', 0.8, 0.9, 'rain', { grass: [106, 112, 57], foliage: [106, 112, 57], water: [97, 123, 100] }),
  bi(Biome.MUSHROOM_FIELDS, 'Mushroom Fields', 'キノコ島', 0.9, 1.0, 'rain'),
  bi(Biome.MEADOW, 'Meadow', '草地', 0.5, 0.8, 'rain', { water: [14, 78, 207] }),
  bi(Biome.CHERRY_GROVE, 'Cherry Grove', '桜の林', 0.5, 0.8, 'rain', { grass: [182, 219, 97], foliage: [182, 219, 97], water: [93, 183, 239] }),
  bi(Biome.SNOWY_SLOPES, 'Snowy Slopes', '雪の斜面', 0.0, 0.9, 'snow'),
  bi(Biome.GROVE, 'Grove', '林', 0.05, 0.8, 'snow'),
  bi(Biome.FROZEN_PEAKS, 'Frozen Peaks', '凍った山頂', 0.0, 0.9, 'snow'),
  bi(Biome.JAGGED_PEAKS, 'Jagged Peaks', '尖った山頂', 0.0, 0.9, 'snow'),
  bi(Biome.STONY_PEAKS, 'Stony Peaks', '石だらけの山頂', 1.0, 0.3, 'rain'),
  bi(Biome.WINDSWEPT_HILLS, 'Windswept Hills', '吹きさらしの丘', 0.2, 0.3, 'rain'),
];

function band(v: number, a: number, b: number, c: number, d: number): number {
  return v < a ? 0 : v < b ? 1 : v < c ? 2 : v < d ? 3 : 4;
}

const B = Biome;
// temperature (rows) x humidity (cols)
const MIDDLE: number[][] = [
  [B.SNOWY_PLAINS, B.SNOWY_PLAINS, B.SNOWY_PLAINS, B.SNOWY_TAIGA, B.SNOWY_TAIGA],
  [B.PLAINS, B.PLAINS, B.FOREST, B.TAIGA, B.GIANT_TAIGA],
  [B.SUNFLOWER_PLAINS, B.PLAINS, B.FOREST, B.BIRCH_FOREST, B.DARK_FOREST],
  [B.SAVANNA, B.SAVANNA, B.FOREST, B.SPARSE_JUNGLE, B.JUNGLE],
  [B.DESERT, B.DESERT, B.DESERT, B.DESERT, B.DESERT],
];
const MIDDLE_VARIANT: (number | null)[][] = [
  [B.ICE_SPIKES, null, B.SNOWY_TAIGA, null, null],
  [null, null, null, null, B.GIANT_TAIGA],
  [B.FLOWER_FOREST, B.SUNFLOWER_PLAINS, B.BIRCH_FOREST, B.FOREST, B.DARK_FOREST],
  [null, null, B.PLAINS, B.JUNGLE, B.JUNGLE],
  [null, null, null, null, null],
];
const PLATEAU: number[][] = [
  [B.SNOWY_PLAINS, B.SNOWY_PLAINS, B.SNOWY_TAIGA, B.SNOWY_TAIGA, B.SNOWY_TAIGA],
  [B.MEADOW, B.MEADOW, B.FOREST, B.TAIGA, B.GIANT_TAIGA],
  [B.MEADOW, B.CHERRY_GROVE, B.FOREST, B.BIRCH_FOREST, B.DARK_FOREST],
  [B.SAVANNA_PLATEAU, B.SAVANNA_PLATEAU, B.FOREST, B.FOREST, B.JUNGLE],
  [B.BADLANDS, B.BADLANDS, B.WOODED_BADLANDS, B.WOODED_BADLANDS, B.BADLANDS],
];

export interface TerrainKnobs {
  /** 0..1 inland factor */
  inland: number;
  /** 0..1 mountain factor */
  mountain: number;
}

export function mountainFactor(c: number, e: number): number {
  return (1 - smooth(0.12, 0.55, e)) * smooth(0.42, 0.72, c);
}

export function smooth(a: number, b: number, x: number): number {
  let t = (x - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

/** Thresholds shared with terrain.ts */
export const C_OCEAN = 0.27;
export const C_COAST = 0.36;
export const C_MUSHROOM = 0.014;

export function pickBiome(s: ClimateSample): number {
  const T = band(s.t, 0.15, 0.35, 0.62, 0.85);
  const H = band(s.h, 0.15, 0.35, 0.62, 0.85);
  const { c, e, pv, w } = s;
  if (c < C_OCEAN) {
    if (c < C_MUSHROOM && Math.abs(w) > 0.5) return B.MUSHROOM_FIELDS;
    return T === 0 ? B.FROZEN_OCEAN : T === 1 ? B.COLD_OCEAN : T === 2 ? B.OCEAN : T === 3 ? B.LUKEWARM_OCEAN : B.WARM_OCEAN;
  }
  // rivers: valley floor, inland
  if (pv < -0.86 && c > C_OCEAN + 0.05) return T === 0 ? B.FROZEN_RIVER : B.RIVER;
  const m = mountainFactor(c, e);
  if (c < C_COAST) {
    if (m > 0.25 || e < 0.25) return B.STONY_SHORE;
    if (T === 0) return B.SNOWY_BEACH;
    if (T === 4 && H <= 1) return B.DESERT;
    return B.BEACH;
  }
  // peaks
  if (m > 0.45 && pv > 0.62) {
    if (T <= 2) return pv > 0.8 ? B.JAGGED_PEAKS : B.FROZEN_PEAKS;
    return B.STONY_PEAKS;
  }
  // slopes
  if (m > 0.35 && pv > 0.25) {
    if (T === 0) return H >= 3 ? B.GROVE : B.SNOWY_SLOPES;
    if (T === 1) return H >= 3 ? B.GROVE : B.SNOWY_SLOPES;
    if (T === 2) return w < 0 ? B.CHERRY_GROVE : B.MEADOW;
    if (T === 3) return B.SAVANNA_PLATEAU;
    return B.BADLANDS;
  }
  // swamps: flat, wet, low
  if (e > 0.72 && pv < -0.15 && T >= 1 && T <= 3 && H >= 3) return B.SWAMP;
  // windswept
  if (e > 0.55 && e < 0.68 && pv > 0.45 && T <= 2 && c > 0.5) return B.WINDSWEPT_HILLS;
  // plateau-ish
  if (pv > 0.3 && e < 0.62 && c > 0.5) return PLATEAU[T][H];
  if (w > 0) {
    const v = MIDDLE_VARIANT[T][H];
    if (v !== null) return v;
  }
  return MIDDLE[T][H];
}

// ---------------------------------------------------------------- colours

type RGB = [number, number, number];

function lerp3(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Triangle colour map (temperature, downfall) -> colour. Original palette. */
function colormap(temp: number, downfall: number, hotDry: RGB, cold: RGB, hotWet: RGB): RGB {
  const t = Math.min(1, Math.max(0, temp));
  const d = Math.min(1, Math.max(0, downfall)) * t;
  const warm = lerp3(cold, hotDry, t);
  // move toward the wet corner by downfall
  return lerp3(warm, hotWet, d);
}

export function biomeGrass(b: BiomeInfo): RGB {
  if (b.grass) return b.grass;
  return colormap(b.temp, b.downfall, [190, 182, 86], [128, 180, 151], [72, 196, 54]);
}

export function biomeFoliage(b: BiomeInfo): RGB {
  if (b.foliage) return b.foliage;
  return colormap(b.temp, b.downfall, [174, 164, 42], [96, 161, 123], [48, 180, 22]);
}

export function biomeSky(temp: number): RGB {
  // cooler biomes: paler, slightly more cyan; hot: deeper blue
  const t = Math.min(1, Math.max(0, temp));
  return lerp3([130, 172, 255], [118, 160, 255], t);
}

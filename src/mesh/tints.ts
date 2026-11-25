import { BIOMES, biomeFoliage, biomeGrass } from '../gen/climate';
import { CELL_XZ, CHUNK } from '../gen/constants';
import type { Terrain } from '../gen/terrain';

// per-biome colours, precomputed
const GRASS = BIOMES.map((b) => biomeGrass(b));
const FOLIAGE = BIOMES.map((b) => biomeFoliage(b));
const WATER = BIOMES.map((b) => b.water);

/** per-column biome tints of a chunk, (z*16+x)*9: grass rgb, foliage rgb, water rgb */
export function computeTints(t: Terrain, wx0: number, wz0: number, out: Uint8Array): void {
  // lattice points covering [wx0-4, wx0+20], each blended over its 3x3 lattice neighbourhood
  const ix0 = Math.floor(wx0 / CELL_XZ) - 1;
  const iz0 = Math.floor(wz0 / CELL_XZ) - 1;
  const N = 7;
  const g = new Float32Array(N * N * 9);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      let r0 = 0, g0 = 0, b0 = 0, r1 = 0, g1 = 0, b1 = 0, r2 = 0, g2 = 0, b2 = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const c = t.corner(ix0 + i + dx, iz0 + j + dz);
          const b = c.biome;
          // grass gets cooler (bluer) with altitude like mountain meadows
          const gr = GRASS[b];
          const fo = FOLIAGE[b];
          const wa = WATER[b];
          r0 += gr[0]; g0 += gr[1]; b0 += gr[2];
          r1 += fo[0]; g1 += fo[1]; b1 += fo[2];
          r2 += wa[0]; g2 += wa[1]; b2 += wa[2];
        }
      }
      const o = (j * N + i) * 9;
      g[o] = r0 / 9; g[o + 1] = g0 / 9; g[o + 2] = b0 / 9;
      g[o + 3] = r1 / 9; g[o + 4] = g1 / 9; g[o + 5] = b1 / 9;
      g[o + 6] = r2 / 9; g[o + 7] = g2 / 9; g[o + 8] = b2 / 9;
    }
  }
  for (let z = 0; z < CHUNK; z++) {
    for (let x = 0; x < CHUNK; x++) {
      const wx = wx0 + x;
      const wz = wz0 + z;
      const fx = wx / CELL_XZ - ix0;
      const fz = wz / CELL_XZ - iz0;
      const i0 = Math.floor(fx);
      const j0 = Math.floor(fz);
      const tx = fx - i0;
      const tz = fz - j0;
      const o = (z * 16 + x) * 9;
      for (let k = 0; k < 9; k++) {
        const a = g[(j0 * N + i0) * 9 + k];
        const b = g[(j0 * N + i0 + 1) * 9 + k];
        const c = g[((j0 + 1) * N + i0) * 9 + k];
        const d = g[((j0 + 1) * N + i0 + 1) * 9 + k];
        out[o + k] = Math.round((a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz);
      }
    }
  }
}

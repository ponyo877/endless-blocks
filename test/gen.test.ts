import { describe, expect, it } from 'vitest';
import { B } from '../src/gen/blocks';
import { BIOMES, Climate, pickBiome } from '../src/gen/climate';
import { SEA, idx } from '../src/gen/constants';
import { createContext, generateChunk } from '../src/gen/generateChunk';

function fnv(a: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a[i], 0x01000193);
  return h >>> 0;
}

describe('world generation', () => {
  it('is deterministic for the same seed and chunk, independent of generation order', () => {
    const a = createContext(4242);
    const b = createContext(4242);
    const coords = [[0, 0], [5, -3], [-40, 77], [1000, -2000]];
    const ha = coords.map(([x, z]) => fnv(generateChunk(a, x, z).blocks));
    // generate in reverse order with another context (different cache state)
    const hb = coords.slice().reverse().map(([x, z]) => fnv(generateChunk(b, x, z).blocks)).reverse();
    expect(hb).toEqual(ha);
    // different seed -> different world
    const c = createContext(4243);
    expect(fnv(generateChunk(c, 0, 0).blocks)).not.toBe(ha[0]);
  });

  it('columnTop() agrees with the generated terrain (and never under-estimates it)', () => {
    const ctx = createContext(777);
    let close = 0;
    let total = 0;
    for (const [cx, cz] of [[0, 0], [12, -9], [-30, 44], [80, 80]]) {
      const ch = generateChunk(ctx, cx, cz);
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          const top = ctx.terrain.columnTop(cx * 16 + x, cz * 16 + z);
          expect(top).toBeGreaterThanOrEqual(0);
          // the terrain surface block exists
          expect(ch.blocks[idx(x, top, z)]).not.toBe(B.AIR);
          // whatever is above (trees, plants, water) is accounted for by the chunk heightmap
          expect(ch.heights[z * 16 + x]).toBeGreaterThanOrEqual(Math.min(top, SEA - 1));
          total++;
          if (ch.heights[z * 16 + x] - Math.max(top, SEA - 1) <= 1) close++;
        }
      }
    }
    expect(close / total).toBeGreaterThan(0.5);
  });

  it('covers the biome table with a sensible ocean share', () => {
    const cl = new Climate(99);
    const seen = new Set<number>();
    const s = { t: 0, h: 0, c: 0, e: 0, w: 0, pv: 0 };
    let ocean = 0;
    const N = 30000;
    for (let i = 0; i < N; i++) {
      const x = ((i * 7919) % 20011) * 37 - 370000;
      const z = ((i * 104729) % 19997) * 37 - 370000;
      cl.sample(x, z, s);
      const b = pickBiome(s);
      seen.add(b);
      if (BIOMES[b].ocean) ocean++;
    }
    expect(seen.size).toBeGreaterThanOrEqual(BIOMES.length - 4);
    expect(ocean / N).toBeGreaterThan(0.12);
    expect(ocean / N).toBeLessThan(0.45);
  });
});

import { describe, expect, it } from 'vitest';
import { PathPlanner } from '../src/autopilot/planner';
import { PathLog } from '../src/autopilot/path';
import { CHUNK } from '../src/gen/constants';
import { createContext, generateChunk } from '../src/gen/generateChunk';

function collect(seed: number, n: number, budget: number): PathLog {
  const p = new PathPlanner(seed);
  const log = new PathLog();
  while (log.length < n) {
    const b = p.planUntil(n, budget);
    if (b) log.append(b.s0, b.x, b.y, b.z);
  }
  return log;
}

describe('autopilot path', () => {
  it('is deterministic regardless of how planning is chunked', () => {
    const a = collect(31337, 1500, 1e9);
    const b = collect(31337, 1500, 2); // many tiny batches
    const pa = { x: 0, y: 0, z: 0 };
    const pb = { x: 0, y: 0, z: 0 };
    for (let s = 0; s < 1400; s += 7.3) {
      a.sample(s, pa);
      b.sample(s, pb);
      expect(pb).toEqual(pa);
    }
  });

  it('stays above every generated block (terrain, trees, plants) along the corridor', () => {
    const seed = 2024;
    const log = collect(seed, 900, 1e9);
    const ctx = createContext(seed);
    const cache = new Map<string, Int16Array>();
    const height = (x: number, z: number) => {
      const cx = Math.floor(x / CHUNK);
      const cz = Math.floor(z / CHUNK);
      const k = `${cx},${cz}`;
      let h = cache.get(k);
      if (!h) {
        h = generateChunk(ctx, cx, cz).heights;
        cache.set(k, h);
      }
      return h[(Math.floor(z) - cz * CHUNK) * 16 + (Math.floor(x) - cx * CHUNK)];
    };
    const p = { x: 0, y: 0, z: 0 };
    let minClear = Infinity;
    for (let s = 0; s < 850; s += 1) {
      log.sample(s, p);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const c = p.y - (height(p.x + dx, p.z + dz) + 1);
          if (c < minClear) minClear = c;
        }
      }
    }
    expect(minClear).toBeGreaterThan(0.5);
  }, 60000);
});

import { createContext, generateChunk } from '../src/gen/generateChunk';
import { PathPlanner } from '../src/autopilot/planner';
for (const seed of [12345, 777, 8675309]) {
  const ctx = createContext(seed);
  const counts = [0, 0, 0];
  let houses = 0;
  const N = 30;
  for (let gz = -N / 2; gz < N / 2; gz++) for (let gx = -N / 2; gx < N / 2; gx++) {
    const s = ctx.structures.cell(gx, gz);
    if (s) { counts[s.type]++; houses += s.houses.length; }
  }
  // gen cost of a village chunk
  const v = (() => { for (let gz = -5; gz < 5; gz++) for (let gx = -5; gx < 5; gx++) { const s = ctx.structures.cell(gx, gz); if (s && s.type === 0) return s; } return null; })();
  let ms = 0;
  if (v) {
    const t0 = performance.now();
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) generateChunk(ctx, Math.floor(v.x / 16) + dx, Math.floor(v.z / 16) + dz);
    ms = (performance.now() - t0) / 25;
  }
  // how many villages does the flight pass within 64 blocks in the first 20 km?
  const p = new PathPlanner(seed);
  const xs: number[] = [], zs: number[] = [];
  while (p.committed < 20000) { const b = p.planUntil(20000, 1e9); if (b) { xs.push(...b.x); zs.push(...b.z); } }
  const seen = new Set<string>();
  for (let k = 0; k < xs.length; k += 8) {
    const nv = ctx.structures.nearestVillage(xs[k], zs[k]);
    if (nv && nv.d < 64) seen.add(`${nv.x},${nv.z}`);
  }
  console.log(`seed ${seed}: per ${N * N} cells villages ${counts[0]} (houses avg ${(houses / Math.max(1, counts[0])).toFixed(1)}) pyramids ${counts[1]} towers ${counts[2]}; village-chunk gen ${ms.toFixed(1)}ms; villages passed in 20km: ${seen.size}`);
}

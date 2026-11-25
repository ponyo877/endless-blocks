import { createContext } from '../src/gen/generateChunk';
import { PathPlanner } from '../src/autopilot/planner';
const seed = Number(process.argv[2] ?? 12345);
const ctx = createContext(seed);
const p = new PathPlanner(seed);
const xs: number[] = [], zs: number[] = [];
while (p.committed < 12000) { const b = p.planUntil(12000, 1e9); if (b) { xs.push(...b.x); zs.push(...b.z); } }
let last = '';
for (let k = 0; k < xs.length; k += 4) {
  const nv = ctx.structures.nearestVillage(xs[k], zs[k]);
  if (nv && nv.d < 40 && `${nv.x}` !== last) { last = `${nv.x}`; console.log(`s=${k} village at ${nv.x},${nv.z}`); }
}
for (let k = 0; k < xs.length; k += 4) {
  for (const st of ctx.structures.near(xs[k] - 30, zs[k] - 30, xs[k] + 30, zs[k] + 30, [])) if (st.type !== 0) { console.log(`s=${k} type ${st.type} at ${st.x},${st.z}`); k += 200; break; }
}

import { PathPlanner } from '../src/autopilot/planner';
import { SEA } from '../src/gen/constants';
for (const seed of [12345, 777, 4242]) {
  const p = new PathPlanner(seed);
  const t0 = performance.now();
  let total = 0; const xs: number[] = [], ys: number[] = [], zs: number[] = [];
  while (p.committed < 8000) { const b = p.planUntil(8000, 1000); if (b) { total += b.x.length; xs.push(...b.x); ys.push(...b.y); zs.push(...b.z); } }
  const dt = performance.now() - t0;
  let viol = 0, water = 0, ocean = 0, minClear = 1e9, sumClear = 0;
  for (let k = 0; k < xs.length; k++) {
    const r = p.reqAt(k); const c = ys[k] - r; if (c < -1e-6) viol++; if (c < minClear) minClear = c; sumClear += ys[k] - (r - 5);
    const top = p.terrain.columnTop(Math.floor(xs[k]), Math.floor(zs[k])); if (top < SEA - 1) { water++; if (p.terrain.cornerAt(xs[k], zs[k]).c < 0.3) ocean++; }
  }
  // net displacement & turning
  const disp = Math.hypot(xs[xs.length-1]-xs[0], zs[zs.length-1]-zs[0]);
  console.log(`seed ${seed}: ${total} samples in ${dt.toFixed(0)}ms (${(dt/total*1000).toFixed(1)}us/blk) viol ${viol} water ${(100*water/total).toFixed(1)}% ocean ${(100*ocean/total).toFixed(1)}% avg clearance ${(sumClear/total).toFixed(1)} alt range ${Math.min(...ys).toFixed(0)}..${Math.max(...ys).toFixed(0)} disp ${disp.toFixed(0)} start ${p.startX},${p.startZ}`);
  // smoothness: max vertical slope & max yaw rate
  let maxSlope = 0, maxTurn = 0;
  for (let k = 1; k < xs.length - 1; k++) {
    maxSlope = Math.max(maxSlope, Math.abs(ys[k+1]-ys[k]));
    const a1 = Math.atan2(zs[k]-zs[k-1], xs[k]-xs[k-1]), a2 = Math.atan2(zs[k+1]-zs[k], xs[k+1]-xs[k]);
    let d = a2 - a1; while (d > Math.PI) d -= 2*Math.PI; while (d < -Math.PI) d += 2*Math.PI; maxTurn = Math.max(maxTurn, Math.abs(d));
  }
  console.log(`  max dy/blk ${maxSlope.toFixed(3)}, max turn/blk ${(maxTurn*180/Math.PI).toFixed(2)} deg`);
}

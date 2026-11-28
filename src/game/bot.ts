import type { PathLog } from '../autopilot/path';
import type { GameState, TickInput } from './sim';

// A simple pilot for benchmarks and smoke tests: follows the autopilot path a few blocks lower than
// planned, so it grazes treetops and hillsides now and then.

export class Bot {
  private s: number;
  private readonly p = { x: 0, y: 0, z: 0 };

  constructor(private readonly path: PathLog, startS: number, private readonly drop = 8) {
    this.s = startS;
  }

  input(st: GameState): TickInput {
    // advance our place on the path to stay level with the glider
    for (let i = 0; i < 64; i++) {
      const q = this.path.sample(this.s + 1, this.p);
      const dx = q.x - st.x;
      const dz = q.z - st.z;
      if (dx * st.fx + dz * st.fz > 0) break;
      this.s += 1;
    }
    const t = this.path.sample(this.s + 22, this.p);
    const dx = t.x - st.x;
    const dy = t.y - this.drop - st.y;
    const dz = t.z - st.z;
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, Math.hypot(dx, dz));
    let dyaw = yaw - st.yaw;
    while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
    while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
    const k = (v: number) => Math.max(-127, Math.min(127, Math.round(v)));
    return { sx: k((-dyaw / 0.35) * 127), sy: k(((pitch - st.pitch) / 0.3) * 127), boost: 0 };
  }
}

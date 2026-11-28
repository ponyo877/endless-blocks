// Where a run starts: on the autopilot route at SPAWN_S, heading along it. Shared by the game and the replay checker.
import type { PathLog } from '../autopilot/path';
import { SPAWN_S } from './rules';
import type { Spawn } from './sim';

/** path samples needed before the spawn can be computed */
export const SPAWN_NEED = SPAWN_S + 64;

export function spawnFromPath(path: PathLog): Spawn {
  const a = path.sample(SPAWN_S, { x: 0, y: 0, z: 0 });
  const b = path.sample(SPAWN_S + 24, { x: 0, y: 0, z: 0 });
  return { x: a.x, y: a.y, z: a.z, yaw: Math.atan2(-(b.x - a.x), -(b.z - a.z)) };
}

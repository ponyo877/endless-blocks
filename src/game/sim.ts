import { Coll } from '../gen/blocks';
import { dcos, dsin } from '../gen/dmath';
import { type Nearest, type RayHit, type VoxelSource, nearest, overlaps, ray } from './voxels';

// The game simulation: fixed 60 Hz ticks, a pure function of (spawn, inputs, world). It uses only
// IEEE-exact arithmetic (and dmath for sin/cos), so a recorded input log replays to the same score on
// every engine, which is what lets a server re-check submitted runs.

import { DT, RULES, TICK_HZ } from './rules';

export { DT, RULES, TICK_HZ };

/** one tick of input: stick axes as integers in [-127, 127] (right / up positive), boost 0 or 1 */
export interface TickInput {
  sx: number;
  sy: number;
  boost: number;
}

export type EventKind = 'close' | 'thread' | 'skim' | 'canopy' | 'tube' | 'chain' | 'bank' | 'crash' | 'stall' | 'recover';

export interface GameEvent {
  kind: EventKind;
  /** points added (to the pending chain, or banked for 'bank') */
  pts: number;
}

export const SIDE_UP = 1;
export const SIDE_DOWN = 2;
export const SIDE_LEFT = 4;
export const SIDE_RIGHT = 8;

export interface Spawn {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export class GameState {
  tick = 0;
  x: number;
  y: number;
  z: number;
  /** heading: yaw 0 looks toward -z, positive yaw turns left; pitch positive is nose up */
  yaw: number;
  pitch = 0;
  yawRate = 0;
  pitchRate = 0;
  speed: number = RULES.speed0;
  lift: number = RULES.liftMax;
  stalled = false;
  stallTicks = 0;
  alive = true;
  cause: '' | 'crash' | 'stall' = '';
  hitClass = 0;
  /** banked score (distance points + banked chains) */
  score = 0;
  /** points of the running chain, lost on a crash */
  chain = 0;
  chainMult = 1;
  chainTicks = 0;
  gapTicks = 0;
  bestChain = 0;
  distance = 0;
  boosting = false;
  // per-tick readings (for the HUD and effects)
  clearance = Infinity;
  graze = 0;
  sides = 0;
  /** clearance in each side direction (up, down, left, right), capped at RULES.sideRange */
  sideDist = [0, 0, 0, 0];
  /** class found by each side ray (0 = nothing in range) */
  sideCls = [0, 0, 0, 0];
  encMult = 1;
  readonly near: Nearest = { dist: Infinity, cls: 0, x: 0, y: 0, z: 0 };
  /** forward unit vector */
  fx = 0;
  fy = 0;
  fz = -1;
  // event timers (ticks)
  closeCd = 0;
  threadCd = 0;
  skimTicks = 0;
  canopyTicks = 0;
  tubeTicks = 0;
  counts: Record<'close' | 'thread' | 'skim' | 'canopy' | 'tube', number> = { close: 0, thread: 0, skim: 0, canopy: 0, tube: 0 };

  constructor(spawn: Spawn) {
    this.x = spawn.x;
    this.y = spawn.y;
    this.z = spawn.z;
    this.yaw = spawn.yaw;
    this.updateForward();
  }

  get time(): number {
    return this.tick * DT;
  }

  /** score shown to the player: banked + running chain */
  get total(): number {
    return Math.floor(this.score + this.chain);
  }

  get finalScore(): number {
    return Math.floor(this.score);
  }

  updateForward(): void {
    const cp = dcos(this.pitch);
    this.fx = -dsin(this.yaw) * cp;
    this.fy = dsin(this.pitch);
    this.fz = -dcos(this.yaw) * cp;
  }
}

const hit: RayHit = { dist: 0, cls: 0 };
const rayCls = [0, 0, 0, 0];

function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}

/** advance one tick. Events of this tick are appended to `events`. */
export function step(s: GameState, input: TickInput, src: VoxelSource, events: GameEvent[]): void {
  if (!s.alive) return;
  const R = RULES;
  const t = s.tick * DT;

  // ---- controls
  let yawT: number;
  let pitchT: number;
  if (s.stalled) {
    yawT = 0;
    pitchT = s.pitch > R.stallPitch ? -R.pitchRate * 0.66 : 0;
  } else {
    yawT = (-clamp(input.sx, -127, 127) / 127) * R.yawRate;
    // the nose drifts back toward level when the stick is released
    pitchT = (clamp(input.sy, -127, 127) / 127) * R.pitchRate - s.pitch * R.pitchLevel;
  }
  s.yawRate += (yawT - s.yawRate) * R.rateEase;
  s.pitchRate += (pitchT - s.pitchRate) * R.rateEase;
  s.yaw += s.yawRate * DT;
  s.pitch += s.pitchRate * DT;
  if (s.pitch > R.pitchMax) {
    s.pitch = R.pitchMax;
    s.pitchRate = 0;
  } else if (s.pitch < -R.pitchMax) {
    s.pitch = -R.pitchMax;
    s.pitchRate = 0;
  }
  // keep yaw bounded (exactly reversible, no trig involved)
  if (s.yaw > Math.PI) s.yaw -= 2 * Math.PI;
  else if (s.yaw < -Math.PI) s.yaw += 2 * Math.PI;
  s.updateForward();

  // ---- speed
  const base = Math.min(R.speedMax, R.speed0 + t * R.speedRamp);
  s.boosting = input.boost !== 0 && !s.stalled;
  const target = base * (1 - R.pitchSpeed * s.fy) * (s.boosting ? R.boostSpeed : 1);
  s.speed += (target - s.speed) * R.speedEase;

  // ---- move in sub-steps of at most 1/4 block, so a fast glider cannot skip through a thin wall
  const dist = s.speed * DT;
  const n = Math.ceil(dist / 0.25);
  const d = dist / n;
  for (let i = 0; i < n; i++) {
    s.x += s.fx * d;
    s.y += s.fy * d;
    s.z += s.fz * d;
    const c = overlaps(src, s.x, s.y, s.z, R.radius);
    if (c) {
      s.alive = false;
      s.cause = 'crash';
      s.hitClass = c;
      s.chain = 0;
      s.distance += d * (i + 1);
      s.tick++;
      events.push({ kind: 'crash', pts: 0 });
      return;
    }
  }
  s.distance += dist;
  s.score += dist;

  // ---- readings: nearest surface, and what is around us in the four side directions
  nearest(src, s.x, s.y, s.z, R.grazeRange + R.radius, s.near);
  const clearance = s.near.dist === Infinity ? Infinity : Math.max(0, s.near.dist - R.radius);
  s.clearance = clearance;
  const g = clearance < R.grazeRange ? (1 - clearance / R.grazeRange) * (1 - clearance / R.grazeRange) : 0;
  s.graze = g;

  const sy = dsin(s.yaw);
  const cy = dcos(s.yaw);
  const sp = s.fy;
  const cp = dcos(s.pitch);
  // right = (cos yaw, 0, -sin yaw); up = (sin pitch sin yaw, cos pitch, sin pitch cos yaw)
  const ux = sp * sy;
  const uy = cp;
  const uz = sp * cy;
  const range = R.sideRange + R.radius;
  let sides = 0;
  const dirs = [ux, uy, uz, -ux, -uy, -uz, -cy, 0, sy, cy, 0, -sy];
  for (let k = 0; k < 4; k++) {
    ray(src, s.x, s.y, s.z, dirs[k * 3], dirs[k * 3 + 1], dirs[k * 3 + 2], range, hit);
    const cl = Math.max(0, hit.dist - R.radius);
    s.sideDist[k] = Math.min(R.sideRange, cl);
    rayCls[k] = hit.cls;
    s.sideCls[k] = hit.cls;
    if (hit.cls && cl < R.sideRange) sides |= 1 << k;
  }
  s.sides = sides;
  const nSides = (sides & 1) + ((sides >> 1) & 1) + ((sides >> 2) & 1) + ((sides >> 3) & 1);
  const mult = nSides <= 1 ? 1 : nSides;
  s.encMult = mult;

  // ---- events
  let bonus = 0;
  let liftBonus = 0;
  const award = (kind: 'close' | 'thread' | 'skim' | 'canopy' | 'tube') => {
    const pts = R.bonus[kind] * s.chainMult;
    bonus += pts;
    liftBonus += R.liftBonus[kind];
    s.counts[kind]++;
    events.push({ kind, pts });
  };
  if (s.closeCd > 0) s.closeCd--;
  if (s.threadCd > 0) s.threadCd--;
  if (clearance < R.closeCall && s.closeCd === 0) {
    award('close');
    s.closeCd = 36;
  }
  const lr = (sides & (SIDE_LEFT | SIDE_RIGHT)) === (SIDE_LEFT | SIDE_RIGHT) && s.sideDist[2] < R.threadRange && s.sideDist[3] < R.threadRange;
  const ud = (sides & (SIDE_UP | SIDE_DOWN)) === (SIDE_UP | SIDE_DOWN) && s.sideDist[0] < R.threadRange && s.sideDist[1] < R.threadRange;
  if ((lr || ud) && s.threadCd === 0) {
    award('thread');
    s.threadCd = 60;
  }
  if (rayCls[1] === Coll.LIQUID && s.sideDist[1] < R.skimRange) {
    s.skimTicks++;
    if (s.skimTicks % TICK_HZ === 0) award('skim');
  } else s.skimTicks = 0;
  if (rayCls[0] === Coll.LEAVES && (sides & SIDE_UP) && (sides & SIDE_DOWN)) {
    s.canopyTicks++;
    if (s.canopyTicks === TICK_HZ) award('canopy');
  } else s.canopyTicks = 0;
  if (sides === 15) {
    s.tubeTicks++;
    if (s.tubeTicks === TICK_HZ * 2) award('tube');
  } else s.tubeTicks = 0;

  // ---- chain: grazing (or a bonus) keeps it going; a second without either banks it
  const boostF = s.boosting ? R.boostScore : 1;
  if (g > 0 || bonus > 0) {
    s.chainTicks++;
    s.gapTicks = 0;
    const m = Math.min(R.chainMax, 1 + R.chainInc * Math.floor(s.chainTicks / (R.chainStep * TICK_HZ)));
    if (m > s.chainMult) events.push({ kind: 'chain', pts: 0 });
    s.chainMult = m;
    s.chain += R.pointRate * g * mult * (s.speed / R.speed0) * boostF * s.chainMult * DT + bonus;
  } else if (s.chain > 0 || s.chainTicks > 0) {
    s.gapTicks++;
    if (s.gapTicks >= R.chainGap * TICK_HZ) {
      events.push({ kind: 'bank', pts: s.chain });
      s.score += s.chain;
      if (s.chain > s.bestChain) s.bestChain = s.chain;
      s.chain = 0;
      s.chainTicks = 0;
      s.chainMult = 1;
      s.gapTicks = 0;
    }
  }

  // ---- lift
  const drain = R.liftDrain0 + (R.liftDrain1 - R.liftDrain0) * Math.min(1, t / R.liftDrainRamp) + (s.boosting ? R.liftBoostDrain : 0);
  const near = clearance < R.liftRange ? 1 - clearance / R.liftRange : 0;
  s.lift = clamp(s.lift + (R.liftRefill * near * mult - drain) * DT + liftBonus, 0, R.liftMax);
  if (!s.stalled && s.lift <= 0) {
    s.stalled = true;
    s.stallTicks = 0;
    events.push({ kind: 'stall', pts: 0 });
  } else if (s.stalled && s.lift >= R.liftRecover) {
    s.stalled = false;
    events.push({ kind: 'recover', pts: 0 });
  }
  if (s.stalled) {
    s.stallTicks++;
    if (s.stallTicks > R.stallTimeout * TICK_HZ) {
      s.alive = false;
      s.cause = 'stall';
      s.chain = 0;
      events.push({ kind: 'crash', pts: 0 });
    }
  }
  s.tick++;
}

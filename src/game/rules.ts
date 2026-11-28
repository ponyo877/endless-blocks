// Game rules shared by the simulation, the HUD and the ranking server (which uses them to bound
// plausible scores). No imports, so the server can bundle it alone.

const DEG = Math.PI / 180;

/** bump when the rules change in a way that changes scores; stored with every ranked run */
export const RULES_VERSION = 1;

/** every run of a seed starts this far along the autopilot route */
export const SPAWN_S = 600;

export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;

export const RULES = {
  /** hitbox: a sphere at the glider's centre, smaller than the glider looks */
  radius: 0.3,
  /** grazing starts this close (blocks between hitbox and terrain) */
  grazeRange: 3,
  /** a side counts as "boxed in" when the side ray finds terrain this close */
  sideRange: 3.5,
  threadRange: 1.2,
  closeCall: 0.3,
  skimRange: 1,
  speed0: 16,
  speedMax: 40,
  /** base speed gain per second of flight */
  speedRamp: 1 / 8,
  boostSpeed: 1.5,
  boostScore: 1.5,
  /** dive adds speed, climb takes it away: factor 1 - k sin(pitch) */
  pitchSpeed: 0.25,
  yawRate: 110 * DEG,
  pitchRate: 90 * DEG,
  pitchMax: 70 * DEG,
  /** self-levelling: pitch rate (rad/s) per radian of pitch */
  pitchLevel: 0.8,
  /** per-tick easing of turn rates and speed toward their targets */
  rateEase: 0.15,
  speedEase: 0.03,
  liftMax: 100,
  liftDrain0: 6,
  liftDrain1: 9,
  liftDrainRamp: 180,
  liftBoostDrain: 8,
  liftRefill: 30,
  /** lift refills within this clearance, linearly more the closer (blocks) */
  liftRange: 4,
  liftRecover: 20,
  stallPitch: -60 * DEG,
  stallTimeout: 6,
  pointRate: 120,
  chainStep: 2,
  chainInc: 0.5,
  chainMax: 6,
  chainGap: 1,
  bonus: { close: 250, thread: 400, skim: 150, canopy: 300, tube: 1000 },
  liftBonus: { close: 8, thread: 12, skim: 4, canopy: 6, tube: 15 },
} as const;

/** fastest possible speed (blocks/s): full ramp, full boost, steepest dive */
export const MAX_SPEED = RULES.speedMax * RULES.boostSpeed * (1 + RULES.pitchSpeed);

/** a generous upper bound on points per second of flight, for server-side plausibility checks */
export const MAX_POINTS_PER_SECOND =
  MAX_SPEED + RULES.pointRate * 4 * (MAX_SPEED / RULES.speed0) * RULES.boostScore * RULES.chainMax +
  (RULES.bonus.close / 0.6 + RULES.bonus.thread + RULES.bonus.skim + RULES.bonus.canopy + RULES.bonus.tube) * RULES.chainMax;

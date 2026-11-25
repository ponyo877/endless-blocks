// Adaptive quality: watches frame intervals and steps render scale, then render distance.

export interface QualityLevel {
  scale: number;
  rdDelta: number;
}

export const LEVELS: QualityLevel[] = [
  { scale: 1, rdDelta: 0 },
  { scale: 0.85, rdDelta: 0 },
  { scale: 0.85, rdDelta: -2 },
  { scale: 0.7, rdDelta: -2 },
  { scale: 0.7, rdDelta: -4 },
];

export class Quality {
  level = 0;
  p90 = 0;
  private readonly times = new Float32Array(240);
  private n = 0;
  private head = 0;
  private acc = 0;
  private good = 0;
  private cooldown = 6;
  private readonly sorted = new Float32Array(240);
  /** when an upgrade fails, wait longer before trying that level again */
  private readonly blockedUntil = new Float64Array(LEVELS.length);
  private clock = 0;

  /** frame interval in ms; returns true when the level changed */
  update(ms: number, dt: number): boolean {
    this.clock += dt;
    if (ms > 250) return false; // tab switch, breakpoint etc.
    this.times[this.head] = ms;
    this.head = (this.head + 1) % this.times.length;
    this.n = Math.min(this.n + 1, this.times.length);
    this.acc += dt;
    if (this.cooldown > 0) this.cooldown -= dt;
    if (this.acc < 0.5) return false;
    this.acc = 0;
    // p90 over (roughly) the last 2 seconds
    let total = 0;
    let k = 0;
    for (let i = 0; i < this.n && total < 2000; i++) {
      const v = this.times[(this.head - 1 - i + this.times.length) % this.times.length];
      this.sorted[k++] = v;
      total += v;
    }
    const arr = this.sorted.subarray(0, k).sort();
    this.p90 = arr[Math.min(k - 1, Math.floor(k * 0.9))];
    if (this.cooldown > 0) return false;
    // degrade only when >10% of frames miss a 60 Hz vsync (occasional hitches are fine for a viewer)
    if (this.p90 > 24 && k > 20) {
      if (this.level < LEVELS.length - 1) {
        this.blockedUntil[this.level] = this.clock + 120;
        this.level++;
        this.cooldown = 4;
        this.good = 0;
        return true;
      }
    } else if (this.p90 < 17.5) {
      this.good += 0.5;
      if (this.good > 20 && this.level > 0 && this.clock > this.blockedUntil[this.level - 1]) {
        this.level--;
        this.cooldown = 6;
        this.good = 0;
        return true;
      }
    } else {
      this.good = 0;
    }
    return false;
  }

  get current(): QualityLevel {
    return LEVELS[this.level];
  }
}

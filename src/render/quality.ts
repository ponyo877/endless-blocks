// Frame pacing and adaptive quality.
//
// - dt is rounded to whole display refresh periods. rAF timestamps jitter by about a millisecond, and
//   the camera would otherwise advance unevenly from one displayed frame to the next (judder).
// - A rendered frame that arrives later than its target refresh is a miss. Irregular frame times read
//   as stutter far more than a lower but steady rate, so when misses pile up the pacer first renders
//   only every 2nd (3rd, ...) refresh, down to about 30 fps, and only then lowers render scale and
//   render distance. Each step back up is a trial; a failed trial waits twice as long next time.

export interface QualityLevel {
  /** render every div-th display refresh */
  div: number;
  scale: number;
  rdDelta: number;
}

const QUALITY: Omit<QualityLevel, 'div'>[] = [
  { scale: 1, rdDelta: 0 },
  { scale: 0.85, rdDelta: 0 },
  { scale: 0.85, rdDelta: -2 },
  { scale: 0.7, rdDelta: -2 },
  { scale: 0.7, rdDelta: -4 },
];
// display refresh rates the period estimate snaps to. 30 Hz is left out on purpose: slow frames on a
// 60 Hz display also arrive every 33 ms, and must not be mistaken for the display rate.
const RATES = [48, 50, 60, 72, 75, 85, 90, 100, 120, 144, 165, 240];
const MISS_WINDOW = 150;

export class Pacer {
  /** estimated display refresh period in ms */
  period = 1000 / 60;
  level = 0;
  /** share of recent rendered frames that missed their refresh */
  missRate = 0;
  /** interval between the last two rendered frames (ms) */
  lastInterval = 0;
  private levels: QualityLevel[] = [];
  private readonly cbIv = new Float32Array(120);
  private cbN = 0;
  private cbHead = 0;
  private cbSinceEstimate = 0;
  private lastCb = -1;
  private higher = 0;
  private lastRender = -1;
  private readonly miss = new Uint8Array(MISS_WINDOW);
  private missHead = 0;
  private missN = 0;
  private acc = 0;
  private cooldown = 3;
  private good = 0;
  private clock = 0;
  private blockedUntil: number[] = [];
  private blockFor: number[] = [];

  constructor() {
    this.buildLevels();
  }

  get current(): QualityLevel {
    return this.levels[this.level];
  }

  get levelCount(): number {
    return this.levels.length;
  }

  /** frame-rate steps down to ~30 fps, then quality steps at that rate; keeps the current frame interval */
  private buildLevels(oldPeriod = this.period): void {
    const old = this.levels[this.level];
    const maxDiv = Math.max(1, Math.floor(34 / this.period));
    const lv: QualityLevel[] = [];
    for (let d = 1; d <= maxDiv; d++) lv.push({ div: d, ...QUALITY[0] });
    for (let q = 1; q < QUALITY.length; q++) lv.push({ div: maxDiv, ...QUALITY[q] });
    this.levels = lv;
    if (old) {
      const q = QUALITY.findIndex((x) => x.scale === old.scale && x.rdDelta === old.rdDelta);
      const div = Math.min(maxDiv, Math.max(1, Math.round((old.div * oldPeriod) / this.period)));
      this.level = q > 0 ? maxDiv - 1 + q : div - 1;
    }
    this.blockedUntil = lv.map(() => 0);
    this.blockFor = lv.map(() => 60);
  }

  /** Call first in every rAF callback. Returns false when this refresh should not be rendered. */
  begin(now: number, active: boolean): boolean {
    if (this.lastCb >= 0) {
      const iv = now - this.lastCb;
      if (iv > 2 && iv < 100) {
        this.cbIv[this.cbHead] = iv;
        this.cbHead = (this.cbHead + 1) % this.cbIv.length;
        this.cbN = Math.min(this.cbN + 1, this.cbIv.length);
      }
      if (++this.cbSinceEstimate >= 60 && this.cbN >= 60) {
        this.cbSinceEstimate = 0;
        this.estimatePeriod();
      }
    }
    this.lastCb = now;
    if (!active || this.lastRender < 0) return true;
    const div = this.current.div;
    return div === 1 || now - this.lastRender > (div - 0.5) * this.period;
  }

  /**
   * rAF only fires as fast as frames finish, so callback intervals overstate the refresh period while
   * frames are slow. The estimate snaps to known rates, drops at once when faster callbacks show up,
   * and rises only when both the lower quartile and the median agree on a slower rate for a while
   * (e.g. the window moved to a slower display).
   */
  private estimatePeriod(): void {
    const a = Array.from(this.cbIv.subarray(0, this.cbN)).sort((x, y) => x - y);
    const snap = (v: number): number => {
      for (const hz of RATES) if (Math.abs(v - 1000 / hz) < (1000 / hz) * 0.04) return 1000 / hz;
      return 0;
    };
    const lo = snap(a[a.length >> 2]);
    const mid = snap(a[a.length >> 1]);
    let p = this.period;
    if (lo && lo < this.period * 0.96) {
      p = lo;
      this.higher = 0;
    } else if (lo && lo > this.period * 1.04 && mid === lo) {
      if (++this.higher >= 3) p = lo;
    } else {
      this.higher = 0;
    }
    if (p !== this.period) {
      const old = this.period;
      this.period = p;
      this.higher = 0;
      this.buildLevels(old);
    }
  }

  /** dt in seconds for the frame about to be rendered: elapsed time rounded to whole refresh periods */
  frameDt(now: number): number {
    const raw = this.lastRender < 0 ? this.period : now - this.lastRender;
    this.lastRender = now;
    this.lastInterval = raw;
    const n = Math.max(1, Math.round(raw / this.period));
    return Math.min(0.1, (n * this.period) / 1000);
  }

  /** Account the rendered frame. Returns true when the level changed. */
  update(dt: number): boolean {
    const raw = this.lastInterval;
    if (raw > 250) return false; // tab switch, breakpoint etc.
    this.clock += dt;
    if (this.cooldown > 0) this.cooldown -= dt;
    const target = this.current.div * this.period;
    this.miss[this.missHead] = raw > target + this.period * 0.5 ? 1 : 0;
    this.missHead = (this.missHead + 1) % MISS_WINDOW;
    this.missN = Math.min(this.missN + 1, MISS_WINDOW);
    this.acc += dt;
    if (this.acc < 0.5) return false;
    this.acc = 0;
    let m = 0;
    for (let i = 0; i < this.missN; i++) m += this.miss[i];
    this.missRate = m / Math.max(1, this.missN);
    if (this.cooldown > 0 || this.missN < 30) return false;
    if (this.missRate > 0.1) {
      if (this.level < this.levels.length - 1) {
        // the level we leave failed: try it again later, and wait longer each time it fails
        this.blockedUntil[this.level] = this.clock + this.blockFor[this.level];
        this.blockFor[this.level] = Math.min(600, this.blockFor[this.level] * 2);
        this.setLevel(this.level + 1);
        return true;
      }
    } else if (this.missRate < 0.02) {
      this.good += 0.5;
      if (this.good >= 15 && this.level > 0 && this.clock >= this.blockedUntil[this.level - 1]) {
        this.setLevel(this.level - 1);
        return true;
      }
    } else {
      this.good = 0;
    }
    return false;
  }

  private setLevel(l: number): void {
    this.level = l;
    this.cooldown = 3;
    this.good = 0;
    this.missN = 0;
    this.missHead = 0;
  }
}

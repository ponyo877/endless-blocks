// Main-thread log of committed path samples (1 per block of arc length). Append-only.

export class PathLog {
  private xs = new Float64Array(1 << 14);
  private ys = new Float64Array(1 << 14);
  private zs = new Float64Array(1 << 14);
  length = 0;

  append(s0: number, x: Float64Array, y: Float64Array, z: Float64Array): void {
    if (s0 !== this.length) {
      // out of order (should not happen) — ignore duplicates
      if (s0 + x.length <= this.length) return;
    }
    const n = s0 + x.length;
    if (n > this.xs.length) {
      let cap = this.xs.length;
      while (cap < n) cap *= 2;
      const grow = (a: Float64Array) => {
        const b = new Float64Array(cap);
        b.set(a.subarray(0, this.length));
        return b;
      };
      this.xs = grow(this.xs);
      this.ys = grow(this.ys);
      this.zs = grow(this.zs);
    }
    this.xs.set(x, s0);
    this.ys.set(y, s0);
    this.zs.set(z, s0);
    this.length = n;
  }

  /** max valid s (exclusive upper bound for interpolation) */
  get end(): number {
    return Math.max(0, this.length - 1);
  }

  sample(s: number, out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    const max = this.length - 1;
    if (max < 0) {
      out.x = out.y = out.z = 0;
      return out;
    }
    if (s <= 0) s = 0;
    if (s >= max) s = max;
    const i = Math.min(max - 1, Math.floor(s));
    const f = max > 0 ? s - i : 0;
    const j = Math.min(max, i + 1);
    out.x = this.xs[i] + (this.xs[j] - this.xs[i]) * f;
    out.y = this.ys[i] + (this.ys[j] - this.ys[i]) * f;
    out.z = this.zs[i] + (this.zs[j] - this.zs[i]) * f;
    return out;
  }
}

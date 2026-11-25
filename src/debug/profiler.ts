// Frame profiler for ?bench runs: per-frame interval, per-phase CPU time, uploads, draw stats,
// long tasks and heap drops (GC). Nothing is recorded unless a run is active.

export const PHASES = ['pre', 'env', 'stream', 'upload', 'sky', 'render', 'post'] as const;
const NP = PHASES.length;
const CAP = 20000;

interface MemPerf {
  memory?: { usedJSHeapSize: number };
}

function pct(a: Float32Array, n: number, p: number): number {
  if (n === 0) return 0;
  const s = Array.from(a.subarray(0, n)).sort((x, y) => x - y);
  return s[Math.min(n - 1, Math.floor(n * p))];
}
const r1 = (v: number) => Math.round(v * 10) / 10;

export class Profiler {
  recording = false;
  private n = 0;
  private readonly interval = new Float32Array(CAP);
  private readonly cpu = new Float32Array(CAP);
  private readonly phase = new Float32Array(CAP * NP);
  private readonly uploads = new Uint8Array(CAP);
  private readonly upBytes = new Float32Array(CAP);
  private readonly calls = new Float32Array(CAP);
  private readonly tris = new Float32Array(CAP);
  private readonly gpu = new Float32Array(CAP);
  private readonly marks = new Float64Array(NP + 1);
  private lastHeap = 0;
  private heapDrops = 0;
  private heapDropMB = 0;
  private heapStart = 0;
  private longN = 0;
  private longMs = 0;
  private longMax = 0;
  private t0 = 0;

  constructor() {
    try {
      new PerformanceObserver((list) => {
        if (!this.recording) return;
        for (const e of list.getEntries()) {
          this.longN++;
          this.longMs += e.duration;
          this.longMax = Math.max(this.longMax, e.duration);
        }
      }).observe({ type: 'longtask', buffered: false });
    } catch {
      /* not supported */
    }
  }

  start(): void {
    this.n = 0;
    this.heapDrops = 0;
    this.heapDropMB = 0;
    this.longN = 0;
    this.longMs = 0;
    this.longMax = 0;
    this.heapStart = this.heap();
    this.lastHeap = this.heapStart;
    this.t0 = performance.now();
    this.recording = true;
  }

  private heap(): number {
    return ((performance as unknown as MemPerf).memory?.usedJSHeapSize ?? 0) / 1048576;
  }

  /** mark the start of phase i (i = PHASES.length marks the end of the frame) */
  mark(i: number): void {
    this.marks[i] = performance.now();
  }

  endFrame(intervalMs: number, uploads: number, bytes: number, calls: number, tris: number, gpuMs: number): void {
    this.mark(NP);
    if (!this.recording || this.n >= CAP) return;
    const k = this.n++;
    this.interval[k] = intervalMs;
    this.cpu[k] = this.marks[NP] - this.marks[0];
    for (let i = 0; i < NP; i++) this.phase[k * NP + i] = this.marks[i + 1] - this.marks[i];
    this.uploads[k] = uploads;
    this.upBytes[k] = bytes;
    this.calls[k] = calls;
    this.tris[k] = tris;
    this.gpu[k] = gpuMs;
    const h = this.heap();
    if (h < this.lastHeap - 1) {
      this.heapDrops++;
      this.heapDropMB += this.lastHeap - h;
    }
    this.lastHeap = h;
  }

  summary(): Record<string, unknown> {
    this.recording = false;
    const n = this.n;
    const secs = (performance.now() - this.t0) / 1000;
    const iv = this.interval;
    let gt20 = 0, gt33 = 0, gt50 = 0, gt100 = 0;
    for (let i = 0; i < n; i++) {
      const v = iv[i];
      if (v > 20) gt20++;
      if (v > 33.4) gt33++;
      if (v > 50) gt50++;
      if (v > 100) gt100++;
    }
    const phases: Record<string, unknown> = {};
    const tmp = new Float32Array(n);
    for (let p = 0; p < NP; p++) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        tmp[i] = this.phase[i * NP + p];
        sum += tmp[i];
      }
      phases[PHASES[p]] = { avg: Math.round((sum / Math.max(1, n)) * 100) / 100, p99: r1(pct(tmp, n, 0.99)), max: r1(pct(tmp, n, 1)) };
    }
    // frames with / without uploads
    const up: number[] = [];
    const noUp: number[] = [];
    let bytes = 0;
    let upCpu = 0;
    for (let i = 0; i < n; i++) {
      if (this.uploads[i] > 0) {
        up.push(iv[i]);
        bytes += this.upBytes[i];
        upCpu += this.phase[i * NP + 3];
      } else noUp.push(iv[i]);
    }
    const q = (a: number[], p: number) => {
      if (!a.length) return 0;
      const s = a.slice().sort((x, y) => x - y);
      return r1(s[Math.min(s.length - 1, Math.floor(s.length * p))]);
    };
    let calls = 0;
    let tris = 0;
    for (let i = 0; i < n; i++) {
      calls += this.calls[i];
      tris += this.tris[i];
    }
    const res: Record<string, unknown> = {
      frames: n,
      seconds: r1(secs),
      fps: r1(n / secs),
      interval: { p50: r1(pct(iv, n, 0.5)), p90: r1(pct(iv, n, 0.9)), p99: r1(pct(iv, n, 0.99)), max: r1(pct(iv, n, 1)) },
      hitches: { gt20, gt33, gt50, gt100 },
      cpu: { p50: r1(pct(this.cpu, n, 0.5)), p90: r1(pct(this.cpu, n, 0.9)), p99: r1(pct(this.cpu, n, 0.99)), max: r1(pct(this.cpu, n, 1)) },
      phases,
      uploads: {
        frames: up.length,
        avgKB: Math.round(bytes / Math.max(1, up.length) / 1024),
        avgCpuMs: Math.round((upCpu / Math.max(1, up.length)) * 100) / 100,
        intervalP90With: q(up, 0.9),
        intervalP90Without: q(noUp, 0.9),
      },
      draw: { calls: Math.round(calls / Math.max(1, n)), ktris: Math.round(tris / Math.max(1, n) / 1000) },
      heap: { startMB: Math.round(this.heapStart), endMB: Math.round(this.heap()), gcDrops: this.heapDrops, gcMB: Math.round(this.heapDropMB) },
      longtasks: { n: this.longN, ms: Math.round(this.longMs), max: Math.round(this.longMax) },
    };
    let g = 0;
    for (let i = 0; i < n; i++) g += this.gpu[i];
    if (g > 0) res.gpuSync = { p50: r1(pct(this.gpu, n, 0.5)), p90: r1(pct(this.gpu, n, 0.9)), max: r1(pct(this.gpu, n, 1)) };
    return res;
  }
}

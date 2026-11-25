// URL parameters & constants.
export interface Config {
  seed: number;
  speed: number;
  renderDistance: number;
  dayLength: number; // seconds per full day
  debug: boolean;
  startTime: number; // 0..1 time of day at start (0 = sunrise)
  /** profiling run length in seconds (0 = off): fixed weather/time, no adaptive quality */
  bench: number;
  /** bench: wait for the GPU after each frame to measure GPU time (distorts pipelining) */
  gpuSync: boolean;
  /** compute worker count override (0 = auto) */
  workers: number;
  /** comma separated experiment switches for profiling (e.g. "nochunks,noclouds") */
  exp: Set<string>;
}

function num(p: URLSearchParams, k: string, d: number): number {
  const v = p.get(k);
  if (v === null || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export function readConfig(): Config {
  const p = new URLSearchParams(location.search);
  let seed = num(p, 'seed', NaN);
  if (!Number.isFinite(seed)) seed = Math.floor(Math.random() * 2147483647);
  return {
    seed: Math.floor(seed) >>> 0,
    speed: num(p, 'speed', 8),
    renderDistance: Math.max(4, Math.min(24, Math.floor(num(p, 'rd', 12)))),
    dayLength: Math.max(60, num(p, 'daylen', 1200)),
    debug: p.has('debug'),
    startTime: num(p, 'time', 0.08),
    bench: p.has('bench') ? Math.max(5, num(p, 'bench', 30) || 30) : 0,
    gpuSync: p.has('gpusync'),
    workers: Math.max(0, Math.min(16, Math.floor(num(p, 'workers', 0)))),
    exp: new Set((p.get('exp') ?? '').split(',').filter(Boolean)),
  };
}

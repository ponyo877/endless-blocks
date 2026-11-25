// URL parameters & constants.
export interface Config {
  seed: number;
  speed: number;
  renderDistance: number;
  dayLength: number; // seconds per full day
  debug: boolean;
  startTime: number; // 0..1 time of day at start (0 = sunrise)
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
  };
}

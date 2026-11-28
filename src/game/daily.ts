// Daily world: everyone gets the same seed for a UTC day.

/** YYYY-MM-DD of a date in UTC */
export function dayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** FNV-1a hash of "daily-" + day, as a world seed */
export function dailySeed(day = dayKey()): number {
  let h = 0x811c9dc5;
  const s = `daily-${day}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 2147483647;
}

/** milliseconds until the next UTC midnight */
export function msUntilNextDay(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now;
}

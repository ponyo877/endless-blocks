import { describe, expect, it } from 'vitest';
import { Pacer } from '../src/render/quality';

/**
 * Drives a pacer with rAF callbacks at the display rate. `cost(t)` is how many refreshes a rendered
 * frame occupies (1 = fits in one refresh). Returns the rendered frames' dt values in ms.
 */
function simulate(p: Pacer, hz: number, seconds: number, cost: (t: number) => number, jitter = 0, t0 = 0): number[] {
  const period = 1000 / hz;
  const dts: number[] = [];
  let busyUntil = -1;
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  for (let k = 0; k * period < seconds * 1000; k++) {
    const t = t0 + k * period;
    if (t < busyUntil) continue; // main thread still busy: no callback this refresh
    const now = t + jitter * rnd();
    if (!p.begin(now, true)) continue;
    const dt = p.frameDt(now);
    dts.push(dt * 1000);
    p.update(dt);
    busyUntil = t + cost(t) * period - 0.5;
  }
  return dts;
}

describe('Pacer', () => {
  it('quantises jittery 60 Hz timestamps to whole refresh periods', () => {
    const p = new Pacer();
    const dts = simulate(p, 60, 10, () => 1, 1.2);
    for (const d of dts.slice(1)) expect(d).toBeCloseTo(1000 / 60, 6);
    expect(p.level).toBe(0);
  });

  it('halves the frame rate before touching quality when frames take two refreshes', () => {
    const p = new Pacer();
    simulate(p, 60, 30, () => 2);
    expect(p.period).toBeCloseTo(1000 / 60, 3);
    expect(p.current.div).toBe(2);
    expect(p.current.scale).toBe(1);
    expect(p.current.rdDelta).toBe(0);
  });

  it('lowers quality only when even every other refresh is missed', () => {
    const p = new Pacer();
    simulate(p, 60, 40, () => 3);
    expect(p.current.div).toBe(2);
    expect(p.current.scale).toBeLessThan(1);
  });

  it('finds a 120 Hz display and steps 120 -> 60 fps under load', () => {
    const p = new Pacer();
    simulate(p, 120, 5, () => 1);
    expect(p.period).toBeCloseTo(1000 / 120, 3);
    const dts = simulate(p, 120, 20, () => 2, 0, 5000);
    // steady 60 fps at full quality (as div 2 of 120 Hz, or as the period re-estimated at 60 Hz)
    for (const d of dts.slice(-300)) expect(d).toBeCloseTo(1000 / 60, 3);
    expect(p.current.div * p.period).toBeCloseTo(1000 / 60, 3);
    expect(p.current.scale).toBe(1);
    // and back to 120 Hz once frames are cheap again
    simulate(p, 120, 120, () => 1, 0, 25000);
    expect(p.period).toBeCloseTo(1000 / 120, 3);
    expect(p.current.div).toBe(1);
  });

  it('returns to the full rate after the load is gone', () => {
    const p = new Pacer();
    simulate(p, 60, 20, () => 2);
    expect(p.current.div).toBe(2);
    simulate(p, 60, 120, () => 1, 0, 20000);
    expect(p.level).toBe(0);
  });
});

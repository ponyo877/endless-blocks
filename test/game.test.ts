import { describe, expect, it } from 'vitest';
import { B, Coll, COLL } from '../src/gen/blocks';
import { HEIGHT } from '../src/gen/constants';
import { datan2, dcos, dsin } from '../src/gen/dmath';
import { CollisionChunk, encodeCollision } from '../src/mesh/collision';
import { RA, RC, RW } from '../src/mesh/region';
import { DT, GameState, type GameEvent, RULES, SIDE_DOWN, SIDE_LEFT, SIDE_RIGHT, SIDE_UP, step, type TickInput } from '../src/game/sim';
import { type Nearest, type RayHit, type VoxelSource, nearest, overlaps, ray } from '../src/game/voxels';

/** a synthetic world: a set of solid blocks, plus an optional floor/water level */
class TestWorld implements VoxelSource {
  readonly blocks = new Map<string, number>();
  constructor(readonly floor = -1000, readonly water = -1000) {}
  set(x: number, y: number, z: number, c: number = Coll.SOLID): this {
    this.blocks.set(`${x},${y},${z}`, c);
    return this;
  }
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: number = Coll.SOLID): this {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.set(x, y, z, c);
    return this;
  }
  classAt(x: number, y: number, z: number): number {
    if (y <= this.floor) return Coll.SOLID;
    if (y <= this.water) return Coll.LIQUID;
    return this.blocks.get(`${x},${y},${z}`) ?? Coll.PASS;
  }
}

const idle: TickInput = { sx: 0, sy: 0, boost: 0 };

function fly(w: VoxelSource, s: GameState, ticks: number, input: TickInput | ((s: GameState) => TickInput) = idle): GameEvent[] {
  const ev: GameEvent[] = [];
  for (let i = 0; i < ticks && s.alive; i++) step(s, typeof input === 'function' ? input(s) : input, w, ev);
  return ev;
}

describe('dmath', () => {
  it('matches Math within 1e-12', () => {
    for (let i = 0; i < 5000; i++) {
      const x = (i - 2500) * 0.37;
      expect(Math.abs(dsin(x) - Math.sin(x))).toBeLessThan(1e-12);
      expect(Math.abs(dcos(x) - Math.cos(x))).toBeLessThan(1e-12);
      const y = Math.sin(i) * 3;
      const z = Math.cos(i * 1.7) * 3;
      expect(Math.abs(datan2(y, z) - Math.atan2(y, z))).toBeLessThan(1e-12);
    }
  });
});

describe('collision encoding', () => {
  it('round-trips the classes of the centre chunk', () => {
    const H = 100;
    const region = new Uint8Array(RA * H);
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const ids = [B.AIR, B.STONE, B.WATER, B.OAK_LEAVES, B.SHORT_GRASS, B.LAVA, B.SNOW_LAYER];
    for (let y = 0; y < H; y++) {
      for (let z = 0; z < RW; z++) {
        for (let x = 0; x < RW; x++) {
          // stone below 32, a mixed band, then air
          region[y * RA + z * RW + x] = y < 32 ? B.STONE : y < 70 ? ids[Math.floor(rnd() * ids.length)] : B.AIR;
        }
      }
    }
    const enc = encodeCollision(region, H);
    // sections 0 and 1 are uniform stone, 2..4 packed, the rest air
    expect(enc[0]).toBe(Coll.SOLID);
    expect(enc[1]).toBe(Coll.SOLID);
    expect(enc.length).toBe(20 + 3 * 1024);
    const c = new CollisionChunk(enc);
    for (let y = 0; y < HEIGHT; y++) {
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          const id = y < H ? region[y * RA + (z + RC) * RW + x + RC] : B.AIR;
          expect(c.at(x, y, z)).toBe(COLL[id]);
        }
      }
    }
  });

  it('classifies blocks for flying', () => {
    expect(COLL[B.STONE]).toBe(Coll.SOLID);
    expect(COLL[B.OAK_LOG]).toBe(Coll.SOLID);
    expect(COLL[B.OAK_LEAVES]).toBe(Coll.LEAVES);
    expect(COLL[B.WATER]).toBe(Coll.LIQUID);
    expect(COLL[B.KELP]).toBe(Coll.LIQUID);
    expect(COLL[B.SHORT_GRASS]).toBe(Coll.PASS);
    expect(COLL[B.SNOW_LAYER]).toBe(Coll.PASS);
    expect(COLL[B.CACTUS]).toBe(Coll.SOLID);
  });
});

describe('voxel queries', () => {
  const w = new TestWorld(-1).set(5, 10, 5);
  it('finds the nearest box surface', () => {
    const n: Nearest = { dist: 0, cls: 0, x: 0, y: 0, z: 0 };
    nearest(w, 5.5, 12.5, 5.5, 4, n);
    expect(n.dist).toBeCloseTo(1.5, 9);
    nearest(w, 7, 10.5, 5.5, 4, n);
    expect(n.dist).toBeCloseTo(1, 9);
    nearest(w, 5.5, 30, 5.5, 4, n);
    expect(n.dist).toBe(Infinity);
  });
  it('treats the water surface as 14/16 of a block', () => {
    const sea = new TestWorld(-100, 62);
    const n: Nearest = { dist: 0, cls: 0, x: 0, y: 0, z: 0 };
    nearest(sea, 0.5, 64, 0.5, 4, n);
    expect(n.cls).toBe(Coll.LIQUID);
    expect(n.dist).toBeCloseTo(64 - 62.875, 9);
  });
  it('detects sphere overlap and casts rays', () => {
    expect(overlaps(w, 5.5, 11.2, 5.5, 0.3)).toBe(Coll.SOLID);
    expect(overlaps(w, 5.5, 11.4, 5.5, 0.3)).toBe(0);
    const h: RayHit = { dist: 0, cls: 0 };
    ray(w, 5.5, 14, 5.5, 0, -1, 0, 10, h);
    expect(h.dist).toBeCloseTo(3, 9);
    ray(w, 0.5, 10.5, 5.5, 1, 0, 0, 10, h);
    expect(h.dist).toBeCloseTo(4.5, 9);
  });
});

describe('game simulation', () => {
  it('never skips through a one-block pillar, even at top speed', () => {
    for (let k = 0; k < 20; k++) {
      // pillar straight ahead (-z), glider centre within the pillar's width at a random offset
      const off = (k / 20) * 0.9 + 0.05;
      const w = new TestWorld(-1).box(0, 0, -60, 0, 40, -60);
      const s = new GameState({ x: off, y: 20.5, z: 0, yaw: 0 });
      s.speed = 80;
      fly(w, s, 600, { sx: 0, sy: 0, boost: 1 });
      expect(s.alive).toBe(false);
      expect(s.cause).toBe('crash');
      expect(s.z).toBeGreaterThan(-60 + 0.0);
    }
  });

  it('is deterministic: the same inputs give bit-identical states', () => {
    const run = () => {
      const w = new TestWorld(10).box(-30, 11, -400, -6, 30, 0).box(6, 11, -400, 30, 30, 0);
      const s = new GameState({ x: 0.5, y: 13, z: 0, yaw: 0 });
      let seed = 3;
      fly(w, s, 900, () => {
        seed = (seed * 48271) % 2147483647;
        return { sx: (seed % 255) - 127, sy: ((seed >> 8) % 61) - 30, boost: (seed >> 4) & 1 };
      });
      return [s.x, s.y, s.z, s.yaw, s.pitch, s.speed, s.score, s.chain, s.lift, s.tick];
    };
    expect(run()).toEqual(run());
  });

  it('scores grazing a floor, boxes in a canyon and a tube, and banks the chain', () => {
    // flat floor 1.5 blocks below: one side
    const floor = new TestWorld(10);
    const a = new GameState({ x: 0.5, y: 12.5, z: 0, yaw: 0 });
    fly(floor, a, 60);
    expect(a.alive).toBe(true);
    expect(a.sides).toBe(SIDE_DOWN);
    expect(a.encMult).toBe(1);
    expect(a.chain).toBeGreaterThan(0);

    // canyon: a 2-block gap, walls 1 block to each side of the glider's centre
    const canyon = new TestWorld(10).box(-10, 11, -2000, -1, 40, 10).box(2, 11, -2000, 10, 40, 10);
    const b = new GameState({ x: 1, y: 12.5, z: 0, yaw: 0 });
    const ev = fly(canyon, b, 120);
    expect(b.sides).toBe(SIDE_DOWN | SIDE_LEFT | SIDE_RIGHT);
    expect(b.encMult).toBe(3);
    expect(ev.some((e) => e.kind === 'thread')).toBe(true);

    // tube: add a roof
    const tube = new TestWorld(10).box(-10, 11, -2000, -1, 40, 10).box(2, 11, -2000, 10, 40, 10).box(-1, 15, -2000, 2, 16, 10);
    const c = new GameState({ x: 1, y: 12.5, z: 0, yaw: 0 });
    const ev2 = fly(tube, c, 150);
    expect(c.sides).toBe(SIDE_UP | SIDE_DOWN | SIDE_LEFT | SIDE_RIGHT);
    expect(c.encMult).toBe(4);
    expect(ev2.some((e) => e.kind === 'tube')).toBe(true);
    // canyon earns more per second than the open floor, the tube more still
    expect(c.chain).toBeGreaterThan(b.chain * 0.9);
    expect(b.chain).toBeGreaterThan(a.chain * 2);

    // climbing away banks the chain after a second of clear air
    const before = a.score;
    const pending = a.chain;
    const ev3 = fly(floor, a, 200, (s) => ({ sx: 0, sy: s.y < 30 ? 127 : -40, boost: 0 }));
    expect(ev3.some((e) => e.kind === 'bank')).toBe(true);
    expect(a.chain).toBe(0);
    expect(a.score).toBeGreaterThan(before + pending);
  });

  it('loses the running chain on a crash', () => {
    const w = new TestWorld(10).box(-5, 11, -40, 5, 40, -40);
    const s = new GameState({ x: 0.5, y: 12.5, z: 0, yaw: 0 });
    fly(w, s, 30);
    expect(s.chain).toBeGreaterThan(0);
    const banked = s.score;
    fly(w, s, 600);
    expect(s.alive).toBe(false);
    expect(s.chain).toBe(0);
    expect(s.finalScore).toBeLessThanOrEqual(Math.floor(banked + 60));
  });

  it('drains lift in open air until the glider stalls and falls', () => {
    const w = new TestWorld(-1);
    const s = new GameState({ x: 0.5, y: 250, z: 0, yaw: 0 });
    const ev = fly(w, s, Math.ceil(30 / DT));
    expect(ev.some((e) => e.kind === 'stall')).toBe(true);
    expect(s.alive).toBe(false);
    // ~100 / 6 s of flight, then up to stallTimeout of falling (or a crash into the ground)
    expect(s.time).toBeGreaterThan(14);
    expect(s.time).toBeLessThan(100 / RULES.liftDrain0 + RULES.stallTimeout + 1);
  });

  it('refills lift while grazing', () => {
    const w = new TestWorld(10);
    const s = new GameState({ x: 0.5, y: 11.6, z: 0, yaw: 0 });
    s.lift = 50;
    fly(w, s, 120);
    expect(s.alive).toBe(true);
    expect(s.lift).toBeGreaterThan(50);
  });
});

describe('replays', () => {
  it('pack and gzip round-trip the inputs exactly', async () => {
    const { packInputs, unpackInputs, encodeReplay, decodeReplay } = await import('../src/game/replay');
    const inputs: TickInput[] = [];
    let seed = 11;
    for (let i = 0; i < 3000; i++) {
      seed = (seed * 48271) % 2147483647;
      inputs.push({ sx: (seed % 255) - 127, sy: ((seed >> 3) % 255) - 127, boost: (seed >> 9) & 1 });
    }
    expect(unpackInputs(packInputs(inputs))).toEqual(inputs);
    expect(await decodeReplay(await encodeReplay(inputs))).toEqual(inputs);
  });

  it('re-flies a run over generated terrain to the same result', async () => {
    const { simulateRun } = await import('../src/game/replay');
    const { GenVoxels } = await import('../src/game/genVoxels');
    // fly low over a real world, weaving, until something is hit
    const spawn = { x: 100.5, y: 120, z: 100.5, yaw: 0.3 };
    const inputs: TickInput[] = [];
    for (let i = 0; i < 60 * 40; i++) inputs.push({ sx: Math.round(60 * Math.sin(i / 50)), sy: i < 120 ? -90 : Math.round(-20 + 40 * Math.sin(i / 70)), boost: (i >> 7) & 1 });
    const a = simulateRun(spawn, inputs, new GenVoxels(4242));
    const b = simulateRun(spawn, inputs, new GenVoxels(4242));
    expect(a.tick).toBe(b.tick);
    expect(a.score).toBe(b.score);
    expect([a.x, a.y, a.z]).toEqual([b.x, b.y, b.z]);
  });
});

import { B, REPLACEABLE, isLeaves } from '../blocks';
import { Rng } from '../rng';
import { dcos, dsin } from '../dmath';

// Tree & large-feature builders. Every builder draws its shape parameters from the rng FIRST
// (in params()), so extent() can compute bounds without building — the planner uses that.

export const Tree = {
  OAK: 0,
  FANCY_OAK: 1,
  BIRCH: 2,
  TALL_BIRCH: 3,
  SPRUCE: 4,
  PINE: 5,
  JUNGLE: 6,
  MEGA_JUNGLE: 7,
  JUNGLE_BUSH: 8,
  ACACIA: 9,
  DARK_OAK: 10,
  CHERRY: 11,
  SWAMP_OAK: 12,
  RED_MUSHROOM: 13,
  BROWN_MUSHROOM: 14,
  ICE_SPIKE: 15,
  BOULDER: 16,
} as const;

export interface Placement {
  type: number;
  x: number;
  y: number;
  z: number;
  seed: number;
}

export interface Writer {
  get(x: number, y: number, z: number): number;
  set(x: number, y: number, z: number, id: number): void;
}

/** maximum horizontal radius any tree can reach from its origin (for neighbour-chunk culling) */
export const MAX_TREE_RADIUS = 8;

interface Params {
  h: number;
  r: number;
  a: number;
  b: number;
  dir: number;
}

function params(type: number, rng: Rng): Params {
  switch (type) {
    case Tree.OAK: return { h: rng.irange(4, 6), r: 2, a: 0, b: 0, dir: 0 };
    case Tree.FANCY_OAK: return { h: rng.irange(9, 14), r: 6, a: rng.irange(3, 5), b: 0, dir: 0 };
    case Tree.BIRCH: return { h: rng.irange(5, 7), r: 2, a: 0, b: 0, dir: 0 };
    case Tree.TALL_BIRCH: return { h: rng.irange(9, 13), r: 2, a: 0, b: 0, dir: 0 };
    case Tree.SPRUCE: return { h: rng.irange(6, 10), r: rng.irange(2, 3), a: rng.irange(1, 2), b: 0, dir: 0 };
    case Tree.PINE: return { h: rng.irange(16, 28), r: rng.irange(3, 4), a: 0, b: 0, dir: 0 };
    case Tree.JUNGLE: return { h: rng.irange(5, 10), r: 2, a: 0, b: 0, dir: 0 };
    case Tree.MEGA_JUNGLE: return { h: rng.irange(16, 30), r: 7, a: rng.irange(2, 4), b: 0, dir: 0 };
    case Tree.JUNGLE_BUSH: return { h: 1, r: 2, a: rng.irange(2, 3), b: 0, dir: 0 };
    case Tree.ACACIA: return { h: rng.irange(5, 7), r: 6, a: rng.irange(1, 3), b: rng.irange(1, 3), dir: rng.int(4) };
    case Tree.DARK_OAK: return { h: rng.irange(6, 9), r: 5, a: 0, b: 0, dir: 0 };
    case Tree.CHERRY: return { h: rng.irange(5, 7), r: 7, a: rng.irange(2, 4), b: rng.int(2), dir: rng.int(4) };
    case Tree.SWAMP_OAK: return { h: rng.irange(5, 7), r: 3, a: 0, b: 0, dir: 0 };
    case Tree.RED_MUSHROOM: return { h: rng.irange(5, 8), r: 3, a: 0, b: 0, dir: 0 };
    case Tree.BROWN_MUSHROOM: return { h: rng.irange(5, 8), r: 4, a: 0, b: 0, dir: 0 };
    case Tree.ICE_SPIKE: {
      const tall = rng.chance(0.08);
      return { h: tall ? rng.irange(28, 46) : rng.irange(8, 18), r: tall ? 4 : rng.irange(2, 3), a: 0, b: 0, dir: 0 };
    }
    case Tree.BOULDER: return { h: 2, r: rng.irange(1, 2), a: 0, b: 0, dir: 0 };
    default: return { h: 5, r: 2, a: 0, b: 0, dir: 0 };
  }
}

/** bounds-only: highest block y (inclusive) and horizontal radius */
export function extent(p: Placement): { top: number; radius: number } {
  const rng = new Rng(p.seed);
  const k = params(p.type, rng);
  let extra = 1;
  switch (p.type) {
    case Tree.SPRUCE: extra = 2; break;
    case Tree.PINE: extra = 2; break;
    case Tree.FANCY_OAK: extra = 3; break;
    case Tree.MEGA_JUNGLE: extra = 3; break;
    case Tree.ACACIA: extra = k.a + 2; break;
    case Tree.DARK_OAK: extra = 2; break;
    case Tree.CHERRY: extra = k.a + 4; break;
    case Tree.JUNGLE_BUSH: extra = k.a; break;
    case Tree.ICE_SPIKE: extra = 0; break;
    case Tree.BOULDER: extra = 1; break;
    case Tree.RED_MUSHROOM: extra = 1; break;
    case Tree.BROWN_MUSHROOM: extra = 1; break;
  }
  return { top: p.y + k.h + extra, radius: k.r + 1 };
}

const DIRS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

function setLog(w: Writer, x: number, y: number, z: number, id: number): void {
  const cur = w.get(x, y, z);
  if (REPLACEABLE[cur] || isLeaves(cur) || cur === B.SNOW_LAYER) w.set(x, y, z, id);
}

function setLeaf(w: Writer, x: number, y: number, z: number, id: number): void {
  const cur = w.get(x, y, z);
  if (REPLACEABLE[cur] && cur !== B.WATER) w.set(x, y, z, id);
}

function blob(w: Writer, rng: Rng, cx: number, cy: number, cz: number, r: number, ry: number, id: number, fuzz = 0.6): void {
  const R = Math.ceil(r);
  const RY = Math.ceil(ry);
  for (let dy = -RY; dy <= RY; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        const d = (dx * dx + dz * dz) / (r * r) + (dy * dy) / (ry * ry);
        if (d <= 1 - rng.next() * fuzz * 0.35) setLeaf(w, cx + dx, cy + dy, cz + dz, id);
      }
    }
  }
}

function hangVine(w: Writer, rng: Rng, x: number, y: number, z: number, maxLen: number): void {
  // place a vine hanging down from (x,y,z) if attached to a leaf/log on one side
  const sides: [number, number, number][] = [
    [0, -1, B.VINE_N],
    [0, 1, B.VINE_S],
    [1, 0, B.VINE_E],
    [-1, 0, B.VINE_W],
  ];
  // draw from the rng unconditionally so the sequence never depends on (chunk-local) block content
  const len = 1 + rng.int(maxLen);
  for (const [dx, dz, id] of sides) {
    const n = w.get(x + dx, y, z + dz);
    if (isLeaves(n) || n === B.JUNGLE_LOG || n === B.OAK_LOG) {
      for (let k = 0; k < len; k++) {
        if (w.get(x, y - k, z) !== B.AIR) break;
        w.set(x, y - k, z, id);
      }
      return;
    }
  }
}

function classicCanopy(w: Writer, rng: Rng, x: number, y: number, z: number, h: number, leaf: number, wide = 2): void {
  for (let dy = h - 3; dy <= h; dy++) {
    const top = dy >= h - 1;
    const r = top ? 1 : wide;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const corner = Math.abs(dx) === r && Math.abs(dz) === r;
        if (corner && (dy === h || rng.chance(0.55))) continue;
        setLeaf(w, x + dx, y + dy, z + dz, leaf);
      }
    }
  }
}

function trunk(w: Writer, x: number, y: number, z: number, h: number, log: number, size = 1): void {
  for (let dx = 0; dx < size; dx++) {
    for (let dz = 0; dz < size; dz++) {
      const below = w.get(x + dx, y - 1, z + dz);
      if (below === B.GRASS || below === B.GRASS_SNOWY || below === B.PODZOL || below === B.MYCELIUM) w.set(x + dx, y - 1, z + dz, B.DIRT);
      for (let i = 0; i < h; i++) setLog(w, x + dx, y + i, z + dz, log);
    }
  }
}

export function buildTree(p: Placement, w: Writer): void {
  const rng = new Rng(p.seed);
  const k = params(p.type, rng);
  const { x, y, z } = p;
  switch (p.type) {
    case Tree.OAK:
    case Tree.BIRCH:
    case Tree.TALL_BIRCH:
    case Tree.JUNGLE: {
      const log = p.type === Tree.JUNGLE ? B.JUNGLE_LOG : p.type === Tree.OAK ? B.OAK_LOG : B.BIRCH_LOG;
      const leaf = p.type === Tree.JUNGLE ? B.JUNGLE_LEAVES : p.type === Tree.OAK ? B.OAK_LEAVES : B.BIRCH_LEAVES;
      trunk(w, x, y, z, k.h, log);
      classicCanopy(w, rng, x, y, z, k.h, leaf);
      if (p.type === Tree.JUNGLE) {
        for (let i = 0; i < 6; i++) hangVine(w, rng, x + rng.irange(-3, 3), y + k.h - 2, z + rng.irange(-3, 3), 4);
      }
      break;
    }
    case Tree.SWAMP_OAK: {
      trunk(w, x, y, z, k.h, B.OAK_LOG);
      for (let dy = k.h - 3; dy <= k.h; dy++) {
        const r = dy >= k.h - 1 ? 2 : 3;
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            if (Math.abs(dx) === r && Math.abs(dz) === r) continue;
            setLeaf(w, x + dx, y + dy, z + dz, B.OAK_LEAVES);
          }
        }
      }
      for (let i = 0; i < 10; i++) {
        const dx = rng.irange(-4, 4);
        const dz = rng.irange(-4, 4);
        hangVine(w, rng, x + dx, y + k.h - 3 - rng.int(1), z + dz, 5);
      }
      break;
    }
    case Tree.FANCY_OAK: {
      const th = Math.floor(k.h * 0.75);
      trunk(w, x, y, z, th, B.OAK_LOG);
      const clusters: [number, number, number][] = [[x, y + k.h - 1, z]];
      for (let i = 0; i < k.a; i++) {
        const ang = rng.next() * Math.PI * 2;
        const len = rng.range(2, 4);
        const by = y + Math.floor(k.h * rng.range(0.45, 0.8));
        const ex = Math.round(x + dcos(ang) * len);
        const ez = Math.round(z + dsin(ang) * len);
        const ey = by + Math.round(len * 0.7);
        const steps = Math.ceil(len) + 1;
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          setLog(w, Math.round(x + (ex - x) * t), Math.round(by + (ey - by) * t), Math.round(z + (ez - z) * t), B.OAK_LOG);
        }
        clusters.push([ex, ey, ez]);
      }
      for (let i = th; i < k.h - 1; i++) setLog(w, x, y + i, z, B.OAK_LOG);
      for (const [cx, cy, cz] of clusters) blob(w, rng, cx, cy + 1, cz, 2.6, 1.8, B.OAK_LEAVES, 0.8);
      break;
    }
    case Tree.SPRUCE: {
      trunk(w, x, y, z, k.h, B.SPRUCE_LOG);
      // tip
      setLeaf(w, x, y + k.h, z, B.SPRUCE_LEAVES);
      setLeaf(w, x, y + k.h + 1, z, B.SPRUCE_LEAVES);
      let r = 0;
      let cap = 1;
      for (let dy = k.h; dy >= k.a; dy--) {
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            if (r > 0 && Math.abs(dx) + Math.abs(dz) > r + (r > 1 ? 1 : 0)) continue;
            setLeaf(w, x + dx, y + dy, z + dz, B.SPRUCE_LEAVES);
          }
        }
        if (r >= cap) {
          r = dy < k.h - 1 ? 1 : 0;
          cap = Math.min(cap + 1, k.r);
        } else r++;
      }
      break;
    }
    case Tree.PINE: {
      trunk(w, x, y, z, k.h, B.SPRUCE_LOG, 2);
      const crownStart = Math.floor(k.h * 0.55);
      for (let dy = crownStart; dy <= k.h + 1; dy++) {
        const t = (k.h + 1 - dy) / (k.h + 1 - crownStart);
        const ring = (k.h - dy) % 3 === 0 ? 1 : 0;
        const r = Math.max(0, t * k.r + ring * 0.6);
        const R = Math.ceil(r) + 1;
        for (let dx = -R; dx <= R + 1; dx++) {
          for (let dz = -R; dz <= R + 1; dz++) {
            const ddx = dx - 0.5;
            const ddz = dz - 0.5;
            if (ddx * ddx + ddz * ddz <= (r + 0.7) * (r + 0.7)) setLeaf(w, x + dx, y + dy, z + dz, B.SPRUCE_LEAVES);
          }
        }
      }
      break;
    }
    case Tree.MEGA_JUNGLE: {
      trunk(w, x, y, z, k.h, B.JUNGLE_LOG, 2);
      blob(w, rng, x + 0.5, y + k.h, z + 0.5, 4.5, 2.2, B.JUNGLE_LEAVES, 0.5);
      for (let i = 0; i < k.a; i++) {
        const d = DIRS[rng.int(4)];
        const by = y + Math.floor(k.h * rng.range(0.45, 0.8));
        const len = rng.irange(2, 4);
        let ex = x;
        let ez = z;
        for (let s = 1; s <= len; s++) {
          ex = x + (d[0] > 0 ? 1 : 0) + d[0] * s;
          ez = z + (d[1] > 0 ? 1 : 0) + d[1] * s;
          setLog(w, ex, by + Math.floor(s / 2), ez, B.JUNGLE_LOG);
        }
        blob(w, rng, ex, by + Math.floor(len / 2) + 1, ez, 2.5, 1.3, B.JUNGLE_LEAVES, 0.6);
      }
      for (let i = 0; i < 28; i++) {
        hangVine(w, rng, x + rng.irange(-5, 6), y + k.h - 1 - rng.int(3), z + rng.irange(-5, 6), 8);
      }
      // vines on trunk
      for (let i = 0; i < 6; i++) {
        const side = rng.int(4);
        const vy = y + rng.irange(2, k.h - 2);
        const len = rng.irange(2, 6);
        const vx = side === 0 ? x + 2 : side === 1 ? x - 1 : x + rng.int(2);
        const vz = side === 2 ? z + 2 : side === 3 ? z - 1 : z + rng.int(2);
        const id = side === 0 ? B.VINE_W : side === 1 ? B.VINE_E : side === 2 ? B.VINE_N : B.VINE_S;
        for (let kk = 0; kk < len; kk++) if (w.get(vx, vy - kk, vz) === B.AIR) w.set(vx, vy - kk, vz, id);
      }
      break;
    }
    case Tree.JUNGLE_BUSH: {
      setLog(w, x, y, z, B.JUNGLE_LOG);
      for (let dy = 0; dy <= k.a; dy++) {
        const r = k.a - dy;
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            if (Math.abs(dx) === r && Math.abs(dz) === r && r > 0 && rng.chance(0.6)) continue;
            setLeaf(w, x + dx, y + dy, z + dz, B.OAK_LEAVES);
          }
        }
      }
      break;
    }
    case Tree.ACACIA: {
      const d = DIRS[k.dir];
      const straight = k.h - k.a;
      trunk(w, x, y, z, straight, B.ACACIA_LOG);
      let tx = x;
      let tz = z;
      let ty = y + straight;
      for (let i = 0; i < k.a; i++) {
        tx += d[0];
        tz += d[1];
        setLog(w, tx, ty, tz, B.ACACIA_LOG);
        ty++;
      }
      const canopy = (cx: number, cy: number, cz: number) => {
        for (let dx = -3; dx <= 3; dx++) {
          for (let dz = -3; dz <= 3; dz++) {
            if (Math.abs(dx) === 3 && Math.abs(dz) === 3) continue;
            if (Math.abs(dx) + Math.abs(dz) > 5) continue;
            setLeaf(w, cx + dx, cy, cz + dz, B.ACACIA_LEAVES);
          }
        }
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) setLeaf(w, cx + dx, cy + 1, cz + dz, B.ACACIA_LEAVES);
        setLeaf(w, cx + 2, cy + 1, cz, B.ACACIA_LEAVES);
        setLeaf(w, cx - 2, cy + 1, cz, B.ACACIA_LEAVES);
        setLeaf(w, cx, cy + 1, cz + 2, B.ACACIA_LEAVES);
        setLeaf(w, cx, cy + 1, cz - 2, B.ACACIA_LEAVES);
      };
      canopy(tx, ty, tz);
      // second branch the other way
      if (k.b > 1) {
        const d2 = DIRS[(k.dir + 2) % 4];
        let bx = x;
        let bz = z;
        let by = y + straight - 1;
        for (let i = 0; i < k.b; i++) {
          bx += d2[0];
          bz += d2[1];
          by++;
          setLog(w, bx, by, bz, B.ACACIA_LOG);
        }
        canopy(bx, by + 1, bz);
      }
      break;
    }
    case Tree.DARK_OAK: {
      trunk(w, x, y, z, k.h, B.DARK_OAK_LOG, 2);
      const cx = x + 0.5;
      const cz = z + 0.5;
      for (let dy = k.h - 3; dy <= k.h + 1; dy++) {
        const r = dy <= k.h - 2 ? 3.6 : dy <= k.h ? 4.2 : 2.6;
        const R = Math.ceil(r) + 1;
        for (let dx = -R; dx <= R + 1; dx++) {
          for (let dz = -R; dz <= R + 1; dz++) {
            const ddx = x + dx - cx;
            const ddz = z + dz - cz;
            if (ddx * ddx + ddz * ddz <= r * r - rng.next() * 2) setLeaf(w, x + dx, y + dy, z + dz, B.DARK_OAK_LEAVES);
          }
        }
      }
      // short branches sticking out under the canopy
      for (let i = 0; i < 3; i++) {
        const d = DIRS[rng.int(4)];
        setLog(w, x + (d[0] > 0 ? 2 : d[0] < 0 ? -1 : rng.int(2)), y + k.h - 2, z + (d[1] > 0 ? 2 : d[1] < 0 ? -1 : rng.int(2)), B.DARK_OAK_LOG);
      }
      break;
    }
    case Tree.CHERRY: {
      trunk(w, x, y, z, k.h - 2, B.CHERRY_LOG);
      const branches = 1 + k.b;
      for (let bI = 0; bI < branches; bI++) {
        const d = DIRS[(k.dir + bI * 2) % 4];
        let bx = x;
        let bz = z;
        let by = y + k.h - 3;
        for (let i = 0; i < k.a; i++) {
          bx += d[0];
          bz += d[1];
          if (i % 2 === 1) by++;
          setLog(w, bx, by, bz, B.CHERRY_LOG);
        }
        by += 1;
        setLog(w, bx, by, bz, B.CHERRY_LOG);
        // wide dome with hanging fringe
        for (let dy = -1; dy <= 3; dy++) {
          const r = dy <= 0 ? 3.8 : dy === 1 ? 4.2 : dy === 2 ? 3.4 : 2.2;
          const R = Math.ceil(r);
          for (let dx = -R; dx <= R; dx++) {
            for (let dz = -R; dz <= R; dz++) {
              const dd = dx * dx + dz * dz;
              if (dd > r * r) continue;
              if (dy === -1 && dd < (r - 1.2) * (r - 1.2)) continue;
              if (dy === -1 && rng.chance(0.4)) continue;
              setLeaf(w, bx + dx, by + dy, bz + dz, B.CHERRY_LEAVES);
            }
          }
        }
        for (let i = 0; i < 8; i++) {
          const a = rng.next() * Math.PI * 2;
          const hx = Math.round(bx + dcos(a) * 3.4);
          const hz = Math.round(bz + dsin(a) * 3.4);
          const len = rng.irange(1, 2);
          for (let kk = 2; kk <= len + 1; kk++) setLeaf(w, hx, by - kk, hz, B.CHERRY_LEAVES);
        }
      }
      break;
    }
    case Tree.RED_MUSHROOM: {
      trunk(w, x, y, z, k.h, B.MUSHROOM_STEM);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) setLeaf(w, x + dx, y + k.h, z + dz, B.RED_MUSHROOM_BLOCK);
      for (let dy = k.h - 3; dy < k.h; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          for (let dz = -2; dz <= 2; dz++) {
            if (Math.abs(dx) < 2 && Math.abs(dz) < 2) continue;
            if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
            setLeaf(w, x + dx, y + dy, z + dz, B.RED_MUSHROOM_BLOCK);
          }
        }
      }
      break;
    }
    case Tree.BROWN_MUSHROOM: {
      trunk(w, x, y, z, k.h, B.MUSHROOM_STEM);
      for (let dx = -3; dx <= 3; dx++) {
        for (let dz = -3; dz <= 3; dz++) {
          if (Math.abs(dx) === 3 && Math.abs(dz) === 3) continue;
          setLeaf(w, x + dx, y + k.h, z + dz, B.BROWN_MUSHROOM_BLOCK);
        }
      }
      break;
    }
    case Tree.ICE_SPIKE: {
      for (let dy = -2; dy < k.h; dy++) {
        const t = Math.max(0, dy) / k.h;
        const r = k.r * (1 - t) * (1 - t * 0.2);
        const R = Math.ceil(r);
        for (let dx = -R; dx <= R; dx++) {
          for (let dz = -R; dz <= R; dz++) {
            if (dx * dx + dz * dz <= r * r + 0.3) {
              const cur = w.get(x + dx, y + dy, z + dz);
              if (REPLACEABLE[cur] || cur === B.SNOW || cur === B.GRASS_SNOWY || cur === B.DIRT || cur === B.SNOW_LAYER) {
                w.set(x + dx, y + dy, z + dz, B.PACKED_ICE);
              }
            }
          }
        }
      }
      break;
    }
    case Tree.BOULDER: {
      const r = k.r + 0.5;
      for (let dy = -1; dy <= k.r; dy++) {
        for (let dx = -k.r - 1; dx <= k.r + 1; dx++) {
          for (let dz = -k.r - 1; dz <= k.r + 1; dz++) {
            if (dx * dx + dz * dz + dy * dy * 1.4 <= r * r) {
              const mossy = rng.chance(0.75);
              const cur = w.get(x + dx, y + dy, z + dz);
              if (REPLACEABLE[cur] || isLeaves(cur) || cur === B.GRASS || cur === B.DIRT || cur === B.PODZOL || cur === B.COARSE_DIRT) {
                w.set(x + dx, y + dy, z + dz, mossy ? B.MOSSY_COBBLE : B.COBBLESTONE);
              }
            }
          }
        }
      }
      break;
    }
  }
}

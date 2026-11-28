import { Coll } from '../gen/blocks';
import { CHUNK, HEIGHT } from '../gen/constants';
import type { CollisionChunk } from '../mesh/collision';
import type { ChunkRenderer } from '../render/chunkRenderer';
import { ckey } from '../workers/protocol';

/** class returned for blocks in chunks that are not loaded yet */
export const UNKNOWN = -1;
/** height of a liquid block with no liquid above it (the visible water surface) */
export const LIQUID_TOP = 14 / 16;

/** integer block coordinates -> collision class (Coll.*) or UNKNOWN */
export interface VoxelSource {
  classAt(x: number, y: number, z: number): number;
}

/** collision classes of the chunks currently drawn by a ChunkRenderer ("what you see is what you hit") */
export class ChunkVoxels implements VoxelSource {
  private lastKey = NaN;
  private last: CollisionChunk | null = null;

  constructor(private readonly chunks: ChunkRenderer) {}

  private chunk(cx: number, cz: number): CollisionChunk | null {
    const k = ckey(cx, cz);
    if (k === this.lastKey && this.last) return this.last;
    const e = this.chunks.entries.get(k);
    const c = e ? e.coll : null;
    this.lastKey = k;
    this.last = c;
    return c;
  }

  classAt(x: number, y: number, z: number): number {
    if (y < 0) return Coll.SOLID;
    if (y >= HEIGHT) return Coll.PASS;
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    const c = this.chunk(cx, cz);
    if (!c) return UNKNOWN;
    return c.at(x - cx * CHUNK, y, z - cz * CHUNK);
  }

  /** is the chunk containing world (x, z) loaded with collision data? */
  loaded(x: number, z: number): boolean {
    return this.chunk(Math.floor(x / CHUNK), Math.floor(z / CHUNK)) !== null;
  }
}

/** top of the collision box of a block of class c (liquids end at the water surface) */
function blockTop(src: VoxelSource, x: number, y: number, z: number, c: number): number {
  if (c !== Coll.LIQUID) return y + 1;
  return src.classAt(x, y + 1, z) === Coll.LIQUID ? y + 1 : y + LIQUID_TOP;
}

export interface Nearest {
  /** distance from the point to the nearest collidable box (Infinity if none within range) */
  dist: number;
  cls: number;
  /** closest point on that box */
  x: number;
  y: number;
  z: number;
}

/**
 * Nearest collidable block surface within `range` of point p (scans the blocks in a cube around it).
 * Unknown blocks count as empty.
 */
export function nearest(src: VoxelSource, px: number, py: number, pz: number, range: number, out: Nearest): Nearest {
  out.dist = Infinity;
  out.cls = Coll.PASS;
  let best2 = range * range;
  const x0 = Math.floor(px - range);
  const x1 = Math.floor(px + range);
  const y0 = Math.floor(py - range);
  const y1 = Math.floor(py + range);
  const z0 = Math.floor(pz - range);
  const z1 = Math.floor(pz + range);
  for (let y = y0; y <= y1; y++) {
    const dy0 = py < y ? y - py : py > y + 1 ? py - y - 1 : 0; // lower bound on |dy| for this layer
    if (dy0 * dy0 >= best2) continue;
    for (let z = z0; z <= z1; z++) {
      const cz = pz < z ? z : pz > z + 1 ? z + 1 : pz;
      const dz = pz - cz;
      if (dy0 * dy0 + dz * dz >= best2) continue;
      for (let x = x0; x <= x1; x++) {
        const cx = px < x ? x : px > x + 1 ? x + 1 : px;
        const dx = px - cx;
        const dxz = dx * dx + dz * dz;
        if (dy0 * dy0 + dxz >= best2) continue;
        const c = src.classAt(x, y, z);
        if (c <= 0) continue;
        const top = blockTop(src, x, y, z, c);
        const cy = py < y ? y : py > top ? top : py;
        const dy = py - cy;
        const d2 = dxz + dy * dy;
        if (d2 < best2) {
          best2 = d2;
          out.dist = Math.sqrt(d2);
          out.cls = c;
          out.x = cx;
          out.y = cy;
          out.z = cz;
        }
      }
    }
  }
  return out;
}

/** does a sphere at p with radius r overlap any collidable block? returns the class hit (0 = none) */
export function overlaps(src: VoxelSource, px: number, py: number, pz: number, r: number): number {
  const r2 = r * r;
  const x0 = Math.floor(px - r);
  const x1 = Math.floor(px + r);
  const y0 = Math.floor(py - r);
  const y1 = Math.floor(py + r);
  const z0 = Math.floor(pz - r);
  const z1 = Math.floor(pz + r);
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const c = src.classAt(x, y, z);
        if (c <= 0) continue;
        const top = blockTop(src, x, y, z, c);
        const cx = px < x ? x : px > x + 1 ? x + 1 : px;
        const cy = py < y ? y : py > top ? top : py;
        const cz = pz < z ? z : pz > z + 1 ? z + 1 : pz;
        const dx = px - cx;
        const dy = py - cy;
        const dz = pz - cz;
        if (dx * dx + dy * dy + dz * dz < r2) return c;
      }
    }
  }
  return 0;
}

export interface RayHit {
  dist: number;
  cls: number;
}

/**
 * Distance along a unit direction to the first collidable block (voxel DDA), or maxD with cls 0.
 * Liquids count as full blocks here.
 */
export function ray(src: VoxelSource, px: number, py: number, pz: number, dx: number, dy: number, dz: number, maxD: number, out: RayHit): RayHit {
  let x = Math.floor(px);
  let y = Math.floor(py);
  let z = Math.floor(pz);
  const sx = dx > 0 ? 1 : -1;
  const sy = dy > 0 ? 1 : -1;
  const sz = dz > 0 ? 1 : -1;
  const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tx = dx !== 0 ? (dx > 0 ? x + 1 - px : px - x) * tdx : Infinity;
  let ty = dy !== 0 ? (dy > 0 ? y + 1 - py : py - y) * tdy : Infinity;
  let tz = dz !== 0 ? (dz > 0 ? z + 1 - pz : pz - z) * tdz : Infinity;
  let t = 0;
  for (let i = 0; i < 64; i++) {
    const c = src.classAt(x, y, z);
    if (c > 0) {
      out.dist = t;
      out.cls = c;
      return out;
    }
    if (tx < ty && tx < tz) {
      t = tx;
      x += sx;
      tx += tdx;
    } else if (ty < tz) {
      t = ty;
      y += sy;
      ty += tdy;
    } else {
      t = tz;
      z += sz;
      tz += tdz;
    }
    if (t > maxD) break;
  }
  out.dist = maxD;
  out.cls = 0;
  return out;
}

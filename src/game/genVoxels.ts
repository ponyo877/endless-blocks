import { COLL, Coll } from '../gen/blocks';
import { CHUNK, HEIGHT } from '../gen/constants';
import { type GenContext, createContext, generateChunk } from '../gen/generateChunk';
import type { VoxelSource } from './voxels';

/**
 * Collision classes straight from the world generator (no workers, no meshing), for replay
 * verification in Node and for tests. Gives the same classes the game sees in the browser.
 */
export class GenVoxels implements VoxelSource {
  private readonly ctx: GenContext;
  private readonly cache = new Map<string, Uint8Array>();
  private lastKey = '';
  private last: Uint8Array | null = null;

  constructor(seed: number) {
    this.ctx = createContext(seed);
  }

  classAt(x: number, y: number, z: number): number {
    if (y < 0) return Coll.SOLID;
    if (y >= HEIGHT) return Coll.PASS;
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    const k = `${cx},${cz}`;
    let b = k === this.lastKey ? this.last : null;
    if (!b) {
      b = this.cache.get(k) ?? null;
      if (!b) {
        b = generateChunk(this.ctx, cx, cz).blocks;
        this.cache.set(k, b);
      }
      this.lastKey = k;
      this.last = b;
    }
    return COLL[b[(y << 8) | ((z - cz * CHUNK) << 4) | (x - cx * CHUNK)]];
  }

  get chunksGenerated(): number {
    return this.cache.size;
  }
}

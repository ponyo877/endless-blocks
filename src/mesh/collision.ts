import { COLL } from '../gen/blocks';
import { CHUNK, SECTION, SECTIONS } from '../gen/constants';
import { RA, RC, RW } from './region';

// Collision classes of one chunk, 2 bits per block, for the game's main-thread queries.
//
// Layout: SECTIONS header bytes, one per 16-block section: 0..3 = the whole section is that class,
// PACKED = 1024 bytes of 2-bit classes follow (in section order), indexed like the chunk arrays,
// i = (y & 15) << 8 | z << 4 | x, four blocks per byte, lowest bits first.
// Most sections are all air or all stone, so a typical chunk is a few KB.

export const PACKED = 255;
const SEC_BYTES = (CHUNK * CHUNK * SECTION) / 4;

/** encode the centre chunk of a 48 x H x 48 mesh region */
export function encodeCollision(region: Uint8Array, H: number): Uint8Array {
  const header = new Uint8Array(SECTIONS);
  let packed = 0;
  for (let s = 0; s < SECTIONS; s++) {
    const y0 = s * SECTION;
    if (y0 >= H) continue; // air
    const y1 = Math.min(y0 + SECTION, H);
    const first = COLL[region[y0 * RA + RC * RW + RC]];
    let uniform = y1 === y0 + SECTION || first === 0; // a cut-off section is part air
    for (let y = y0; y < y1 && uniform; y++) {
      for (let z = 0; z < CHUNK && uniform; z++) {
        const row = y * RA + (z + RC) * RW + RC;
        for (let x = 0; x < CHUNK; x++) {
          if (COLL[region[row + x]] !== first) {
            uniform = false;
            break;
          }
        }
      }
    }
    if (uniform) header[s] = first;
    else {
      header[s] = PACKED;
      packed++;
    }
  }
  const out = new Uint8Array(SECTIONS + packed * SEC_BYTES);
  out.set(header);
  let off = SECTIONS;
  for (let s = 0; s < SECTIONS; s++) {
    if (header[s] !== PACKED) continue;
    const y0 = s * SECTION;
    const y1 = Math.min(y0 + SECTION, H);
    for (let y = y0; y < y1; y++) {
      for (let z = 0; z < CHUNK; z++) {
        const row = y * RA + (z + RC) * RW + RC;
        const base = ((y - y0) << 8) | (z << 4);
        for (let x = 0; x < CHUNK; x++) {
          const c = COLL[region[row + x]];
          if (c) {
            const i = base | x;
            out[off + (i >> 2)] |= c << ((i & 3) << 1);
          }
        }
      }
    }
    off += SEC_BYTES;
  }
  return out;
}

/** decoded view: class lookups in chunk-local coordinates */
export class CollisionChunk {
  /** per section: >= 0 byte offset of packed data, or -1 - class for a uniform section */
  private readonly sec = new Int32Array(SECTIONS);

  constructor(readonly data: Uint8Array) {
    let off = SECTIONS;
    for (let s = 0; s < SECTIONS; s++) {
      const h = data[s];
      if (h === PACKED) {
        this.sec[s] = off;
        off += SEC_BYTES;
      } else this.sec[s] = -1 - h;
    }
  }

  /** class at local x, z in [0, 16) and y in [0, HEIGHT) */
  at(x: number, y: number, z: number): number {
    const o = this.sec[y >> 4];
    if (o < 0) return -1 - o;
    const i = ((y & 15) << 8) | (z << 4) | x;
    return (this.data[o + (i >> 2)] >> ((i & 3) << 1)) & 3;
  }

  get bytes(): number {
    return this.data.byteLength;
  }
}

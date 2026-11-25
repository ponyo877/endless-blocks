import { EMIT, FILTER } from '../gen/blocks';
import { RA, RW } from './region';

// Sky light + block light flood fill over a 48 x H x 48 region. Output byte = sky<<4 | block.
// Light is never stored: the world is static, so it's recomputed per mesh job from the 3x3 blocks.

let queue = new Int32Array(1 << 16);

function ensureQueue(n: number): void {
  if (queue.length < n) queue = new Int32Array(1 << Math.ceil(Math.log2(n)));
}

export function computeLight(blocks: Uint8Array, H: number, out: Uint8Array): void {
  const N = RA * H;
  ensureQueue(N * 2);
  const qmask = queue.length - 1;
  out.fill(0, 0, N);

  // ---- sky light: straight down per column
  let maxTop = 0;
  for (let z = 0; z < RW; z++) {
    for (let x = 0; x < RW; x++) {
      let l = 15;
      const base = z * RW + x;
      for (let y = H - 1; y >= 0; y--) {
        const i = y * RA + base;
        const f = FILTER[blocks[i]];
        if (f !== 0) {
          if (y > maxTop) maxTop = y;
          if (f >= 15) break;
          l -= f;
          if (l <= 0) break;
        }
        out[i] = l << 4;
      }
    }
  }

  // ---- sky light: spread sideways from lit cells next to darker transparent cells
  let head = 0;
  let tail = 0;
  const yTop = Math.min(H - 1, maxTop + 1);
  for (let y = 0; y <= yTop; y++) {
    for (let z = 0; z < RW; z++) {
      for (let x = 0; x < RW; x++) {
        const i = y * RA + z * RW + x;
        const l = out[i] >> 4;
        if (l <= 1) continue;
        // a neighbour that could receive more light?
        if (
          (x > 0 && (out[i - 1] >> 4) < l - 1 && FILTER[blocks[i - 1]] < 15) ||
          (x < RW - 1 && (out[i + 1] >> 4) < l - 1 && FILTER[blocks[i + 1]] < 15) ||
          (z > 0 && (out[i - RW] >> 4) < l - 1 && FILTER[blocks[i - RW]] < 15) ||
          (z < RW - 1 && (out[i + RW] >> 4) < l - 1 && FILTER[blocks[i + RW]] < 15) ||
          (y > 0 && (out[i - RA] >> 4) < l - 1 && FILTER[blocks[i - RA]] < 15)
        ) {
          queue[tail++ & qmask] = i;
        }
      }
    }
  }
  while (head !== tail) {
    const i = queue[head++ & qmask];
    const l = out[i] >> 4;
    if (l <= 1) continue;
    const y = (i / RA) | 0;
    const r = i - y * RA;
    const z = (r / RW) | 0;
    const x = r - z * RW;
    for (let n = 0; n < 6; n++) {
      let j: number;
      if (n === 0) { if (x === 0) continue; j = i - 1; }
      else if (n === 1) { if (x === RW - 1) continue; j = i + 1; }
      else if (n === 2) { if (z === 0) continue; j = i - RW; }
      else if (n === 3) { if (z === RW - 1) continue; j = i + RW; }
      else if (n === 4) { if (y === 0) continue; j = i - RA; }
      else { if (y === H - 1) continue; j = i + RA; }
      const f = FILTER[blocks[j]];
      if (f >= 15) continue;
      const nl = l - 1 - f;
      if (nl > (out[j] >> 4)) {
        out[j] = (nl << 4) | (out[j] & 15);
        queue[tail++ & qmask] = j;
      }
    }
  }

  // ---- block light
  head = tail = 0;
  for (let i = 0; i < N; i++) {
    const e = EMIT[blocks[i]];
    if (e > 0) {
      out[i] = (out[i] & 0xf0) | e;
      queue[tail++ & qmask] = i;
    }
  }
  while (head !== tail) {
    const i = queue[head++ & qmask];
    const l = out[i] & 15;
    if (l <= 1) continue;
    const y = (i / RA) | 0;
    const r = i - y * RA;
    const z = (r / RW) | 0;
    const x = r - z * RW;
    for (let n = 0; n < 6; n++) {
      let j: number;
      if (n === 0) { if (x === 0) continue; j = i - 1; }
      else if (n === 1) { if (x === RW - 1) continue; j = i + 1; }
      else if (n === 2) { if (z === 0) continue; j = i - RW; }
      else if (n === 3) { if (z === RW - 1) continue; j = i + RW; }
      else if (n === 4) { if (y === 0) continue; j = i - RA; }
      else { if (y === H - 1) continue; j = i + RA; }
      const f = FILTER[blocks[j]];
      if (f >= 15) continue;
      const nl = l - 1 - f;
      if (nl > (out[j] & 15)) {
        out[j] = (out[j] & 0xf0) | nl;
        queue[tail++ & qmask] = j;
      }
    }
  }
}

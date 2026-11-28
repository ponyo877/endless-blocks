import { type GameEvent, GameState, type Spawn, step, type TickInput } from './sim';
import type { VoxelSource } from './voxels';

// Input logs ("replays"): one TickInput per simulation tick. Stored planar and delta-coded
// (all sx deltas, then all sy deltas, then boost bits), which gzip squeezes to a few KB a minute.

export function packInputs(inputs: readonly TickInput[]): Uint8Array {
  const n = inputs.length;
  const out = new Uint8Array(4 + n * 2 + Math.ceil(n / 8));
  new DataView(out.buffer).setUint32(0, n, true);
  let px = 0;
  let py = 0;
  for (let i = 0; i < n; i++) {
    const { sx, sy, boost } = inputs[i];
    out[4 + i] = (sx - px) & 255;
    out[4 + n + i] = (sy - py) & 255;
    px = sx;
    py = sy;
    if (boost) out[4 + 2 * n + (i >> 3)] |= 1 << (i & 7);
  }
  return out;
}

const s8 = (b: number) => (b > 127 ? b - 256 : b);

export function unpackInputs(bytes: Uint8Array): TickInput[] {
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (bytes.length !== 4 + n * 2 + Math.ceil(n / 8)) throw new Error('bad replay length');
  const out: TickInput[] = new Array(n);
  let px = 0;
  let py = 0;
  for (let i = 0; i < n; i++) {
    // deltas wrap in 8 bits; the values themselves are within [-127, 127]
    px = s8((px + bytes[4 + i]) & 255);
    py = s8((py + bytes[4 + n + i]) & 255);
    out[i] = { sx: px, sy: py, boost: (bytes[4 + 2 * n + (i >> 3)] >> (i & 7)) & 1 };
  }
  return out;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const res = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

export function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new CompressionStream('gzip'));
}

export function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new DecompressionStream('gzip'));
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function encodeReplay(inputs: readonly TickInput[]): Promise<string> {
  return toBase64(await gzip(packInputs(inputs)));
}

export async function decodeReplay(b64: string): Promise<TickInput[]> {
  return unpackInputs(await gunzip(fromBase64(b64)));
}

/** re-fly a run from its spawn and inputs; stops at the crash (or when the inputs run out) */
export function simulateRun(spawn: Spawn, inputs: readonly TickInput[], src: VoxelSource): GameState {
  const s = new GameState(spawn);
  const ev: GameEvent[] = [];
  for (let i = 0; i < inputs.length && s.alive; i++) {
    step(s, inputs[i], src, ev);
    ev.length = 0;
  }
  return s;
}

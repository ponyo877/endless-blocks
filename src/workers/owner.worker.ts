/// <reference lib="webworker" />
import { CHUNK_VOLUME, HEIGHT, SECTION, SECTIONS } from '../gen/constants';
import { RA, RW } from '../mesh/region';
import type { GenJob, GenResult, MeshDone, MeshJob, WantMsg } from './protocol';
import { ckey } from './protocol';

// Owns all voxel data. Schedules GEN jobs and LIGHT+MESH jobs on the compute workers,
// in the priority order main asks for. Main never touches voxels.

declare const self: DedicatedWorkerGlobalScope;

interface Rec {
  cx: number;
  cz: number;
  /** compressed sections: number = uniform id, Uint8Array(4096) otherwise; null = not generated */
  sections: (Uint8Array | number)[] | null;
  maxY: number;
  genInFlight: boolean;
}

interface Worker_ {
  port: MessagePort;
  inFlight: number;
}

const MAX_IN_FLIGHT = 2;
const workers: Worker_[] = [];
const recs = new Map<number, Rec>();
let want: Int32Array = new Int32Array(0);
let wantEpoch = 0;
let center = { cx: 0, cz: 0, keep: 20 };
const meshInFlight = new Set<number>();
/** chunks meshed recently -> time; main may not have received them yet, so don't re-mesh for a while */
const recentlyMeshed = new Map<number, number>();
const RECENT_MS = 2500;
let credits = 0;
let stats = { gen: 0, mesh: 0, genMs: 0, meshMs: 0 };

function rec(cx: number, cz: number): Rec {
  const k = ckey(cx, cz);
  let r = recs.get(k);
  if (!r) {
    r = { cx, cz, sections: null, maxY: 0, genInFlight: false };
    recs.set(k, r);
  }
  return r;
}

function compress(blocks: Uint8Array): { sections: (Uint8Array | number)[]; maxY: number } {
  const sections: (Uint8Array | number)[] = new Array(SECTIONS);
  let maxY = 0;
  for (let s = 0; s < SECTIONS; s++) {
    const off = s * SECTION * 256;
    const first = blocks[off];
    let uniform = true;
    for (let i = 1; i < 4096; i++) {
      if (blocks[off + i] !== first) {
        uniform = false;
        break;
      }
    }
    if (uniform) sections[s] = first;
    else sections[s] = blocks.slice(off, off + 4096);
    if (!uniform || first !== 0) maxY = (s + 1) * SECTION;
  }
  return { sections, maxY };
}

function copyInto(r: Rec, region: Uint8Array, H: number, ox: number, oz: number): void {
  const secs = r.sections!;
  for (let y = 0; y < H; y++) {
    const s = secs[y >> 4];
    const rowBase = y * RA + oz * RW + ox;
    if (typeof s === 'number') {
      if (s === 0) continue;
      for (let z = 0; z < 16; z++) region.fill(s, rowBase + z * RW, rowBase + z * RW + 16);
    } else {
      const sy = (y & 15) << 8;
      for (let z = 0; z < 16; z++) {
        const src = sy | (z << 4);
        region.set(s.subarray(src, src + 16), rowBase + z * RW);
      }
    }
  }
}

function neighboursReady(cx: number, cz: number): boolean {
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const r = recs.get(ckey(cx + dx, cz + dz));
      if (!r || !r.sections) return false;
    }
  }
  return true;
}

function idleWorker(): Worker_ | null {
  let best: Worker_ | null = null;
  for (const w of workers) {
    if (w.inFlight < MAX_IN_FLIGHT && (!best || w.inFlight < best.inFlight)) best = w;
  }
  return best;
}

function dispatchGen(cx: number, cz: number): boolean {
  const w = idleWorker();
  if (!w) return false;
  const r = rec(cx, cz);
  r.genInFlight = true;
  w.inFlight++;
  const job: GenJob = { type: 'gen', cx, cz };
  w.port.postMessage(job);
  return true;
}

function dispatchMesh(cx: number, cz: number): boolean {
  const w = idleWorker();
  if (!w) return false;
  let maxY = 0;
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) maxY = Math.max(maxY, recs.get(ckey(cx + dx, cz + dz))!.maxY);
  const H = Math.min(HEIGHT, maxY + 2);
  const region = new Uint8Array(RA * H);
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      copyInto(recs.get(ckey(cx + dx, cz + dz))!, region, H, (dx + 1) * 16, (dz + 1) * 16);
    }
  }
  w.inFlight++;
  meshInFlight.add(ckey(cx, cz));
  credits--;
  const job: MeshJob = { type: 'mesh', cx, cz, H, region, epoch: wantEpoch };
  w.port.postMessage(job, [region.buffer]);
  return true;
}

function schedule(): void {
  if (!idleWorker()) return;
  const n = want.length >> 1;
  // first pass: mesh jobs that are ready, in priority order; gen jobs for what's missing
  for (let i = 0; i < n; i++) {
    const cx = want[i * 2];
    const cz = want[i * 2 + 1];
    const k = ckey(cx, cz);
    if (meshInFlight.has(k)) continue;
    const rt = recentlyMeshed.get(k);
    if (rt !== undefined && performance.now() - rt < RECENT_MS) continue;
    if (neighboursReady(cx, cz)) {
      if (credits <= 0) continue;
      if (!dispatchMesh(cx, cz)) return;
      continue;
    }
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const r = rec(cx + dx, cz + dz);
        if (r.sections || r.genInFlight) continue;
        if (!dispatchGen(cx + dx, cz + dz)) return;
      }
    }
  }
}

function evict(): void {
  const { cx, cz, keep } = center;
  for (const [k, r] of recs) {
    if (r.genInFlight) continue;
    if (Math.max(Math.abs(r.cx - cx), Math.abs(r.cz - cz)) > keep) recs.delete(k);
  }
}

function onWorkerMessage(w: Worker_, e: MessageEvent): void {
  const d = e.data as GenResult | MeshDone;
  w.inFlight--;
  if (d.type === 'gen') {
    const r = rec(d.cx, d.cz);
    r.genInFlight = false;
    const c = compress(d.blocks);
    r.sections = c.sections;
    r.maxY = c.maxY;
    stats.gen++;
    stats.genMs += d.ms;
  } else {
    meshInFlight.delete(ckey(d.cx, d.cz));
    recentlyMeshed.set(ckey(d.cx, d.cz), performance.now());
    stats.mesh++;
    stats.meshMs += d.ms;
  }
  schedule();
}

self.onmessage = (e: MessageEvent) => {
  const d = e.data;
  switch (d.type) {
    case 'init': {
      for (const port of d.ports as MessagePort[]) {
        const w: Worker_ = { port, inFlight: 0 };
        port.onmessage = (ev) => onWorkerMessage(w, ev);
        workers.push(w);
      }
      credits = d.credits ?? 24;
      break;
    }
    case 'want': {
      const m = d as WantMsg;
      want = m.list;
      wantEpoch = m.epoch;
      const now = performance.now();
      for (const [k, t] of recentlyMeshed) if (now - t > RECENT_MS) recentlyMeshed.delete(k);
      center = { cx: m.ccx, cz: m.ccz, keep: m.keep };
      evict();
      schedule();
      break;
    }
    case 'credit': {
      credits += d.n;
      schedule();
      break;
    }
    case 'stats': {
      self.postMessage({ type: 'stats', chunks: recs.size, ...stats, credits, inFlight: workers.reduce((a, w) => a + w.inFlight, 0) });
      break;
    }
  }
};

export {};
void CHUNK_VOLUME;

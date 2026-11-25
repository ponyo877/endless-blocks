/// <reference lib="webworker" />
import { BIOMES, biomeFoliage, biomeGrass } from '../gen/climate';
import { CELL_XZ, CHUNK } from '../gen/constants';
import { GenContext, createContext, generateChunk } from '../gen/generateChunk';
import { computeLight } from '../mesh/light';
import { buildMesh } from '../mesh/mesher';
import { RA, RC, RW } from '../mesh/region';
import type { GenJob, GenResult, MeshDone, MeshJob, MeshResult } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let ctx: GenContext | null = null;
let ownerPort: MessagePort | null = null;
let lightBuf = new Uint8Array(0);

// per-biome colours, precomputed
const GRASS = BIOMES.map((b) => biomeGrass(b));
const FOLIAGE = BIOMES.map((b) => biomeFoliage(b));
const WATER = BIOMES.map((b) => b.water);

function computeTints(wx0: number, wz0: number, out: Uint8Array): void {
  const t = ctx!.terrain;
  // lattice points covering [wx0-4, wx0+20], each blended over its 3x3 lattice neighbourhood
  const ix0 = Math.floor(wx0 / CELL_XZ) - 1;
  const iz0 = Math.floor(wz0 / CELL_XZ) - 1;
  const N = 7;
  const g = new Float32Array(N * N * 9);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      let r0 = 0, g0 = 0, b0 = 0, r1 = 0, g1 = 0, b1 = 0, r2 = 0, g2 = 0, b2 = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const c = t.corner(ix0 + i + dx, iz0 + j + dz);
          const b = c.biome;
          // grass gets cooler (bluer) with altitude like mountain meadows
          const gr = GRASS[b];
          const fo = FOLIAGE[b];
          const wa = WATER[b];
          r0 += gr[0]; g0 += gr[1]; b0 += gr[2];
          r1 += fo[0]; g1 += fo[1]; b1 += fo[2];
          r2 += wa[0]; g2 += wa[1]; b2 += wa[2];
        }
      }
      const o = (j * N + i) * 9;
      g[o] = r0 / 9; g[o + 1] = g0 / 9; g[o + 2] = b0 / 9;
      g[o + 3] = r1 / 9; g[o + 4] = g1 / 9; g[o + 5] = b1 / 9;
      g[o + 6] = r2 / 9; g[o + 7] = g2 / 9; g[o + 8] = b2 / 9;
    }
  }
  for (let z = 0; z < CHUNK; z++) {
    for (let x = 0; x < CHUNK; x++) {
      const wx = wx0 + x;
      const wz = wz0 + z;
      const fx = wx / CELL_XZ - ix0;
      const fz = wz / CELL_XZ - iz0;
      const i0 = Math.floor(fx);
      const j0 = Math.floor(fz);
      const tx = fx - i0;
      const tz = fz - j0;
      const o = (z * 16 + x) * 9;
      for (let k = 0; k < 9; k++) {
        const a = g[(j0 * N + i0) * 9 + k];
        const b = g[(j0 * N + i0 + 1) * 9 + k];
        const c = g[((j0 + 1) * N + i0) * 9 + k];
        const d = g[((j0 + 1) * N + i0 + 1) * 9 + k];
        out[o + k] = Math.round((a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz);
      }
    }
  }
}

const tints = new Uint8Array(256 * 9);

function doGen(job: GenJob): void {
  const t0 = performance.now();
  const c = generateChunk(ctx!, job.cx, job.cz);
  const res: GenResult = {
    type: 'gen', cx: job.cx, cz: job.cz, blocks: c.blocks, heights: c.heights, topIds: c.topIds, biomes: c.biomes,
    ms: performance.now() - t0,
  };
  ownerPort!.postMessage(res, [c.blocks.buffer, c.heights.buffer, c.topIds.buffer, c.biomes.buffer]);
}

function doMesh(job: MeshJob): void {
  const t0 = performance.now();
  const { H, region, cx, cz } = job;
  if (lightBuf.length < RA * H) lightBuf = new Uint8Array(RA * 320);
  computeLight(region, H, lightBuf);
  const wx0 = cx * CHUNK;
  const wz0 = cz * CHUNK;
  computeTints(wx0, wz0, tints);
  const m = buildMesh({ blocks: region, light: lightBuf, H, tints, seed: ctx!.seed, wx0, wz0 });
  // column summary of the centre chunk
  const heights = new Int16Array(256);
  const topIds = new Uint8Array(256);
  const biomes = new Uint8Array(256);
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      let y = H - 1;
      const base = (z + RC) * RW + x + RC;
      while (y >= 0 && region[y * RA + base] === 0) y--;
      heights[z * 16 + x] = y;
      topIds[z * 16 + x] = y >= 0 ? region[y * RA + base] : 0;
      biomes[z * 16 + x] = ctx!.terrain.biomeAt(wx0 + x, wz0 + z);
    }
  }
  const res: MeshResult = {
    type: 'mesh', cx, cz, epoch: job.epoch,
    opaque: m.opaque, cutout: m.cutout, translucent: m.translucent, leaves: m.leaves, minY: m.minY, maxY: m.maxY,
    heights, topIds, biomes,
  };
  self.postMessage(res, [m.opaque.buffer, m.cutout.buffer, m.translucent.buffer, m.leaves.buffer, heights.buffer, topIds.buffer, biomes.buffer]);
  const done: MeshDone = { type: 'meshDone', cx, cz, ms: performance.now() - t0 };
  ownerPort!.postMessage(done);
}

self.onmessage = (e: MessageEvent) => {
  const d = e.data;
  if (d.type === 'init') {
    ctx = createContext(d.seed);
    ownerPort = d.port as MessagePort;
    ownerPort.onmessage = (ev: MessageEvent) => {
      const job = ev.data as GenJob | MeshJob;
      if (job.type === 'gen') doGen(job);
      else doMesh(job);
    };
  }
};

/// <reference lib="webworker" />
import { CHUNK } from '../gen/constants';
import { GenContext, createContext, generateChunk } from '../gen/generateChunk';
import { computeLight } from '../mesh/light';
import { buildMesh } from '../mesh/mesher';
import { RA, RC, RW } from '../mesh/region';
import { computeTints } from '../mesh/tints';
import type { GenJob, GenResult, MeshDone, MeshJob, MeshResult } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let ctx: GenContext | null = null;
let ownerPort: MessagePort | null = null;
let lightBuf = new Uint8Array(0);

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
  computeTints(ctx!.terrain, wx0, wz0, tints);
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

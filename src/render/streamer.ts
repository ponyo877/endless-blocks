import * as THREE from 'three';
import { CHUNK } from '../gen/constants';
import type { MeshResult, WantMsg } from '../workers/protocol';
import { ckey } from '../workers/protocol';
import { ChunkRenderer } from './chunkRenderer';

export interface StreamerStats {
  chunks: number;
  gen: number;
  mesh: number;
  genMs: number;
  meshMs: number;
  credits: number;
  inFlight: number;
}

/**
 * Main-thread side of the chunk pipeline: spawns owner + compute workers, decides which chunks
 * we want meshes for (priority: distance to a look-ahead point, frustum, future path), and
 * feeds results into the ChunkRenderer under an upload budget.
 */
export class Streamer {
  readonly owner: Worker;
  readonly computes: Worker[] = [];
  radius: number;
  private epoch = 0;
  private lastWant = 0;
  private lastCx = 1e9;
  private lastCz = 1e9;
  stats: StreamerStats | null = null;
  private readonly frustum = new THREE.Frustum();
  private readonly m4 = new THREE.Matrix4();
  private readonly box = new THREE.Box3();
  /** extra points (future path) to prefetch around */
  prefetch: { x: number; z: number }[] = [];

  constructor(readonly seed: number, readonly renderer: ChunkRenderer, radius: number, workers = 0, collision = false) {
    this.radius = radius;
    const n = workers || Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 2));
    this.owner = new Worker(new URL('../workers/owner.worker.ts', import.meta.url), { type: 'module' });
    const ports: MessagePort[] = [];
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('../workers/compute.worker.ts', import.meta.url), { type: 'module' });
      const ch = new MessageChannel();
      w.postMessage({ type: 'init', seed, port: ch.port2, collision }, [ch.port2]);
      ports.push(ch.port1);
      w.onmessage = (e: MessageEvent) => {
        const d = e.data as MeshResult;
        if (d.type === 'mesh') this.renderer.enqueue(d);
      };
      this.computes.push(w);
    }
    this.owner.postMessage({ type: 'init', ports, credits: 32 }, ports);
    this.owner.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'stats') this.stats = e.data as StreamerStats;
    };
    renderer.onUploaded = (k) => this.owner.postMessage({ type: 'credit', n: k });
    setInterval(() => this.owner.postMessage({ type: 'stats' }), 1000);
  }

  get workerCount(): number {
    return this.computes.length;
  }

  inRange(cx: number, cz: number, ccx: number, ccz: number, r: number): boolean {
    const dx = cx - ccx;
    const dz = cz - ccz;
    return dx * dx + dz * dz <= r * r;
  }

  /**
   * Call every frame. `look` is a world-space point ahead of the camera along the flight path.
   */
  update(camera: THREE.PerspectiveCamera, look: THREE.Vector3, now: number): void {
    const ccx = Math.floor(camera.position.x / CHUNK);
    const ccz = Math.floor(camera.position.z / CHUNK);
    const R = this.radius;
    const moved = ccx !== this.lastCx || ccz !== this.lastCz;
    if (!moved && now - this.lastWant < 250) return;
    this.lastWant = now;
    this.lastCx = ccx;
    this.lastCz = ccz;

    const keepR = R + 2;
    this.renderer.prune((cx, cz) => this.inRange(cx, cz, ccx, ccz, keepR) || this.nearPrefetch(cx, cz, 2));

    camera.updateMatrixWorld();
    this.m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.m4);

    const lx = look.x / CHUNK;
    const lz = look.z / CHUNK;
    const cand: { cx: number; cz: number; s: number }[] = [];
    const seen = new Set<number>();
    const consider = (cx: number, cz: number, bias: number) => {
      const k = ckey(cx, cz);
      if (seen.has(k)) return;
      seen.add(k);
      if (this.renderer.has(cx, cz)) return;
      const dx = cx + 0.5 - lx;
      const dz = cz + 0.5 - lz;
      let s = Math.sqrt(dx * dx + dz * dz) + bias;
      this.box.min.set(cx * CHUNK, 0, cz * CHUNK);
      this.box.max.set(cx * CHUNK + CHUNK, 320, cz * CHUNK + CHUNK);
      if (!this.frustum.intersectsBox(this.box)) s = s * 2 + 4;
      cand.push({ cx, cz, s });
    };
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dz * dz > R * R) continue;
        consider(ccx + dx, ccz + dz, 0);
      }
    }
    // future path prefetch (small radius around upcoming points)
    for (const p of this.prefetch) {
      const pcx = Math.floor(p.x / CHUNK);
      const pcz = Math.floor(p.z / CHUNK);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) consider(pcx + dx, pcz + dz, R * 0.6);
    }
    cand.sort((a, b) => a.s - b.s);
    const list = new Int32Array(cand.length * 2);
    for (let i = 0; i < cand.length; i++) {
      list[i * 2] = cand[i].cx;
      list[i * 2 + 1] = cand[i].cz;
    }
    const msg: WantMsg = { type: 'want', list, ccx, ccz, keep: R + 4, epoch: ++this.epoch };
    this.owner.postMessage(msg, [list.buffer]);
  }

  private nearPrefetch(cx: number, cz: number, r: number): boolean {
    for (const p of this.prefetch) {
      if (Math.abs(Math.floor(p.x / CHUNK) - cx) <= r && Math.abs(Math.floor(p.z / CHUNK) - cz) <= r) return true;
    }
    return false;
  }

  dispose(): void {
    this.owner.terminate();
    for (const w of this.computes) w.terminate();
  }
}

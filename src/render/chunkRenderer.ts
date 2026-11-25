import * as THREE from 'three';
import { CHUNK } from '../gen/constants';
import type { MeshResult } from '../workers/protocol';
import { ckey } from '../workers/protocol';
import { TerrainUniforms, createTerrainMaterial } from './chunkMaterial';

export interface ChunkEntry {
  cx: number;
  cz: number;
  meshes: THREE.Mesh[];
  leaves: THREE.Mesh | null;
  plants: THREE.Mesh | null;
  near: boolean;
  plantsVisible: boolean;
  heights: Int16Array;
  topIds: Uint8Array;
  biomes: Uint8Array;
  maxY: number;
}

function disposeArray(this: THREE.BufferAttribute): void {
  (this as unknown as { array: unknown }).array = null;
}

/** Owns chunk meshes on the main thread: upload budget, manual bounds, disposal. */
export class ChunkRenderer {
  readonly group = new THREE.Group();
  readonly entries = new Map<number, ChunkEntry>();
  private readonly pending: MeshResult[] = [];
  private readonly materials: Record<'opaque' | 'cutout' | 'translucent' | 'leavesFast', THREE.RawShaderMaterial>;
  private lodX = 0;
  private lodZ = 0;
  private lodR = 96;
  private plantR = 160;
  private index: THREE.BufferAttribute;
  private indexQuads = 0;
  private readonly oldIndices: THREE.BufferAttribute[] = [];
  onUploaded: ((n: number) => void) | null = null;

  constructor(uniforms: TerrainUniforms) {
    this.materials = {
      opaque: createTerrainMaterial(uniforms, 'opaque'),
      cutout: createTerrainMaterial(uniforms, 'cutout'),
      translucent: createTerrainMaterial(uniforms, 'translucent'),
      leavesFast: createTerrainMaterial(uniforms, 'leavesFast'),
    };
    this.index = this.makeIndex(1 << 16);
    this.group.matrixAutoUpdate = false;
  }

  private makeIndex(quads: number): THREE.BufferAttribute {
    const idx = new Uint32Array(quads * 6);
    for (let q = 0; q < quads; q++) {
      const v = q * 4;
      const o = q * 6;
      idx[o] = v;
      idx[o + 1] = v + 1;
      idx[o + 2] = v + 2;
      idx[o + 3] = v + 2;
      idx[o + 4] = v + 3;
      idx[o + 5] = v;
    }
    this.indexQuads = quads;
    return new THREE.BufferAttribute(idx, 1);
  }

  has(cx: number, cz: number): boolean {
    return this.entries.has(ckey(cx, cz));
  }

  enqueue(res: MeshResult): void {
    this.pending.push(res);
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** upload at most `maxMeshes` chunks / `maxBytes` this frame */
  processUploads(maxMeshes: number, maxBytes: number, keep: (cx: number, cz: number) => boolean): number {
    let n = 0;
    let bytes = 0;
    let credits = 0;
    while (this.pending.length && n < maxMeshes && bytes < maxBytes) {
      const res = this.pending.shift()!;
      credits++;
      if (!keep(res.cx, res.cz)) continue;
      bytes += res.opaque.byteLength + res.cutout.byteLength + res.translucent.byteLength + res.leaves.byteLength;
      this.add(res);
      n++;
    }
    if (credits && this.onUploaded) this.onUploaded(credits);
    return n;
  }

  private add(res: MeshResult): void {
    const k = ckey(res.cx, res.cz);
    const old = this.entries.get(k);
    if (old) this.removeEntry(k, old);
    const meshes: THREE.Mesh[] = [];
    const x0 = res.cx * CHUNK;
    const z0 = res.cz * CHUNK;
    const minY = res.minY;
    const maxY = Math.max(res.maxY, minY + 1);
    const center = new THREE.Vector3(8, (minY + maxY) / 2, 8);
    const radius = Math.sqrt(8 * 8 * 2 + ((maxY - minY) / 2) ** 2) + 1;
    const pass = (data: Uint32Array, mat: THREE.RawShaderMaterial, order: number): THREE.Mesh | null => {
      if (data.length === 0) return null;
      const quads = data.length / 12;
      if (quads > this.indexQuads) {
        this.oldIndices.push(this.index);
        this.index = this.makeIndex(1 << Math.ceil(Math.log2(quads)));
      }
      const g = new THREE.BufferGeometry();
      const attr = new THREE.BufferAttribute(data, 3);
      attr.onUpload(disposeArray);
      g.setAttribute('data', attr);
      g.setIndex(this.index);
      g.setDrawRange(0, quads * 6);
      g.boundingSphere = new THREE.Sphere(center.clone(), radius);
      g.boundingBox = new THREE.Box3(new THREE.Vector3(0, minY, 0), new THREE.Vector3(16, maxY, 16));
      const mesh = new THREE.Mesh(g, mat);
      mesh.position.set(x0, 0, z0);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.updateMatrixWorld(true);
      mesh.renderOrder = order;
      this.group.add(mesh);
      meshes.push(mesh);
      return mesh;
    };
    pass(res.opaque, this.materials.opaque, 0);
    const plants = pass(res.cutout, this.materials.cutout, 1);
    pass(res.translucent, this.materials.translucent, 2);
    const leaves = pass(res.leaves, this.materials.leavesFast, 0);
    const entry: ChunkEntry = {
      cx: res.cx, cz: res.cz, meshes, leaves, plants, near: false, plantsVisible: true, heights: res.heights, topIds: res.topIds, biomes: res.biomes, maxY,
    };
    this.applyLod(entry);
    this.entries.set(k, entry);
  }

  private applyLod(e: ChunkEntry): void {
    const dx = e.cx * CHUNK + 8 - this.lodX;
    const dz = e.cz * CHUNK + 8 - this.lodZ;
    const d2 = dx * dx + dz * dz;
    // small plants vanish into the fog anyway; skip their draw far away
    const pv = d2 < this.plantR * this.plantR;
    if (e.plants && pv !== e.plantsVisible) {
      e.plantsVisible = pv;
      e.plants.visible = pv;
    }
    if (!e.leaves) return;
    const near = d2 < this.lodR * this.lodR;
    if (near === e.near) return;
    e.near = near;
    e.leaves.material = near ? this.materials.cutout : this.materials.leavesFast;
    e.leaves.renderOrder = near ? 1 : 0;
  }

  /** leaves within r blocks of (x,z) are alpha-tested, the rest drawn solid */
  updateLod(x: number, z: number, r: number, plantR: number): void {
    this.lodX = x;
    this.lodZ = z;
    this.lodR = r;
    this.plantR = plantR;
    for (const e of this.entries.values()) this.applyLod(e);
  }

  private removeEntry(k: number, e: ChunkEntry): void {
    for (const m of e.meshes) {
      this.group.remove(m);
      m.geometry.setIndex(null); // shared index must survive
      m.geometry.dispose();
    }
    this.entries.delete(k);
  }

  remove(cx: number, cz: number): void {
    const k = ckey(cx, cz);
    const e = this.entries.get(k);
    if (e) this.removeEntry(k, e);
  }

  /** drop meshes for which keep() is false */
  prune(keep: (cx: number, cz: number) => boolean): void {
    for (const [k, e] of this.entries) if (!keep(e.cx, e.cz)) this.removeEntry(k, e);
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      if (!keep(p.cx, p.cz)) {
        this.pending.splice(i, 1);
        if (this.onUploaded) this.onUploaded(1);
      }
    }
  }

  clear(): void {
    for (const [k, e] of this.entries) this.removeEntry(k, e);
    const n = this.pending.length;
    this.pending.length = 0;
    if (n && this.onUploaded) this.onUploaded(n);
  }

  /** column summary lookup: highest non-air y at world (x,z), or null if not loaded */
  heightAt(x: number, z: number): number | null {
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    const e = this.entries.get(ckey(cx, cz));
    if (!e) return null;
    const lx = Math.floor(x) - cx * CHUNK;
    const lz = Math.floor(z) - cz * CHUNK;
    return e.heights[lz * 16 + lx];
  }

  columnAt(x: number, z: number): { height: number; top: number; biome: number } | null {
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    const e = this.entries.get(ckey(cx, cz));
    if (!e) return null;
    const i = (Math.floor(z) - cz * CHUNK) * 16 + (Math.floor(x) - cx * CHUNK);
    return { height: e.heights[i], top: e.topIds[i], biome: e.biomes[i] };
  }
}

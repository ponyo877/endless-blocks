import * as THREE from 'three';
import { CHUNK } from '../gen/constants';
import { NGROUPS } from '../mesh/mesher';
import type { MeshResult } from '../workers/protocol';
import { ckey } from '../workers/protocol';
import { TerrainUniforms, createTerrainMaterial } from './chunkMaterial';

/**
 * One pass of one chunk. Quads are grouped by face direction (mesher GROUP_ORDER); only the groups that
 * can face the camera are drawn, as up to 4 ranges in a single WEBGL_multi_draw call. three.js sends
 * objects flagged `isBatchedMesh` through renderMultiDraw(_multiDrawStarts, _multiDrawCounts,
 * _multiDrawCount) (or a plain loop without the extension); a RawShaderMaterial gets no batching code.
 */
class ChunkMesh extends THREE.Mesh {
  readonly isBatchedMesh = true;
  readonly _multiDrawStarts = new Int32Array(4);
  readonly _multiDrawCounts = new Int32Array(4);
  _multiDrawCount = 0;
  readonly _colorsTexture = null;
  readonly _matricesTexture = null;
  readonly _indirectTexture = null;
  /** first quad of each group, plus the total */
  private readonly start = new Uint32Array(NGROUPS + 1);
  private mask = -1;

  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, counts: Uint32Array, off: number) {
    super(geometry, material);
    for (let k = 0; k < NGROUPS; k++) this.start[k + 1] = this.start[k] + counts[off + k];
    this.frustumCulled = false; // culled per chunk by ChunkRenderer.update()
    this.setMask(ALL);
  }

  /** draw the groups whose bit is set (bit k = GROUP_ORDER[k]); returns whether anything is drawn */
  setMask(mask: number): boolean {
    if (mask !== this.mask) {
      this.mask = mask;
      const st = this.start;
      let n = 0;
      let k = 0;
      while (k < NGROUPS) {
        if (!((mask >> k) & 1) || st[k + 1] === st[k]) {
          k++;
          continue;
        }
        // extend over selected and empty groups
        let e = k + 1;
        while (e < NGROUPS && (((mask >> e) & 1) || st[e + 1] === st[e])) e++;
        this._multiDrawStarts[n] = st[k] * 24; // byte offset: 6 Uint32 indices per quad
        this._multiDrawCounts[n] = (st[e] - st[k]) * 6;
        n++;
        k = e;
      }
      this._multiDrawCount = n;
    }
    return this._multiDrawCount > 0;
  }
}

const ALL = (1 << NGROUPS) - 1;
// bit positions of the groups in GROUP_ORDER (+X +Z other +Y -X -Z -Y)
const G_PX = 1 << 0, G_PZ = 1 << 1, G_OTHER = 1 << 2, G_PY = 1 << 3, G_NX = 1 << 4, G_NZ = 1 << 5, G_NY = 1 << 6;

export interface ChunkEntry {
  cx: number;
  cz: number;
  meshes: ChunkMesh[];
  opaque: ChunkMesh | null;
  translucent: ChunkMesh | null;
  leaves: ChunkMesh | null;
  plants: ChunkMesh | null;
  near: boolean;
  heights: Int16Array;
  topIds: Uint8Array;
  biomes: Uint8Array;
  minY: number;
  maxY: number;
  box: THREE.Box3;
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
  private readonly frustum = new THREE.Frustum();
  private readonly viewProj = new THREE.Matrix4();
  /** chunk meshes drawn by the last update() */
  drawn = 0;
  /** skip face directions that cannot face the camera (off only for verification) */
  dirCull = true;
  private index: THREE.BufferAttribute;
  private indexQuads = 0;
  private readonly oldIndices: THREE.BufferAttribute[] = [];
  onUploaded: ((n: number) => void) | null = null;
  /** bytes uploaded by the last processUploads() call */
  lastUploadBytes = 0;

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
    this.lastUploadBytes = bytes;
    return n;
  }

  private add(res: MeshResult): void {
    const k = ckey(res.cx, res.cz);
    const old = this.entries.get(k);
    if (old) this.removeEntry(k, old);
    const meshes: ChunkMesh[] = [];
    const x0 = res.cx * CHUNK;
    const z0 = res.cz * CHUNK;
    const minY = res.minY;
    const maxY = Math.max(res.maxY, minY + 1);
    const center = new THREE.Vector3(8, (minY + maxY) / 2, 8);
    const radius = Math.sqrt(8 * 8 * 2 + ((maxY - minY) / 2) ** 2) + 1;
    const pass = (data: Uint32Array, p: number, mat: THREE.RawShaderMaterial, order: number): ChunkMesh | null => {
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
      const mesh = new ChunkMesh(g, mat, res.groups, p * NGROUPS);
      mesh.position.set(x0, 0, z0);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.updateMatrixWorld(true);
      mesh.renderOrder = order;
      this.group.add(mesh);
      meshes.push(mesh);
      return mesh;
    };
    const opaque = pass(res.opaque, 0, this.materials.opaque, 0);
    const plants = pass(res.cutout, 1, this.materials.cutout, 1);
    const translucent = pass(res.translucent, 2, this.materials.translucent, 2);
    const leaves = pass(res.leaves, 3, this.materials.leavesFast, 0);
    const entry: ChunkEntry = {
      cx: res.cx, cz: res.cz, meshes, opaque, translucent, leaves, plants, near: false,
      heights: res.heights, topIds: res.topIds, biomes: res.biomes, minY, maxY,
      box: new THREE.Box3(new THREE.Vector3(x0, minY, z0), new THREE.Vector3(x0 + CHUNK, maxY, z0 + CHUNK)),
    };
    for (const m of meshes) m.visible = false; // until the next update()
    this.entries.set(k, entry);
  }

  /**
   * Per-frame visibility: frustum test per chunk box, face directions that can face the camera,
   * leaves alpha-tested within lodR (solid beyond), plants drawn within plantR.
   */
  update(camera: THREE.Camera, lodR: number, plantR: number): void {
    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProj);
    const c = camera.position;
    const lod2 = lodR * lodR;
    const plant2 = plantR * plantR;
    let drawn = 0;
    for (const e of this.entries.values()) {
      const inView = this.frustum.intersectsBox(e.box);
      if (!inView) {
        for (const m of e.meshes) m.visible = false;
        continue;
      }
      const x0 = e.cx * CHUNK;
      const z0 = e.cz * CHUNK;
      // a +X face of this chunk has its plane in (x0, x0+16]: it can only face a camera with x > x0, etc.
      let mask = this.dirCull ? G_OTHER : ALL;
      if (c.x > x0) mask |= G_PX;
      if (c.x < x0 + CHUNK) mask |= G_NX;
      if (c.z > z0) mask |= G_PZ;
      if (c.z < z0 + CHUNK) mask |= G_NZ;
      if (c.y > e.minY) mask |= G_PY;
      if (c.y < e.maxY) mask |= G_NY;
      const dx = x0 + 8 - c.x;
      const dz = z0 + 8 - c.z;
      const d2 = dx * dx + dz * dz;
      if (e.opaque) e.opaque.visible = e.opaque.setMask(mask);
      if (e.translucent) e.translucent.visible = e.translucent.setMask(mask);
      if (e.plants) e.plants.visible = d2 < plant2; // small plants vanish into the fog anyway
      if (e.leaves) {
        const near = d2 < lod2;
        if (near !== e.near) {
          e.near = near;
          e.leaves.material = near ? this.materials.cutout : this.materials.leavesFast;
          e.leaves.renderOrder = near ? 1 : 0;
        }
        // near leaves are double-sided (the far side of a canopy shows through the holes)
        e.leaves.visible = e.leaves.setMask(near ? ALL : mask);
      }
      for (const m of e.meshes) if (m.visible) drawn++;
    }
    this.drawn = drawn;
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

import * as THREE from 'three';
import { Coll } from '../gen/blocks';

// Visual effects around the glider: square "pixel" particles (sparks off rock, leaf bits, water
// spray, crash debris) and two wingtip trails. Positions are kept relative to a local origin near
// the glider so float32 precision holds far from the world origin.

const MAX = 900;

const VERT = /* glsl */ `
attribute vec4 pcolor;
attribute float psize;
uniform float uScale;
varying vec4 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = max(1.0, psize * uScale / max(0.1, -mv.z));
  vColor = pcolor;
}`;
const FRAG = /* glsl */ `
varying vec4 vColor;
void main() {
  if (vColor.a < 0.01) discard;
  gl_FragColor = vColor;
}`;

const TRAIL_VERT = /* glsl */ `
attribute float alpha;
varying float vA;
void main() {
  vA = alpha;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const TRAIL_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vA;
void main() { gl_FragColor = vec4(uColor, vA); }`;

interface Palette {
  colors: THREE.Color[];
  size: number;
  life: number;
  gravity: number;
}

const pal = (hex: number[], size: number, life: number, gravity: number): Palette => ({
  colors: hex.map((h) => new THREE.Color().setHex(h, THREE.LinearSRGBColorSpace)), // written to the screen as-is
  size,
  life,
  gravity,
});

const SPARK = pal([0xffe08a, 0xffb347, 0xff8a3c, 0xfff4d0], 0.11, 0.35, -9);
const LEAF = pal([0x5aa83a, 0x3f7d2a, 0x76c04a, 0x2e5e1f], 0.14, 0.9, -3);
const SPRAY = pal([0xffffff, 0xe8f6ff, 0xb8e0ff, 0x9fd0f5], 0.13, 0.65, -13);
const DEBRIS = pal([0x8a8a8a, 0x6b5a45, 0xb0aaa0, 0xf4f1ea, 0xf08a24], 0.2, 1.6, -16);

const TRAIL_N = 44;

export class Effects {
  readonly group = new THREE.Group();
  private readonly points: THREE.Points;
  private readonly mat: THREE.ShaderMaterial;
  private readonly pos = new Float32Array(MAX * 3);
  private readonly col = new Float32Array(MAX * 4);
  private readonly size = new Float32Array(MAX);
  // simulation state (world space, float64)
  private readonly px = new Float64Array(MAX);
  private readonly py = new Float64Array(MAX);
  private readonly pz = new Float64Array(MAX);
  private readonly vx = new Float32Array(MAX);
  private readonly vy = new Float32Array(MAX);
  private readonly vz = new Float32Array(MAX);
  private readonly life = new Float32Array(MAX);
  private readonly life0 = new Float32Array(MAX);
  private readonly grav = new Float32Array(MAX);
  private readonly rgb = new Float32Array(MAX * 3);
  private readonly sz = new Float32Array(MAX);
  private n = 0;
  private emitAcc = 0;
  private sprayAcc = 0;
  private readonly origin = new THREE.Vector3();

  // wingtip trails
  private readonly trails: { xs: Float64Array; ys: Float64Array; zs: Float64Array; n: number }[] = [];
  private readonly trailMesh: THREE.Mesh;
  private readonly trailPos = new Float32Array(2 * TRAIL_N * 2 * 3);
  private readonly trailAlpha = new Float32Array(2 * TRAIL_N * 2);
  private trailTimer = 0;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();

  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('psize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uScale: { value: 600 } },
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.group.add(this.points);

    for (let i = 0; i < 2; i++) this.trails.push({ xs: new Float64Array(TRAIL_N), ys: new Float64Array(TRAIL_N), zs: new Float64Array(TRAIL_N), n: 0 });
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3).setUsage(THREE.DynamicDrawUsage));
    tg.setAttribute('alpha', new THREE.BufferAttribute(this.trailAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    const idx: number[] = [];
    for (let t = 0; t < 2; t++) {
      for (let i = 0; i < TRAIL_N - 1; i++) {
        const a = (t * TRAIL_N + i) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    tg.setIndex(idx);
    this.trailMesh = new THREE.Mesh(
      tg,
      new THREE.ShaderMaterial({
        vertexShader: TRAIL_VERT,
        fragmentShader: TRAIL_FRAG,
        uniforms: { uColor: { value: new THREE.Color(0.95, 0.97, 1) } },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.trailMesh.frustumCulled = false;
    this.trailMesh.renderOrder = 2;
    this.group.add(this.trailMesh);
  }

  clear(): void {
    this.n = 0;
    for (const t of this.trails) t.n = 0;
  }

  private spawn(p: Palette, x: number, y: number, z: number, vx: number, vy: number, vz: number, lifeMul = 1, sizeMul = 1): void {
    let i = this.n;
    if (i >= MAX) i = Math.floor(Math.random() * MAX);
    else this.n++;
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    const l = p.life * (0.6 + Math.random() * 0.8) * lifeMul;
    this.life[i] = l;
    this.life0[i] = l;
    this.grav[i] = p.gravity;
    const c = p.colors[Math.floor(Math.random() * p.colors.length)];
    this.rgb[i * 3] = c.r;
    this.rgb[i * 3 + 1] = c.g;
    this.rgb[i * 3 + 2] = c.b;
    this.sz[i] = p.size * (0.7 + Math.random() * 0.6) * sizeMul;
  }

  private paletteOf(cls: number): Palette {
    return cls === Coll.LEAVES ? LEAF : cls === Coll.LIQUID ? SPRAY : SPARK;
  }

  /**
   * Scrape effects: called every frame while flying. `clearance` and the nearest point/class come
   * from the simulation; (gx, gy, gz) is the glider and (fx, fy, fz) its velocity.
   */
  scrape(dt: number, clearance: number, cls: number, nx: number, ny: number, nz: number, gx: number, gy: number, gz: number, vx: number, vy: number, vz: number): void {
    if (clearance >= 0.7 || cls === 0) {
      this.emitAcc = 0;
      return;
    }
    const k = (0.7 - clearance) / 0.7;
    this.emitAcc += dt * (40 + 220 * k * k);
    const p = this.paletteOf(cls);
    // away from the surface, plus some of the glider's motion
    let ax = gx - nx;
    let ay = gy - ny;
    let az = gz - nz;
    const l = Math.hypot(ax, ay, az) || 1;
    ax /= l;
    ay /= l;
    az /= l;
    while (this.emitAcc >= 1) {
      this.emitAcc -= 1;
      const s = 1.5 + Math.random() * 3;
      this.spawn(
        p, nx, ny, nz,
        ax * s + vx * 0.35 + (Math.random() - 0.5) * 2.5,
        ay * s + vy * 0.35 + (Math.random() - 0.5) * 2.5 + (cls === Coll.LIQUID ? 2.5 : 0),
        az * s + vz * 0.35 + (Math.random() - 0.5) * 2.5,
      );
    }
  }

  /** a rooster tail of spray while skimming low over water */
  spray(dt: number, height: number, gx: number, gy: number, gz: number, vx: number, vz: number): void {
    if (height > 1.4) {
      this.sprayAcc = 0;
      return;
    }
    this.sprayAcc += dt * 90 * (1.4 - height);
    const wy = gy - height - 0.3;
    while (this.sprayAcc >= 1) {
      this.sprayAcc -= 1;
      this.spawn(SPRAY, gx + (Math.random() - 0.5) * 0.6, wy, gz + (Math.random() - 0.5) * 0.6, vx * 0.25 + (Math.random() - 0.5) * 2, 3 + Math.random() * 3, vz * 0.25 + (Math.random() - 0.5) * 2);
    }
  }

  /** burst of debris (and glider bits) where the glider hit */
  crash(cls: number, x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    const base = cls === Coll.LEAVES ? LEAF : cls === Coll.LIQUID ? SPRAY : DEBRIS;
    for (let i = 0; i < 140; i++) {
      const p = i % 5 === 0 ? DEBRIS : base;
      const s = 3 + Math.random() * 7;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.random() * Math.PI - Math.PI / 2;
      this.spawn(
        p, x, y, z,
        Math.cos(th) * Math.cos(ph) * s - vx * 0.15,
        Math.abs(Math.sin(ph)) * s + (cls === Coll.LIQUID ? 5 : 2),
        Math.sin(th) * Math.cos(ph) * s - vz * 0.15,
        1.2,
        1.6,
      );
    }
  }

  /** record wingtip positions (world space) */
  pushTrail(left: THREE.Vector3, right: THREE.Vector3, dt: number): void {
    this.trailTimer += dt;
    if (this.trailTimer < 1 / 45) return;
    this.trailTimer = 0;
    const tips = [left, right];
    for (let t = 0; t < 2; t++) {
      const tr = this.trails[t];
      tr.xs.copyWithin(1, 0, TRAIL_N - 1);
      tr.ys.copyWithin(1, 0, TRAIL_N - 1);
      tr.zs.copyWithin(1, 0, TRAIL_N - 1);
      tr.xs[0] = tips[t].x;
      tr.ys[0] = tips[t].y;
      tr.zs[0] = tips[t].z;
      tr.n = Math.min(TRAIL_N, tr.n + 1);
    }
  }

  /** advance particles and rebuild buffers; `strength` scales the trail opacity (0..1) */
  update(dt: number, camera: THREE.Camera, anchor: THREE.Vector3, strength: number, pixelHeight: number, fovDeg: number): void {
    // local origin near the glider
    this.origin.set(Math.floor(anchor.x), Math.floor(anchor.y), Math.floor(anchor.z));
    this.group.position.copy(this.origin);
    this.group.updateMatrixWorld(true);
    const ox = this.origin.x;
    const oy = this.origin.y;
    const oz = this.origin.z;

    let w = 0;
    for (let i = 0; i < this.n; i++) {
      const l = this.life[i] - dt;
      if (l <= 0) continue;
      // compact in place
      if (w !== i) {
        this.px[w] = this.px[i];
        this.py[w] = this.py[i];
        this.pz[w] = this.pz[i];
        this.vx[w] = this.vx[i];
        this.vy[w] = this.vy[i];
        this.vz[w] = this.vz[i];
        this.life0[w] = this.life0[i];
        this.grav[w] = this.grav[i];
        this.rgb[w * 3] = this.rgb[i * 3];
        this.rgb[w * 3 + 1] = this.rgb[i * 3 + 1];
        this.rgb[w * 3 + 2] = this.rgb[i * 3 + 2];
        this.sz[w] = this.sz[i];
      }
      this.life[w] = l;
      this.vy[w] += this.grav[w] * dt;
      const drag = 1 - Math.min(1, dt * 1.8);
      this.vx[w] *= drag;
      this.vz[w] *= drag;
      this.px[w] += this.vx[w] * dt;
      this.py[w] += this.vy[w] * dt;
      this.pz[w] += this.vz[w] * dt;
      this.pos[w * 3] = this.px[w] - ox;
      this.pos[w * 3 + 1] = this.py[w] - oy;
      this.pos[w * 3 + 2] = this.pz[w] - oz;
      const a = Math.min(1, (l / this.life0[w]) * 2);
      this.col[w * 4] = this.rgb[w * 3];
      this.col[w * 4 + 1] = this.rgb[w * 3 + 1];
      this.col[w * 4 + 2] = this.rgb[w * 3 + 2];
      this.col[w * 4 + 3] = a;
      this.size[w] = this.sz[w];
      w++;
    }
    this.n = w;
    const g = this.points.geometry;
    g.setDrawRange(0, w);
    (g.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.pcolor as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.psize as THREE.BufferAttribute).needsUpdate = true;
    // world-size points: pixels per unit at distance 1
    this.mat.uniforms.uScale.value = pixelHeight / (2 * Math.tan((fovDeg * Math.PI) / 360));

    // trails: camera-facing ribbons, fading toward the tail
    const cam = camera.position;
    for (let t = 0; t < 2; t++) {
      const tr = this.trails[t];
      for (let i = 0; i < TRAIL_N; i++) {
        const j = Math.min(i, Math.max(0, tr.n - 1));
        const k = Math.min(j + 1, Math.max(0, tr.n - 1));
        const x = tr.xs[j];
        const y = tr.ys[j];
        const z = tr.zs[j];
        // tangent and direction to camera
        this.tmp.set(tr.xs[k] - x, tr.ys[k] - y, tr.zs[k] - z);
        if (k === j && j > 0) this.tmp.set(x - tr.xs[j - 1], y - tr.ys[j - 1], z - tr.zs[j - 1]);
        this.tmp2.set(cam.x - x, cam.y - y, cam.z - z);
        this.tmp.cross(this.tmp2).normalize().multiplyScalar(0.035);
        const o = ((t * TRAIL_N + i) * 2) * 3;
        this.trailPos[o] = x - ox + this.tmp.x;
        this.trailPos[o + 1] = y - oy + this.tmp.y;
        this.trailPos[o + 2] = z - oz + this.tmp.z;
        this.trailPos[o + 3] = x - ox - this.tmp.x;
        this.trailPos[o + 4] = y - oy - this.tmp.y;
        this.trailPos[o + 5] = z - oz - this.tmp.z;
        const f = i < tr.n ? (1 - i / TRAIL_N) * 0.55 * strength : 0;
        this.trailAlpha[(t * TRAIL_N + i) * 2] = f;
        this.trailAlpha[(t * TRAIL_N + i) * 2 + 1] = f;
      }
    }
    const tg = this.trailMesh.geometry;
    (tg.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (tg.attributes.alpha as THREE.BufferAttribute).needsUpdate = true;
  }
}

import * as THREE from 'three';

// The player's craft: a small, original block-built hang glider (white sail, orange tips, a dark
// keel and a pod hanging below). Built from boxes with the world's face shading baked into vertex
// colours; the material colour follows the sky light so it darkens at dusk like the terrain does.

interface Box {
  a: [number, number, number];
  b: [number, number, number];
  c: number;
}

const SAIL = 0xf4f1ea;
const TIP = 0xf08a24;
const KEEL = 0x3a3f4a;
const POD = 0x2d5a8c;
const BAR = 0x9aa0a8;

function boxes(): Box[] {
  const out: Box[] = [];
  // stepped delta wing, nose toward -z
  const rows = 6;
  const depth = 0.17;
  for (let i = 0; i < rows; i++) {
    const z0 = -0.52 + i * depth;
    const half = 0.14 + i * 0.135;
    const tip = Math.min(0.16, half * 0.4);
    const y = 0.02 - i * 0.004;
    out.push({ a: [-half + tip, y, z0], b: [half - tip, y + 0.035, z0 + depth], c: SAIL });
    out.push({ a: [-half, y, z0], b: [-half + tip, y + 0.035, z0 + depth], c: TIP });
    out.push({ a: [half - tip, y, z0], b: [half, y + 0.035, z0 + depth], c: TIP });
  }
  out.push({ a: [-0.035, 0.05, -0.56], b: [0.035, 0.1, 0.5], c: KEEL });
  // pod and control bar under the wing
  out.push({ a: [-0.012, -0.24, -0.02], b: [0.012, 0.02, 0.02], c: BAR });
  out.push({ a: [-0.26, -0.27, -0.1], b: [0.26, -0.245, -0.075], c: BAR });
  out.push({ a: [-0.08, -0.34, -0.06], b: [0.08, -0.2, 0.3], c: POD });
  return out;
}

// face shading like the terrain: top 1.0, north/south 0.8, east/west 0.6, bottom 0.5
const FACES: { n: [number, number, number]; shade: number }[] = [
  { n: [1, 0, 0], shade: 0.6 },
  { n: [-1, 0, 0], shade: 0.6 },
  { n: [0, 1, 0], shade: 1 },
  { n: [0, -1, 0], shade: 0.5 },
  { n: [0, 0, 1], shade: 0.8 },
  { n: [0, 0, -1], shade: 0.8 },
];

function buildGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const color = new THREE.Color();
  for (const bx of boxes()) {
    color.setHex(bx.c); // converted to linear; the renderer converts back on output
    const [x0, y0, z0] = bx.a;
    const [x1, y1, z1] = bx.b;
    for (const f of FACES) {
      const [nx, ny, nz] = f.n;
      // four corners of this face
      const corners: [number, number, number][] = [];
      if (nx !== 0) {
        const x = nx > 0 ? x1 : x0;
        corners.push([x, y0, z0], [x, y1, z0], [x, y1, z1], [x, y0, z1]);
      } else if (ny !== 0) {
        const y = ny > 0 ? y1 : y0;
        corners.push([x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0]);
      } else {
        const z = nz > 0 ? z1 : z0;
        corners.push([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]);
      }
      const base = pos.length / 3;
      for (const c of corners) {
        pos.push(c[0], c[1], c[2]);
        col.push(color.r * f.shade, color.g * f.shade, color.b * f.shade);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

export class Glider {
  readonly object: THREE.Mesh;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor() {
    this.material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    this.object = new THREE.Mesh(buildGeometry(), this.material);
    this.object.matrixAutoUpdate = false;
    this.object.frustumCulled = false;
    this.object.renderOrder = 1;
  }

  /** place it; bank is the visual roll in radians (negative = right wing down) */
  set(x: number, y: number, z: number, yaw: number, pitch: number, bank: number, skyLight: THREE.Color): void {
    this.object.position.set(x, y, z);
    this.euler.set(pitch, yaw, bank, 'YXZ');
    this.object.quaternion.setFromEuler(this.euler);
    this.object.updateMatrix();
    this.object.updateMatrixWorld(true);
    // never quite black: the sail catches some light even at night
    this.material.color.setRGB(Math.max(0.28, skyLight.r), Math.max(0.28, skyLight.g), Math.max(0.3, skyLight.b));
  }
}

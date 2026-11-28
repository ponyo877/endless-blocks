import * as THREE from 'three';
import { type RayHit, type VoxelSource, ray } from './voxels';

// Third-person camera. It sits on the glider's own trail a few blocks back, so it is always in space
// the glider has just flown through; when a roof or a wall would still come between camera and
// glider it slides in closer.

const TRAIL = 256;

export class ChaseCam {
  /** blocks behind the glider, measured along its trail */
  distance = 5.2;
  /** height above the trail point */
  lift = 1.25;
  /** fraction of the glider's bank applied to the camera */
  rollShare = 0.35;
  private readonly xs = new Float64Array(TRAIL);
  private readonly ys = new Float64Array(TRAIL);
  private readonly zs = new Float64Array(TRAIL);
  /** cumulative path length at each trail point */
  private readonly ds = new Float64Array(TRAIL);
  private head = -1;
  private count = 0;
  private readonly pos = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly hit: RayHit = { dist: 0, cls: 0 };
  private initialized = false;
  shake = 0;

  reset(): void {
    this.head = -1;
    this.count = 0;
    this.initialized = false;
  }

  /** record the glider position once per simulation tick */
  push(x: number, y: number, z: number): void {
    const prev = this.head;
    this.head = (this.head + 1) % TRAIL;
    let d = 0;
    if (this.count > 0) {
      const dx = x - this.xs[prev];
      const dy = y - this.ys[prev];
      const dz = z - this.zs[prev];
      d = this.ds[prev] + Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    this.xs[this.head] = x;
    this.ys[this.head] = y;
    this.zs[this.head] = z;
    this.ds[this.head] = d;
    this.count = Math.min(TRAIL, this.count + 1);
  }

  /** point on the trail `back` blocks behind the glider at (gx, gy, gz); false if the trail is too short */
  private trailPoint(gx: number, gy: number, gz: number, back: number, out: THREE.Vector3): boolean {
    if (this.count < 2) return false;
    // distance from the glider's (interpolated) position to the newest trail point
    let i = this.head;
    let ax = gx;
    let ay = gy;
    let az = gz;
    let left = back;
    for (let n = 0; n < this.count; n++) {
      const bx = this.xs[i];
      const by = this.ys[i];
      const bz = this.zs[i];
      const seg = Math.hypot(bx - ax, by - ay, bz - az);
      if (seg >= left && seg > 0) {
        const f = left / seg;
        out.set(ax + (bx - ax) * f, ay + (by - ay) * f, az + (bz - az) * f);
        return true;
      }
      left -= seg;
      ax = bx;
      ay = by;
      az = bz;
      i = (i - 1 + TRAIL) % TRAIL;
    }
    return false;
  }

  /**
   * Pose the camera behind a glider at g heading along f (unit), banked by `bank` radians.
   * `dt` is the frame time (for smoothing).
   */
  update(camera: THREE.PerspectiveCamera, g: THREE.Vector3, f: THREE.Vector3, bank: number, src: VoxelSource, dt: number): void {
    const want = this.pos;
    if (!this.trailPoint(g.x, g.y, g.z, this.distance, want)) {
      want.set(g.x - f.x * this.distance, g.y - f.y * this.distance, g.z - f.z * this.distance);
    }
    want.y += this.lift;
    // keep a clear line from the glider to the camera
    let dx = want.x - g.x;
    let dy = want.y - g.y;
    let dz = want.z - g.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len;
    dy /= len;
    dz /= len;
    ray(src, g.x, g.y, g.z, dx, dy, dz, len + 0.4, this.hit);
    const free = this.hit.cls ? Math.max(0.7, this.hit.dist - 0.45) : len;
    const d = Math.min(len, free);
    want.set(g.x + dx * d, g.y + dy * d, g.z + dz * d);

    if (!this.initialized) {
      camera.position.copy(want);
      this.initialized = true;
    } else {
      // follow quickly; snap in at once when the view would be blocked
      const k = d < len ? 1 : 1 - Math.exp(-dt * 14);
      camera.position.lerp(want, k);
    }

    this.target.set(g.x + f.x * 7, g.y + f.y * 7 + 0.35, g.z + f.z * 7);
    // up vector rolled around the view direction by a share of the bank
    this.up.set(0, 1, 0);
    this.m.lookAt(camera.position, this.target, this.up);
    camera.quaternion.setFromRotationMatrix(this.m);
    this.q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), bank * this.rollShare);
    camera.quaternion.multiply(this.q);
    if (this.shake > 0) {
      const s = this.shake;
      camera.position.x += (Math.random() - 0.5) * s;
      camera.position.y += (Math.random() - 0.5) * s;
      camera.position.z += (Math.random() - 0.5) * s;
      this.shake = Math.max(0, this.shake - dt * 2.2);
    }
  }
}

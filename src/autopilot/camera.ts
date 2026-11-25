import * as THREE from 'three';
import { PathLog } from './path';

// Flight state is a single float64 arc length `s`. Position and orientation are pure functions
// of s, so flying backwards retraces exactly. Speed follows the requested speed through a
// critically damped spring, scaled down when the world ahead is not ready yet.

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const DEG = Math.PI / 180;

export class Autopilot {
  s: number;
  v = 0;
  private acc = 0;
  /** requested speed in blocks/s (negative = backwards) */
  requested: number;
  paused = false;
  /** 0..1 readiness of the world ahead in the direction of travel */
  readiness = 1;
  private readonly a = { x: 0, y: 0, z: 0 };
  private readonly b = { x: 0, y: 0, z: 0 };
  private readonly c = { x: 0, y: 0, z: 0 };
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  readonly position = new THREE.Vector3();
  readonly forward = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  roll = 0;

  constructor(readonly path: PathLog, startS: number, speed: number) {
    this.s = startS;
    this.requested = speed;
  }

  /** distance ahead (in the direction of travel) whose surroundings are meshed */
  setReadiness(dReady: number, dir: number, cap: number): void {
    const speed = Math.abs(this.v);
    const dOk = Math.min(cap, 96 + speed * 3);
    const dMin = Math.min(dOk * 0.6, 24 + (speed * speed) / (2 * 14));
    let r = smoothstep(dMin, dOk, dReady);
    // never run off the planned path
    const room = dir >= 0 ? this.path.end - this.s : this.s;
    r = Math.min(r, smoothstep(40, 160, room));
    this.readiness = r;
  }

  update(dt: number): void {
    const target = this.paused ? 0 : this.requested * this.readiness;
    const w = 2.2;
    this.acc += (w * w * (target - this.v) - 2 * w * this.acc) * dt;
    this.v += this.acc * dt;
    this.s += this.v * dt;
    if (this.s < 0) {
      this.s = 0;
      this.v = Math.max(0, this.v);
    }
    const end = this.path.end;
    if (this.s > end) {
      this.s = end;
      this.v = Math.min(0, this.v);
    }
  }

  pose(camera: THREE.PerspectiveCamera): void {
    const p = this.path.sample(this.s, this.a);
    this.position.set(p.x, p.y + 0.0, p.z);
    // yaw from a look-ahead chord
    const f0 = this.path.sample(this.s + 4, this.b);
    const f1 = this.path.sample(this.s + 26, this.c);
    let dx = f1.x - f0.x;
    let dz = f1.z - f0.z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    // slow look-around (a pure function of s, so reversing retraces exactly)
    const s = this.s;
    const look = 0.13 * Math.sin(s / 310) + 0.06 * Math.sin(s / 127 + 1.3);
    this.yaw = Math.atan2(-dx, -dz) + look;
    // pitch from the upcoming climb/descent
    const ahead = this.path.sample(this.s + 30, this.b);
    const slope = (ahead.y - p.y) / 30;
    const nod = 3.5 * DEG * Math.sin(s / 233 + 0.7);
    this.pitch = Math.max(-20 * DEG, Math.min(20 * DEG, -9 * DEG + nod + 0.5 * Math.atan(slope)));
    // roll into turns
    const g0 = this.path.sample(this.s + 20, this.b);
    const g1 = this.path.sample(this.s + 44, this.c);
    const h1 = Math.atan2(g1.z - g0.z, g1.x - g0.x);
    const h0 = Math.atan2(dz, dx);
    let dh = h1 - h0;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    this.roll = Math.max(-5 * DEG, Math.min(5 * DEG, dh * 0.9));
    this.euler.set(this.pitch, this.yaw, this.roll, 'YXZ');
    camera.position.copy(this.position);
    camera.quaternion.setFromEuler(this.euler);
    this.forward.set(dx, 0, dz);
  }
}

import type { TickInput } from './sim';

const DEG = Math.PI / 180;

export type Device = 'keys' | 'mouse' | 'touch' | 'pad';

export interface InputSettings {
  invertY: boolean;
  /** mouse aim sensitivity, degrees per pixel */
  mouseSens: number;
}

/**
 * Turns keyboard, mouse (pointer lock, "mouse aim"), touch (relative stick + boost button) and
 * gamepad into one stick in [-1, 1]^2 plus boost. The simulation only ever sees the quantized stick,
 * which is also what gets recorded for replays.
 */
export class GameInput {
  stickX = 0;
  stickY = 0;
  boost = false;
  device: Device = 'keys';
  settings: InputSettings = { invertY: false, mouseSens: 0.12 };
  /** mouse aim direction (world yaw/pitch, radians); the glider steers toward it */
  aimYaw = 0;
  aimPitch = 0;
  /** touch stick: start point and current offset (CSS px), for drawing the ring */
  touch: { active: boolean; x0: number; y0: number; dx: number; dy: number } = { active: false, x0: 0, y0: 0, dx: 0, dy: 0 };
  /** called on Esc / P / pad start */
  onPause: (() => void) | null = null;

  private readonly keys = new Set<string>();
  private kx = 0;
  private ky = 0;
  private mouseBoost = false;
  private touchBoost = false;
  private touchId: number | null = null;
  private padBoost = false;
  private padStart = false;
  private enabled = false;

  constructor(private readonly surface: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.code === 'Escape' || e.code === 'KeyP') {
        if (!e.repeat) this.onPause?.();
        return;
      }
      if (!this.enabled) return;
      if (KEYS.has(e.code)) {
        e.preventDefault();
        this.keys.add(e.code);
        this.device = 'keys';
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseBoost = false;
      this.touchBoost = false;
      this.endTouch();
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.enabled || document.pointerLockElement !== this.surface) return;
      if (Math.abs(e.movementX) + Math.abs(e.movementY) < 1) return;
      this.device = 'mouse';
      const k = this.settings.mouseSens * DEG;
      this.aimYaw -= e.movementX * k;
      this.aimPitch -= e.movementY * k * (this.settings.invertY ? -1 : 1);
    });
    this.surface.addEventListener('mousedown', (e) => {
      if (e.button === 0 && document.pointerLockElement === this.surface) this.mouseBoost = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseBoost = false;
    });

    this.surface.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || !this.enabled || this.touchId !== null) return;
      this.touchId = e.pointerId;
      this.device = 'touch';
      this.touch.active = true;
      this.touch.x0 = e.clientX;
      this.touch.y0 = e.clientY;
      this.touch.dx = 0;
      this.touch.dy = 0;
    });
    this.surface.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.touchId) return;
      this.touch.dx = e.clientX - this.touch.x0;
      this.touch.dy = e.clientY - this.touch.y0;
    });
    const up = (e: PointerEvent) => {
      if (e.pointerId === this.touchId) this.endTouch();
    };
    this.surface.addEventListener('pointerup', up);
    this.surface.addEventListener('pointercancel', up);
  }

  /** the boost button for touch screens */
  bindBoostButton(el: HTMLElement): void {
    const on = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      this.touchBoost = true;
      this.device = 'touch';
    };
    const off = () => {
      this.touchBoost = false;
    };
    el.addEventListener('pointerdown', on);
    el.addEventListener('pointerup', off);
    el.addEventListener('pointercancel', off);
    el.addEventListener('pointerleave', off);
  }

  private endTouch(): void {
    this.touchId = null;
    this.touch.active = false;
    this.touch.dx = 0;
    this.touch.dy = 0;
  }

  /** start or stop reading steering input; the aim starts at the current heading */
  setEnabled(on: boolean, yaw = 0, pitch = 0): void {
    this.enabled = on;
    this.aimYaw = yaw;
    this.aimPitch = pitch;
    this.kx = this.ky = 0;
    this.stickX = this.stickY = 0;
    if (!on) {
      this.keys.clear();
      this.endTouch();
    }
  }

  get pointerLocked(): boolean {
    return document.pointerLockElement === this.surface;
  }

  requestPointerLock(): void {
    if (matchMedia('(pointer: coarse)').matches) return;
    const r = this.surface.requestPointerLock?.() as unknown as Promise<void> | undefined;
    if (r && typeof r.catch === 'function') r.catch(() => undefined);
  }

  /** read all devices; yaw/pitch are the glider's current heading (for mouse aim) */
  update(dt: number, yaw: number, pitch: number): void {
    this.pollPad();
    if (!this.enabled) {
      this.stickX = this.stickY = 0;
      this.boost = false;
      return;
    }
    const k = this.keys;
    const tx = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let ty = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    if (this.settings.invertY) ty = -ty;
    const e = Math.min(1, dt * 7);
    this.kx += (tx - this.kx) * e;
    this.ky += (ty - this.ky) * e;

    let sx = 0;
    let sy = 0;
    if (this.device === 'keys') {
      sx = this.kx;
      sy = this.ky;
      this.aimYaw = yaw;
      this.aimPitch = pitch;
    } else if (this.device === 'mouse') {
      // keep the aim within reach of the heading, then steer toward it
      let dyaw = this.aimYaw - yaw;
      while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
      while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
      dyaw = Math.max(-50 * DEG, Math.min(50 * DEG, dyaw));
      this.aimYaw = yaw + dyaw;
      this.aimPitch = Math.max(-75 * DEG, Math.min(75 * DEG, Math.max(pitch - 50 * DEG, Math.min(pitch + 50 * DEG, this.aimPitch))));
      sx = -dyaw / (22 * DEG);
      sy = (this.aimPitch - pitch) / (22 * DEG);
    } else if (this.device === 'touch') {
      const r = Math.min(window.innerWidth, window.innerHeight) * 0.11 + 20;
      sx = this.touch.dx / r;
      sy = -this.touch.dy / r;
      if (this.settings.invertY) sy = -sy;
    } else if (this.device === 'pad') {
      sx = this.padX;
      sy = this.padY;
    }
    const len = Math.hypot(sx, sy);
    if (len > 1) {
      sx /= len;
      sy /= len;
    }
    this.stickX = sx;
    this.stickY = sy;
    this.boost = k.has('ShiftLeft') || k.has('ShiftRight') || k.has('Space') || this.mouseBoost || this.touchBoost || this.padBoost;
  }

  private padX = 0;
  private padY = 0;

  private pollPad(): void {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad: Gamepad | null = null;
    for (const p of pads) if (p && p.connected) pad = pad ?? p;
    if (!pad) {
      this.padBoost = false;
      return;
    }
    const dz = (v: number) => (Math.abs(v) < 0.14 ? 0 : (v - Math.sign(v) * 0.14) / 0.86);
    const x = dz(pad.axes[0] ?? 0);
    let y = -dz(pad.axes[1] ?? 0);
    if (this.settings.invertY) y = -y;
    const boost = !!(pad.buttons[0]?.pressed || (pad.buttons[7]?.value ?? 0) > 0.3 || pad.buttons[5]?.pressed);
    if (x !== 0 || y !== 0 || boost) this.device = 'pad';
    this.padX = x;
    this.padY = y;
    this.padBoost = boost;
    const start = !!pad.buttons[9]?.pressed;
    if (start && !this.padStart) this.onPause?.();
    this.padStart = start;
  }

  /** the quantized input the simulation steps with */
  tick(): TickInput {
    return {
      sx: Math.round(this.stickX * 127),
      sy: Math.round(this.stickY * 127),
      boost: this.boost ? 1 : 0,
    };
  }
}

const KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'Space']);

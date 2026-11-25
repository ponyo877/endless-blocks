import * as THREE from 'three';

const NIGHT_SKY = new THREE.Color(0.018, 0.024, 0.07);
const DAY_FOG = new THREE.Color(0.74, 0.84, 1.0);
const NIGHT_FOG = new THREE.Color(0.045, 0.058, 0.115);
const NIGHT_LIGHT = new THREE.Color(0.3, 0.34, 0.52);
const DAY_LIGHT = new THREE.Color(1, 1, 1);
const DUSK_LIGHT = new THREE.Color(1.0, 0.82, 0.66);
const FLASH_LIGHT = new THREE.Color(1, 1, 1.1);
const FLASH_SKY = new THREE.Color(0.8, 0.82, 0.95);
const _g = new THREE.Color();
const _c = new THREE.Color();
const _sh = new THREE.Vector2();
const _vh = new THREE.Vector2();
// Time of day + weather -> all the colours/factors the renderer needs.
// time: 0 = sunrise, 0.25 = noon, 0.5 = sunset, 0.75 = midnight.

export interface EnvInput {
  time: number;
  rain: number; // 0..1 (overcast/precipitation strength)
  thunder: number; // 0..1
  flash: number; // lightning flash 0..1
  skyTemp: number; // biome temperature 0..1 (sky hue)
  viewDir: THREE.Vector3; // camera forward (world)
}

export class Environment {
  readonly sunDir = new THREE.Vector3();
  readonly skyColor = new THREE.Color();
  readonly fogColor = new THREE.Color();
  readonly horizonColor = new THREE.Color();
  readonly sunsetColor = new THREE.Color();
  readonly skyLight = new THREE.Color();
  readonly blockLight = new THREE.Color(1.0, 0.86, 0.66);
  readonly cloudColor = new THREE.Color();
  sunsetAlpha = 0;
  daylight = 1;
  /** 0 = deep night .. 1 = full day */
  day = 1;
  starAlpha = 0;
  private readonly tmp = new THREE.Color();

  update(e: EnvInput): void {
    const ang = e.time * Math.PI * 2;
    // sun travels east (+x) -> zenith -> west (-x), with a slight southern tilt
    this.sunDir.set(Math.cos(ang), Math.sin(ang), 0.18).normalize();
    const h = Math.sin(ang); // sun height -1..1

    // daylight curve: quick transitions around the horizon
    let d = THREE.MathUtils.clamp(h * 2.6 + 0.48, 0, 1);
    d = d * d * (3 - 2 * d);
    this.day = d;
    const rainDim = 1 - e.rain * 0.32 - e.thunder * 0.18;
    this.daylight = d * rainDim;

    // sky (zenith)
    const t = THREE.MathUtils.clamp(e.skyTemp, 0, 1);
    const daySky = this.tmp.setRGB(0.44 - t * 0.04, 0.63 - t * 0.03, 1.0);
    this.skyColor.copy(NIGHT_SKY).lerp(daySky, d);
    // fog/horizon
    this.horizonColor.copy(NIGHT_FOG).lerp(DAY_FOG, d);

    // rain greys everything out
    if (e.rain > 0) {
      const grey = 0.6 * d + 0.04;
      const g = _g.setRGB(grey * 0.92, grey * 0.95, grey);
      const k = e.rain * 0.75;
      this.skyColor.lerp(g, k);
      this.horizonColor.lerp(g, k * 0.9);
      this.skyColor.multiplyScalar(1 - e.thunder * 0.35);
      this.horizonColor.multiplyScalar(1 - e.thunder * 0.3);
    }

    // sunrise / sunset glow
    const sunset = Math.max(0, 1 - Math.abs(h) / 0.32);
    this.sunsetAlpha = sunset * sunset * (1 - e.rain * 0.8);
    const warm = 0.5 + 0.5 * Math.cos(h * Math.PI * 1.6);
    this.sunsetColor.setRGB(1.0, 0.38 + 0.3 * warm, 0.16 + 0.1 * warm);

    // fog colour tinted toward the sunset when looking at the sun (like the classic games do)
    this.fogColor.copy(this.horizonColor);
    const vd = e.viewDir;
    const sh = _sh.set(this.sunDir.x, this.sunDir.z).normalize();
    const vh = _vh.set(vd.x, vd.z);
    if (vh.lengthSq() > 1e-6) vh.normalize();
    const facing = Math.max(0, sh.dot(vh));
    this.fogColor.lerp(this.sunsetColor, this.sunsetAlpha * facing * facing * 0.6);

    // sky light colour for terrain (moonlight is bluish, dusk warm)
    this.skyLight.copy(NIGHT_LIGHT).lerp(DAY_LIGHT, this.daylight);
    const dusk = sunset * d * (1 - e.rain);
    this.skyLight.lerp(DUSK_LIGHT, dusk * 0.35);
    if (e.flash > 0) {
      this.skyLight.lerp(FLASH_LIGHT, e.flash * 0.7);
      this.skyColor.lerp(FLASH_SKY, e.flash * 0.5);
      this.horizonColor.lerp(FLASH_SKY, e.flash * 0.5);
      this.fogColor.lerp(FLASH_SKY, e.flash * 0.5);
    }

    this.cloudColor.setRGB(1, 1, 1).multiply(this.skyLight);
    this.cloudColor.lerp(_c.setRGB(0.45, 0.46, 0.5).multiplyScalar(0.3 + 0.7 * d), e.rain * 0.7);
    this.cloudColor.lerp(this.sunsetColor, dusk * 0.35);

    // block light flicker is applied by the caller
    this.starAlpha = THREE.MathUtils.clamp(1 - d * 1.6, 0, 1) * (1 - e.rain);
  }
}

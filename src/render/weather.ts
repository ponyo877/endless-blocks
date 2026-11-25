import * as THREE from 'three';

// Weather state machine (clear -> rain -> maybe thunder -> clear ...) with smoothed intensities,
// plus precipitation particles (rain streaks / snow flakes) wrapped in a box around the camera.

type State = 'clear' | 'rain' | 'thunder';

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

export class Weather {
  state: State = 'clear';
  /** smoothed overcast / precipitation strength 0..1 */
  rain = 0;
  thunder = 0;
  flash = 0;
  /** visible precipitation (after biome masking), smoothed */
  rainVis = 0;
  snowVis = 0;
  private timer: number;
  private nextFlash = 0;
  private flashPhase = 0;

  constructor(firstClear = rand(240, 480)) {
    this.timer = firstClear;
  }

  /** for the debug key: cycle states */
  cycle(): void {
    this.state = this.state === 'clear' ? 'rain' : this.state === 'rain' ? 'thunder' : 'clear';
    this.timer = this.state === 'clear' ? rand(480, 900) : rand(180, 420);
  }

  /**
   * kind: what the biome under the camera allows ('rain' | 'snow' | 'none').
   * Returns true when a lightning flash starts this frame.
   */
  update(dt: number, kind: 'rain' | 'snow' | 'none'): boolean {
    this.timer -= dt;
    if (this.timer <= 0) {
      if (this.state === 'clear') {
        this.state = Math.random() < 0.22 ? 'thunder' : 'rain';
        this.timer = rand(180, 420);
      } else {
        this.state = 'clear';
        this.timer = rand(480, 1080);
      }
    }
    const tr = this.state === 'clear' ? 0 : 1;
    const tt = this.state === 'thunder' ? 1 : 0;
    // ~20 s fades
    this.rain += (tr - this.rain) * Math.min(1, dt * 0.06);
    this.thunder += (tt - this.thunder) * Math.min(1, dt * 0.05);
    const wantRain = kind === 'rain' ? this.rain : 0;
    const wantSnow = kind === 'snow' ? this.rain : 0;
    this.rainVis += (wantRain - this.rainVis) * Math.min(1, dt * 0.5);
    this.snowVis += (wantSnow - this.snowVis) * Math.min(1, dt * 0.5);

    let fired = false;
    if (this.thunder > 0.6) {
      this.nextFlash -= dt;
      if (this.nextFlash <= 0) {
        this.nextFlash = rand(7, 26);
        this.flashPhase = 0.0001;
        fired = true;
      }
    }
    if (this.flashPhase > 0) {
      this.flashPhase += dt;
      const t = this.flashPhase;
      // double flicker
      this.flash = t < 0.08 ? 1 : t < 0.16 ? 0.25 : t < 0.26 ? 0.85 : Math.max(0, 0.85 - (t - 0.26) * 2.4);
      if (t > 0.7) {
        this.flashPhase = 0;
        this.flash = 0;
      }
    }
    return fired;
  }
}

const BOX = 64;
const BOXH = 48;

const vert = /* glsl */ `
precision highp float;
in vec3 position;     // quad corner: x in [-0.5,0.5], y in [0,1]
in vec4 drop;         // base x, base z, phase, speed factor
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 uCam;    // camera position mod (BOX, BOXH, BOX), computed in float64
uniform float uTime;  // seconds mod period
uniform float uFall;
uniform float uLen;
uniform float uWidth;
uniform float uSway;
out float vFade;
out vec2 vQ;
void main() {
  float H = ${BOXH.toFixed(1)};
  float B = ${BOX.toFixed(1)};
  vec2 xz = mod(drop.xy - uCam.xz + B * 0.5, B) - B * 0.5;
  float fall = uTime * uFall * drop.w;
  float y = mod(drop.z * H - fall - uCam.y + H * 0.5, H) - H * 0.5;
  float sway = sin(uTime * 1.3 + drop.z * 40.0) * uSway;
  vec3 rel = vec3(xz.x + sway, y, xz.y + cos(uTime * 1.1 + drop.x) * uSway);
  vec3 toCam = normalize(vec3(rel.x, 0.0, rel.z) + vec3(1e-4));
  vec3 right = vec3(-toCam.z, 0.0, toCam.x);
  vec3 p = rel + right * position.x * uWidth + vec3(0.0, position.y * uLen, 0.0);
  float d = length(rel.xz);
  vFade = (1.0 - smoothstep(10.0, B * 0.48, d)) * smoothstep(0.6, 2.5, d);
  vQ = position.xy;
  vec4 v = viewMatrix * vec4(p, 0.0);
  gl_Position = projectionMatrix * vec4(v.xyz, 1.0);
}`;

const frag = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform float uAlpha;
uniform float uSnow;
in float vFade;
in vec2 vQ;
out vec4 outColor;
void main() {
  float a = uAlpha * vFade;
  if (uSnow < 0.5) a *= smoothstep(0.0, 0.35, vQ.y) * (1.0 - smoothstep(0.75, 1.0, vQ.y));
  if (a < 0.01) discard;
  outColor = vec4(uColor, a);
}`;

export class Precipitation {
  readonly rainMesh: THREE.Mesh;
  readonly snowMesh: THREE.Mesh;
  private readonly rainMat: THREE.RawShaderMaterial;
  private readonly snowMat: THREE.RawShaderMaterial;
  private time = 0;
  private readonly rc = new THREE.Color();
  private readonly sc = new THREE.Color();

  constructor(count = 2600) {
    const mk = (n: number) => {
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0]), 3));
      g.setIndex([0, 1, 2, 2, 3, 0]);
      const d = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        d[i * 4] = Math.random() * BOX;
        d[i * 4 + 1] = Math.random() * BOX;
        d[i * 4 + 2] = Math.random();
        d[i * 4 + 3] = 0.8 + Math.random() * 0.4;
      }
      g.setAttribute('drop', new THREE.InstancedBufferAttribute(d, 4));
      g.instanceCount = n;
      return g;
    };
    const mkMat = (snow: boolean) =>
      new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: vert,
        fragmentShader: frag,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: {
          uCam: { value: new THREE.Vector3() },
          uTime: { value: 0 },
          uFall: { value: snow ? 2.2 : 26 },
          uLen: { value: snow ? 0.14 : 1.3 },
          uWidth: { value: snow ? 0.14 : 0.045 },
          uSway: { value: snow ? 0.6 : 0.0 },
          uColor: { value: new THREE.Color() },
          uAlpha: { value: 0 },
          uSnow: { value: snow ? 1 : 0 },
        },
      });
    this.rainMat = mkMat(false);
    this.snowMat = mkMat(true);
    this.rainMesh = new THREE.Mesh(mk(count), this.rainMat);
    this.snowMesh = new THREE.Mesh(mk(Math.floor(count * 0.7)), this.snowMat);
    for (const m of [this.rainMesh, this.snowMesh]) {
      m.frustumCulled = false;
      m.matrixAutoUpdate = false;
      m.renderOrder = 8;
    }
  }

  update(cam: THREE.Vector3, dt: number, w: Weather, light: THREE.Color): void {
    this.time = (this.time + dt) % 3600;
    const set = (m: THREE.RawShaderMaterial, a: number, col: THREE.Color) => {
      const u = m.uniforms;
      (u.uCam.value as THREE.Vector3).set(((cam.x % BOX) + BOX) % BOX, ((cam.y % BOXH) + BOXH) % BOXH, ((cam.z % BOX) + BOX) % BOX);
      u.uTime.value = this.time;
      u.uAlpha.value = a;
      (u.uColor.value as THREE.Color).copy(col);
    };
    const rc = this.rc.setRGB(0.62, 0.68, 0.8).multiply(light);
    const sc = this.sc.copy(light);
    set(this.rainMat, w.rainVis * 0.5, rc);
    set(this.snowMat, w.snowVis * 0.9, sc);
    this.rainMesh.visible = w.rainVis > 0.02;
    this.snowMesh.visible = w.snowVis > 0.02;
    // fewer particles for light precipitation
    (this.rainMesh.geometry as THREE.InstancedBufferGeometry).instanceCount = Math.floor(2600 * Math.min(1, 0.3 + w.rainVis));
  }
}

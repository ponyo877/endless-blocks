import * as THREE from 'three';
import { layerInfo } from '../gen/textureNames';
import type { Environment } from './environment';

// Sky: gradient + sunset fan (full-screen triangle), square pixel-art sun and moon (texture-array
// layers), and point stars. Everything sits at the far plane and is drawn inside the main scene after
// the opaque terrain, so the depth test rejects the (usually larger) part of the screen that terrain covers.

const skyVert = /* glsl */ `
precision highp float;
in vec3 position;
out vec2 vNdc;
void main() {
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}`;

const skyFrag = /* glsl */ `
precision highp float;
uniform mat4 uInvViewProj;
uniform vec3 uSky;
uniform vec3 uHorizon;
uniform vec3 uSunset;
uniform float uSunsetAlpha;
uniform vec3 uSunDir;
in vec2 vNdc;
out vec4 outColor;
void main() {
  vec4 p = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec3 dir = normalize(p.xyz / p.w);
  float e = dir.y;
  vec3 col = mix(uHorizon, uSky, smoothstep(-0.02, 0.42, e));
  // below the horizon: horizon colour, slowly darkening
  col = mix(col, uHorizon * 0.82, smoothstep(0.0, -0.5, e));
  // sunset fan around the sun's azimuth, hugging the horizon
  vec2 sh = normalize(uSunDir.xz + vec2(1e-5));
  vec2 dh = normalize(dir.xz + vec2(1e-5));
  float az = max(0.0, dot(sh, dh));
  float band = exp(-max(e + 0.05, 0.0) * 5.5) * smoothstep(-0.35, 0.0, e);
  col = mix(col, uSunset, clamp(uSunsetAlpha * band * (0.25 + 0.75 * az * az), 0.0, 1.0));
  outColor = vec4(col, 1.0);
}`;

const spriteVert = /* glsl */ `
precision highp float;
in vec3 position;
in vec2 uv;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w * 0.9999;
}`;

const spriteFrag = /* glsl */ `
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray uTex;
uniform float uLayer;
uniform float uAlpha;
uniform vec3 uTint;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec4 t = texture(uTex, vec3(vUv, uLayer));
  // additive: weight by alpha and square the halo so only the disc reads as bright
  float k = t.a * t.a * uAlpha;
  outColor = vec4(t.rgb * uTint * k, k);
}`;

const starVert = /* glsl */ `
precision highp float;
in vec3 position;
in float size;
uniform mat4 modelViewMatrix;
uniform mat4 modelMatrix;
uniform mat4 projectionMatrix;
uniform float uPx;
out float vB;
void main() {
  float wy = (modelMatrix * vec4(position, 0.0)).y * 0.01;
  vB = size * smoothstep(-0.02, 0.12, wy);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w * 0.9999;
  gl_PointSize = (size > 0.8 ? 2.0 : 1.0) * uPx;
}`;

const starFrag = /* glsl */ `
precision highp float;
uniform float uAlpha;
in float vB;
out vec4 outColor;
void main() {
  if (vB <= 0.0) discard;
  float b = (0.35 + 0.65 * vB) * uAlpha;
  outColor = vec4(vec3(b), 1.0);
}`;

export class Sky {
  /** add to the main scene; follows the camera */
  readonly root = new THREE.Group();
  private readonly camera = new THREE.PerspectiveCamera(70, 1, 1, 1000);
  private readonly skyMat: THREE.RawShaderMaterial;
  private readonly sun: THREE.Mesh;
  private readonly moon: THREE.Mesh;
  private readonly sunMat: THREE.RawShaderMaterial;
  private readonly moonMat: THREE.RawShaderMaterial;
  private readonly stars: THREE.Points;
  private readonly starMat: THREE.RawShaderMaterial;
  private readonly celestial = new THREE.Group();
  private readonly inv = new THREE.Matrix4();
  private readonly moonLayer: number;

  constructor(tex: THREE.DataArrayTexture) {
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.skyMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: skyVert,
      fragmentShader: skyFrag,
      depthWrite: false,
      depthTest: true, // z = w: only where no terrain was drawn
      uniforms: {
        uInvViewProj: { value: this.inv },
        uSky: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uSunset: { value: new THREE.Color() },
        uSunsetAlpha: { value: 0 },
        uSunDir: { value: new THREE.Vector3() },
      },
    });
    const skyMesh = new THREE.Mesh(tri, this.skyMat);
    skyMesh.frustumCulled = false;
    skyMesh.renderOrder = 4; // after the opaque terrain (0, 1), before the cloud depth prepass (5)
    this.root.add(skyMesh);

    this.root.add(this.celestial);
    const quad = (size: number) => {
      const g = new THREE.PlaneGeometry(size, size);
      return g;
    };
    const mkSprite = (layer: number, additive: boolean) =>
      new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: spriteVert,
        fragmentShader: spriteFrag,
        depthWrite: false,
        depthTest: true,
        // opaque list + additive blending: drawn right after the sky gradient and before the clouds
        transparent: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        uniforms: {
          uTex: { value: tex },
          uLayer: { value: layer },
          uAlpha: { value: 1 },
          uTint: { value: new THREE.Color(1, 1, 1) },
        },
      });
    this.sunMat = mkSprite(layerInfo('sun').index, true);
    this.moonLayer = layerInfo('moon').index;
    this.moonMat = mkSprite(this.moonLayer, true);
    this.sun = new THREE.Mesh(quad(30), this.sunMat);
    this.moon = new THREE.Mesh(quad(22), this.moonMat);
    this.sun.renderOrder = 4.2;
    this.moon.renderOrder = 4.2;
    this.sun.frustumCulled = false;
    this.moon.frustumCulled = false;
    this.root.add(this.sun, this.moon);

    // stars
    const N = 1600;
    const pos = new Float32Array(N * 3);
    const size = new Float32Array(N);
    let s = 1234567;
    const rnd = () => {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < N; i++) {
      const u = rnd() * 2 - 1;
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      pos[i * 3] = r * Math.cos(a) * 100;
      pos[i * 3 + 1] = u * 100;
      pos[i * 3 + 2] = r * Math.sin(a) * 100;
      size[i] = rnd() * rnd();
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sg.setAttribute('size', new THREE.BufferAttribute(size, 1));
    this.starMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: starVert,
      fragmentShader: starFrag,
      depthWrite: false,
      depthTest: true,
      transparent: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uAlpha: { value: 0 }, uPx: { value: 1 } },
    });
    this.stars = new THREE.Points(sg, this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = 4.1;
    this.celestial.add(this.stars);
  }

  rain = 0;

  update(main: THREE.PerspectiveCamera, env: Environment, time: number, dayIndex: number, pixelRatio: number): void {
    const c = this.camera;
    c.fov = main.fov;
    c.aspect = main.aspect;
    c.near = 1;
    c.far = 1000;
    c.updateProjectionMatrix();
    c.position.set(0, 0, 0);
    c.quaternion.copy(main.quaternion);
    c.updateMatrixWorld(true);
    // inverse(view-projection) without translation
    this.inv.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse).invert();
    const u = this.skyMat.uniforms;
    (u.uSky.value as THREE.Color).copy(env.skyColor);
    (u.uHorizon.value as THREE.Color).copy(env.horizonColor);
    (u.uSunset.value as THREE.Color).copy(env.sunsetColor);
    u.uSunsetAlpha.value = env.sunsetAlpha;
    (u.uSunDir.value as THREE.Vector3).copy(env.sunDir);

    const sd = env.sunDir;
    this.root.position.copy(main.position);
    this.sun.position.copy(sd).multiplyScalar(100);
    this.sun.lookAt(main.position);
    this.moon.position.copy(sd).multiplyScalar(-100);
    this.moon.lookAt(main.position);
    const sunUp = THREE.MathUtils.smoothstep(sd.y, -0.14, 0.03);
    const moonUp = THREE.MathUtils.smoothstep(-sd.y, -0.14, 0.03);
    this.sunMat.uniforms.uAlpha.value = sunUp * (1 - this.rain * 0.9);
    this.moonMat.uniforms.uAlpha.value = moonUp * (1 - this.rain * 0.9) * (0.35 + 0.65 * (1 - env.day));
    this.moonMat.uniforms.uLayer.value = this.moonLayer + (((dayIndex % 8) + 8) % 8);
    // stars rotate with the sky
    this.celestial.rotation.set(0, 0, time * Math.PI * 2);
    this.starMat.uniforms.uAlpha.value = env.starAlpha;
    this.starMat.uniforms.uPx.value = pixelRatio;
  }
}

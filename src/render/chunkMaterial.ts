import * as THREE from 'three';

// Terrain materials. Vertices are packed uvec3 (see mesh/mesher.ts). Positions are chunk-local,
// so modelViewMatrix (built in float64 on the CPU) keeps precision far from the origin.

export interface TerrainUniforms {
  uTex: { value: THREE.DataArrayTexture | null };
  uMask: { value: THREE.DataArrayTexture | null };
  uFrame: { value: number };
  uSkyLight: { value: THREE.Color };
  uBlockLight: { value: THREE.Color };
  uGamma: { value: number };
  uFogColor: { value: THREE.Color };
  uFogStart: { value: number };
  uFogEnd: { value: number };
  uViewRotInv: { value: THREE.Matrix3 };
  uWaterAlpha: { value: number };
  [k: string]: { value: unknown };
}

export function createTerrainUniforms(): TerrainUniforms {
  return {
    uTex: { value: null },
    uMask: { value: null },
    uFrame: { value: 0 },
    uSkyLight: { value: new THREE.Color(1, 1, 1) },
    uBlockLight: { value: new THREE.Color(1, 0.86, 0.66) },
    uGamma: { value: 0.55 },
    uFogColor: { value: new THREE.Color(0.75, 0.85, 1) },
    uFogStart: { value: 120 },
    uFogEnd: { value: 160 },
    uViewRotInv: { value: new THREE.Matrix3() },
    uWaterAlpha: { value: 1 },
  };
}

const vert = /* glsl */ `
precision highp float;
precision highp int;
in uvec3 data;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform int uFrame;
uniform mat3 uViewRotInv;
// few varyings: on tile-based GPUs every vertex output is written out and read back per tile
out vec2 vUv;
out vec4 vLight;       // sky light, block light, face shade * AO, horizontal distance (fog)
flat out uvec2 vQuad;  // x: texture layer | flags << 16, y: tint r7 g7 b6 (constant per quad)

const float SHADE[8] = float[8](0.6, 0.6, 1.0, 0.5, 0.8, 0.8, 0.92, 1.0);
const float AO[4] = float[4](0.46, 0.64, 0.82, 1.0);

void main() {
  uint w0 = data.x;
  uint w1 = data.y;
  uint w2 = data.z;
  vec3 pos = vec3(float(w0 & 511u), float(w0 >> 18u), float((w0 >> 9u) & 511u)) * 0.0625 - vec3(2.0, 0.0, 2.0);
  uint layer = (w1 >> 10u) & 1023u;
  uint flags = w1 >> 25u;
  if ((flags & 1u) != 0u) layer += uint(uFrame);
  vUv = vec2(float(w1 & 31u), float((w1 >> 5u) & 31u)) * 0.0625;
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  vec3 rel = uViewRotInv * mv.xyz;
  vLight = vec4(float(w2 & 63u) / 60.0, float((w2 >> 6u) & 63u) / 60.0, SHADE[(w1 >> 20u) & 7u] * AO[(w1 >> 23u) & 3u], length(rel.xz));
  vQuad = uvec2(layer | (flags << 16u), w2 >> 12u);
  gl_Position = projectionMatrix * mv;
}
`;

const frag = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray uTex;
uniform sampler2DArray uMask;
uniform vec3 uSkyLight;
uniform vec3 uBlockLight;
uniform float uGamma;
uniform vec3 uFogColor;
uniform float uFogStart;
uniform float uFogEnd;
uniform float uWaterAlpha;
in vec2 vUv;
in vec4 vLight;
flat in uvec2 vQuad;
out vec4 outColor;

float curve(float l) {
  float b = l / (4.0 - 3.0 * l);
  float g = 1.0 - pow(1.0 - b, 4.0);
  return mix(b, g, uGamma);
}

void main() {
  vec3 uvw = vec3(vUv, float(vQuad.x & 0xffffu));
  uint flags = vQuad.x >> 16u;
  vec4 tex = texture(uTex, uvw);
#ifdef CUTOUT
  if (tex.a < 0.1) discard;
#endif
#ifdef LEAVES_FAST
  // distant leaves are drawn solid: holes become darker leaf colour (cheap: no alpha test)
  tex.rgb *= mix(0.42, 1.0, smoothstep(0.2, 0.9, tex.a));
#endif
  float m = texture(uMask, uvw).r;
  uint t = vQuad.y;
  vec3 tint = vec3(float(t & 127u) / 127.0, float((t >> 7u) & 127u) / 127.0, float(t >> 14u) / 63.0);
  vec3 col = tex.rgb * mix(vec3(1.0), tint, m);
  vec3 light;
  if ((flags & 4u) != 0u) {
    light = vec3(1.0);
  } else {
    float s = curve(vLight.x);
    float b = curve(vLight.y);
    light = uSkyLight * s + uBlockLight * b * (1.0 - 0.35 * s * dot(uSkyLight, vec3(0.333)));
    light = clamp(light, 0.0, 1.0);
    light = max(light, vec3(0.018, 0.018, 0.026));
  }
  col *= light * vLight.z;
  float f = smoothstep(uFogStart, uFogEnd, vLight.w);
  col = mix(col, uFogColor, f);
#ifdef TRANSLUCENT
  float a = tex.a;
  if ((flags & 2u) != 0u) a = mix(a, 1.0, 0.15) * uWaterAlpha;
  outColor = vec4(col, a);
#else
  outColor = vec4(col, 1.0);
#endif
}
`;

export type TerrainPass = 'opaque' | 'cutout' | 'translucent' | 'leavesFast';

export function createTerrainMaterial(uniforms: TerrainUniforms, pass: TerrainPass): THREE.RawShaderMaterial {
  const defines: Record<string, string> = {};
  if (pass === 'cutout') defines.CUTOUT = '1';
  if (pass === 'translucent') defines.TRANSLUCENT = '1';
  if (pass === 'leavesFast') defines.LEAVES_FAST = '1';
  const m = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: vert,
    fragmentShader: frag,
    uniforms,
    defines,
    side: pass === 'cutout' ? THREE.DoubleSide : THREE.FrontSide,
    transparent: pass === 'translucent',
    depthWrite: true,
  });
  return m;
}

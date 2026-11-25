import * as THREE from 'three';
import { Octaves } from '../gen/noise';
import { Rng } from '../gen/rng';

// Blocky cloud layer: a 256x256 binary pattern, each cell a 12x4x12 box, scrolling slowly.
// Each vertex carries its cell centre so a whole cell wraps around the camera at once
// (wrapping per-vertex would stretch quads across the sky).

const CELLS = 256;
const CELL = 12;
const TILE = CELLS * CELL; // 3072
const HEIGHT = 4;
const SUB = 16; // cells per draw tile side
export const CLOUD_Y = 192;

const vert = /* glsl */ `
precision highp float;
in vec3 position;   // local offset within the cell
in vec2 center;     // cell centre in tile space
in float shade;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec2 uOffset;   // (scroll - camera.xz) mod TILE, computed in float64 on the CPU
uniform float uCamY;
uniform float uTile;
out float vShade;
out float vDist;
void main() {
  vec2 c = mod(center + uOffset + uTile * 0.5, uTile) - uTile * 0.5;
  vec3 rel = vec3(c.x + position.x, ${CLOUD_Y.toFixed(1)} + position.y - uCamY, c.y + position.z);
  vShade = shade;
  vDist = length(rel.xz);
  // rotation-only view transform (camera at origin)
  vec4 v = viewMatrix * vec4(rel, 0.0);
  gl_Position = projectionMatrix * vec4(v.xyz, 1.0);
}`;

const frag = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform vec3 uFog;
uniform float uFogStart;
uniform float uFogEnd;
uniform float uAlpha;
in float vShade;
in float vDist;
out vec4 outColor;
void main() {
  float f = smoothstep(uFogStart, uFogEnd, vDist);
  if (uAlpha * (1.0 - f) < 0.03) discard;
  vec3 col = mix(uColor * vShade, uFog, f * 0.85);
  outColor = vec4(col, uAlpha * (1.0 - f));
}`;

export class Clouds {
  readonly group = new THREE.Group();
  private readonly tiles: { depth: THREE.Mesh; color: THREE.Mesh; cx: number; cz: number }[] = [];
  private readonly mat: THREE.RawShaderMaterial;
  private readonly depthMat: THREE.RawShaderMaterial;
  scroll = 0;

  constructor(seed: number) {
    const rng = new Rng(seed ^ 0x51ab);
    const n = new Octaves(rng, 1 / 22, [1, 0.6, 0.35]);
    const n2 = new Octaves(rng, 1 / 70, [1]);
    const grid = new Uint8Array(CELLS * CELLS);
    // periodic sampling on a torus so the pattern tiles seamlessly
    const R = CELLS / (2 * Math.PI);
    for (let z = 0; z < CELLS; z++) {
      for (let x = 0; x < CELLS; x++) {
        const ax = (x / CELLS) * Math.PI * 2;
        const az = (z / CELLS) * Math.PI * 2;
        const px = Math.cos(ax) * R;
        const py = Math.sin(ax) * R;
        const pz = Math.cos(az) * R;
        const pw = Math.sin(az) * R;
        const v = n.sample3(px + pw * 0.7, py, pz) + 0.5 * n2.sample3(pz, pw, px);
        grid[z * CELLS + x] = v > 0.12 ? 1 : 0;
      }
    }
    const at = (x: number, z: number) => grid[((z + CELLS) % CELLS) * CELLS + ((x + CELLS) % CELLS)];
    const h = CELL / 2;
    // geometry split into SUB x SUB-cell tiles so only those near the camera are drawn
    const geos: { g: THREE.BufferGeometry; cx: number; cz: number }[] = [];
    for (let tz = 0; tz < CELLS / SUB; tz++) {
      for (let tx = 0; tx < CELLS / SUB; tx++) {
        const pos: number[] = [];
        const cen: number[] = [];
        const sh: number[] = [];
        const idx: number[] = [];
        const face = (cx: number, cz: number, verts: number[][], shade: number) => {
          const base = pos.length / 3;
          for (const v of verts) {
            pos.push(v[0], v[1], v[2]);
            cen.push(cx, cz);
            sh.push(shade);
          }
          idx.push(base, base + 1, base + 2, base + 2, base + 3, base);
        };
        for (let z = tz * SUB; z < (tz + 1) * SUB; z++) {
          for (let x = tx * SUB; x < (tx + 1) * SUB; x++) {
            if (!grid[z * CELLS + x]) continue;
            const cx = x * CELL + h;
            const cz = z * CELL + h;
            face(cx, cz, [[-h, HEIGHT, h], [h, HEIGHT, h], [h, HEIGHT, -h], [-h, HEIGHT, -h]], 1.0);
            face(cx, cz, [[h, 0, h], [-h, 0, h], [-h, 0, -h], [h, 0, -h]], 0.7);
            if (!at(x + 1, z)) face(cx, cz, [[h, 0, h], [h, 0, -h], [h, HEIGHT, -h], [h, HEIGHT, h]], 0.82);
            if (!at(x - 1, z)) face(cx, cz, [[-h, 0, -h], [-h, 0, h], [-h, HEIGHT, h], [-h, HEIGHT, -h]], 0.82);
            if (!at(x, z + 1)) face(cx, cz, [[-h, 0, h], [h, 0, h], [h, HEIGHT, h], [-h, HEIGHT, h]], 0.9);
            if (!at(x, z - 1)) face(cx, cz, [[h, 0, -h], [-h, 0, -h], [-h, HEIGHT, -h], [h, HEIGHT, -h]], 0.9);
          }
        }
        if (!idx.length) continue;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
        g.setAttribute('center', new THREE.BufferAttribute(new Float32Array(cen), 2));
        g.setAttribute('shade', new THREE.BufferAttribute(new Float32Array(sh), 1));
        g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
        geos.push({ g, cx: (tx + 0.5) * SUB * CELL, cz: (tz + 0.5) * SUB * CELL });
      }
    }
    const uniforms = {
      uOffset: { value: new THREE.Vector2() },
      uCamY: { value: 0 },
      uTile: { value: TILE },
      uColor: { value: new THREE.Color(1, 1, 1) },
      uFog: { value: new THREE.Color() },
      uFogStart: { value: 200 },
      uFogEnd: { value: 400 },
      uAlpha: { value: 0.82 },
    };
    // depth pre-pass so overlapping faces don't double-blend
    this.depthMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: vert, fragmentShader: frag, uniforms,
      colorWrite: false, depthWrite: true, side: THREE.FrontSide,
    });
    this.mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: vert, fragmentShader: frag, uniforms,
      transparent: true, depthWrite: false, depthFunc: THREE.LessEqualDepth, side: THREE.FrontSide,
    });
    for (const t of geos) {
      const d = new THREE.Mesh(t.g, this.depthMat);
      const m = new THREE.Mesh(t.g, this.mat);
      d.renderOrder = 5;
      m.renderOrder = 6;
      for (const o of [d, m]) {
        o.frustumCulled = false;
        o.matrixAutoUpdate = false;
        this.group.add(o);
      }
      this.tiles.push({ depth: d, color: m, cx: t.cx, cz: t.cz });
    }
  }

  update(cam: THREE.Vector3, dt: number, color: THREE.Color, fog: THREE.Color, viewDist: number, alpha: number): void {
    this.scroll += dt * 1.2;
    const u = this.mat.uniforms;
    const ox = (((this.scroll - cam.x) % TILE) + TILE) % TILE;
    const oz = (((-cam.z) % TILE) + TILE) % TILE;
    (u.uOffset.value as THREE.Vector2).set(ox, oz);
    u.uCamY.value = cam.y;
    (u.uColor.value as THREE.Color).copy(color);
    (u.uFog.value as THREE.Color).copy(fog);
    u.uFogStart.value = viewDist * 0.9;
    u.uFogEnd.value = viewDist * 1.9;
    u.uAlpha.value = alpha;
    // draw only tiles that can be inside the fog range
    const range = viewDist * 1.9 + SUB * CELL * 0.75;
    for (const t of this.tiles) {
      const rx = ((((t.cx + ox + TILE / 2) % TILE) + TILE) % TILE) - TILE / 2;
      const rz = ((((t.cz + oz + TILE / 2) % TILE) + TILE) % TILE) - TILE / 2;
      const vis = rx * rx + rz * rz < range * range;
      t.depth.visible = vis;
      t.color.visible = vis;
    }
  }
}

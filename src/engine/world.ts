import * as THREE from 'three';
import type { AmbienceState } from '../audio/ambience';
import { B, isLeaves } from '../gen/blocks';
import { BIOMES, type BiomeInfo } from '../gen/climate';
import { CHUNK } from '../gen/constants';
import { createTerrainUniforms, type TerrainUniforms } from '../render/chunkMaterial';
import { ChunkRenderer } from '../render/chunkRenderer';
import { Clouds } from '../render/clouds';
import { Environment } from '../render/environment';
import { Pacer } from '../render/quality';
import { Sky } from '../render/sky';
import { Streamer } from '../render/streamer';
import { createTextureArrays } from '../render/textureArray';
import { generateTextures } from '../render/textures';
import { Precipitation, Weather } from '../render/weather';

/** blocks: alpha-tested leaves inside, solid leaves beyond */
export const LEAF_LOD = 88;

export interface WorldOptions {
  seed: number;
  renderDistance: number;
  /** compute worker count (0 = auto) */
  workers: number;
  /** upper bound for the device pixel ratio */
  maxPixelRatio?: number;
  /** also ship per-chunk collision classes with every mesh (game mode) */
  collision?: boolean;
}

export interface AreaInfo {
  water: number;
  forest: number;
  ground: number;
  biome: number;
  kind: 'rain' | 'snow' | 'none';
  name: string;
}

export function timeWord(t: number): string {
  if (t < 0.04 || t > 0.96) return 'Dawn';
  if (t < 0.2) return 'Morning';
  if (t < 0.42) return 'Day';
  if (t < 0.54) return 'Evening';
  return 'Night';
}

/**
 * Everything that draws the block world: renderer, scene, chunk streaming, sky, clouds, weather and
 * fog. The viewer and the game each own the camera pose and call the steps below once per frame.
 */
export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly uniforms: TerrainUniforms;
  readonly chunks: ChunkRenderer;
  readonly streamer: Streamer;
  readonly sky: Sky;
  readonly clouds: Clouds;
  readonly precip = new Precipitation();
  readonly env = new Environment();
  readonly weather = new Weather();
  readonly pacer = new Pacer();
  readonly basePixelRatio: number;
  readonly baseRenderDistance: number;
  readonly area: AreaInfo = { water: 0, forest: 0, ground: 64, biome: 1, kind: 'none', name: '' };
  readonly viewDir = new THREE.Vector3();
  fogR: number;
  contextLost = false;
  /** sky/fog colour temperature, eased toward the biome under the camera */
  private skyTemp = 0.6;
  private areaTimer = 0;

  constructor(readonly canvas: HTMLCanvasElement, opts: WorldOptions) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.basePixelRatio = Math.min(opts.maxPixelRatio ?? 1.5, window.devicePixelRatio || 1);
    this.renderer.setPixelRatio(this.basePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.autoClear = false;
    this.scene.matrixAutoUpdate = false;
    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.15, 1000);

    this.uniforms = createTerrainUniforms();
    this.uniforms.uWaterAlpha.value = 0.8;
    const texSet = generateTextures();
    const { color: texColor, mask: texMask } = createTextureArrays(texSet);
    this.uniforms.uTex.value = texColor;
    this.uniforms.uMask.value = texMask;

    this.chunks = new ChunkRenderer(this.uniforms);
    this.scene.add(this.chunks.group);
    this.baseRenderDistance = opts.renderDistance;
    this.streamer = new Streamer(opts.seed, this.chunks, opts.renderDistance, opts.workers, opts.collision ?? false);
    this.sky = new Sky(texColor);
    this.scene.add(this.sky.root);
    this.clouds = new Clouds(opts.seed);
    this.scene.add(this.clouds.group);
    this.scene.add(this.precip.rainMesh, this.precip.snowMesh);
    this.fogR = this.streamer.radius * CHUNK;

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.chunks.clear(); // vertex arrays were released after upload; re-request everything
    });
  }

  resize(): void {
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

  /** fraction of chunks within r chunks of the camera that are meshed */
  ringFraction(r: number): number {
    const cx = Math.floor(this.camera.position.x / CHUNK);
    const cz = Math.floor(this.camera.position.z / CHUNK);
    let n = 0;
    let have = 0;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > r * r) continue;
        n++;
        if (this.chunks.has(cx + dx, cz + dz)) have++;
      }
    }
    return have / n;
  }

  /** biome / ambience sampling around the camera, a few times per second */
  sampleArea(dt: number): void {
    this.areaTimer -= dt;
    if (this.areaTimer <= 0) {
      this.areaTimer = 0.25;
      this.sampleAreaNow();
    }
    const info = BIOMES[this.area.biome];
    if (info) this.skyTemp += (info.temp - this.skyTemp) * Math.min(1, dt * 0.2);
  }

  private sampleAreaNow(): void {
    const area = this.area;
    const cx = this.camera.position.x;
    const cz = this.camera.position.z;
    let n = 0;
    let water = 0;
    let forest = 0;
    for (let j = -3; j <= 3; j++) {
      for (let i = -3; i <= 3; i++) {
        const c = this.chunks.columnAt(cx + i * 10, cz + j * 10);
        if (!c) continue;
        n++;
        if (c.top === B.WATER || c.top === B.ICE) water++;
        else if (isLeaves(c.top)) forest++;
      }
    }
    if (n) {
      area.water = water / n;
      area.forest = forest / n;
    }
    const c = this.chunks.columnAt(cx, cz);
    if (c) {
      area.ground = c.height;
      area.biome = c.biome;
      const info = BIOMES[c.biome];
      area.kind = info ? info.precip : 'rain';
      // high mountains get snow instead of rain
      if (area.kind === 'rain' && this.camera.position.y > 200 && info && info.temp < 0.6) area.kind = 'snow';
      area.name = info ? info.name : '';
    }
  }

  get biomeInfo(): BiomeInfo | undefined {
    return BIOMES[this.area.biome];
  }

  /** weather, sky light and fog for this frame. Call after the camera pose is set. */
  updateEnvironment(dt: number, time: number, clock: number, weatherKind: 'rain' | 'snow' | 'none' = this.area.kind): void {
    const { camera, weather, env, uniforms } = this;
    camera.updateMatrixWorld();
    camera.getWorldDirection(this.viewDir);
    weather.update(dt, weatherKind);
    env.update({ time, rain: weather.rain, thunder: weather.thunder, flash: weather.flash, skyTemp: this.skyTemp, viewDir: this.viewDir });

    // fog follows the (possibly changing) render distance smoothly
    const targetFog = this.streamer.radius * CHUNK;
    this.fogR += (targetFog - this.fogR) * Math.min(1, dt / 3);
    const fogR = this.fogR;
    const wet = Math.max(weather.rainVis, weather.snowVis);
    uniforms.uFogStart.value = fogR * (0.7 - wet * 0.3);
    uniforms.uFogEnd.value = fogR * (0.97 - wet * 0.12);
    uniforms.uFogColor.value.copy(env.fogColor);
    uniforms.uSkyLight.value.copy(env.skyLight);
    uniforms.uFrame.value = Math.floor(clock / 0.16) % 16;
    uniforms.uViewRotInv.value.setFromMatrix4(camera.matrixWorld);
    camera.far = fogR * 2.2 + 64;
    camera.updateProjectionMatrix();
  }

  /** chunk requests, centred on `look` (a point ahead of the camera), plus extra prefetch points */
  stream(look: THREE.Vector3, prefetch: { x: number; z: number }[], now: number): void {
    this.streamer.prefetch = prefetch;
    this.streamer.update(this.camera, look, now);
  }

  /** upload finished meshes under a budget and update per-chunk visibility; returns meshes uploaded */
  uploadAndCull(started: boolean): number {
    const n = this.chunks.processUploads(started ? 5 : 12, started ? 1.5e6 : 6e6, () => true);
    this.chunks.update(this.camera, LEAF_LOD, Math.max(LEAF_LOD, this.fogR * 0.8));
    return n;
  }

  updateSky(dt: number, time: number, dayIndex: number): void {
    const { camera, weather, env } = this;
    this.sky.rain = weather.rain;
    this.sky.update(camera, env, time, dayIndex, this.renderer.getPixelRatio());
    this.clouds.update(camera.position, dt, env.cloudColor, env.fogColor, this.fogR, 0.8 * (1 - weather.rain * 0.25));
    this.precip.update(camera.position, dt, weather, env.skyLight);
  }

  render(): void {
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
  }

  /** adaptive quality: frame rate divisor first, then render scale and distance */
  adaptQuality(dt: number, minRadius = 6): void {
    if (!this.pacer.update(dt)) return;
    const q = this.pacer.current;
    this.renderer.setPixelRatio(this.basePixelRatio * q.scale);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.streamer.radius = Math.max(minRadius, this.baseRenderDistance + q.rdDelta);
  }

  ambienceState(speed: number): AmbienceState {
    const info = this.biomeInfo;
    const { weather, area, env } = this;
    return {
      altitude: Math.max(0, this.camera.position.y - area.ground),
      rain: weather.rainVis,
      snow: weather.snowVis,
      thunder: weather.thunder * (area.kind === 'none' ? 0.3 : 1),
      day: env.day,
      water: area.water,
      forest: area.forest,
      warmth: info ? info.temp : 0.5,
      speed,
    };
  }

  placeLabel(time: number): string {
    const w = this.weather;
    const wx = w.snowVis > 0.3 ? ' · Snow' : w.rainVis > 0.3 ? (w.thunder > 0.5 ? ' · Thunderstorm' : ' · Rain') : '';
    return `${this.area.name} · ${timeWord(time)}${wx}`;
  }
}

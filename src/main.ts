import * as THREE from 'three';
import { Ambience } from './audio/ambience';
import { Autopilot } from './autopilot/camera';
import { PathLog } from './autopilot/path';
import { readConfig } from './config';
import { CHUNK } from './gen/constants';
import { World } from './engine/world';
import { MAX_SPEED, Overlay } from './ui/overlay';
import { Profiler } from './debug/profiler';

const cfg = readConfig();
const BENCH = cfg.bench > 0;
const prof = new Profiler();
const PRE_ROLL = 1500; // blocks of path behind the start, so reverse works right away

// ------------------------------------------------------------------ world
const canvas = document.getElementById('view') as HTMLCanvasElement;
const world = new World(canvas, { seed: cfg.seed, renderDistance: cfg.renderDistance, workers: cfg.workers });
const { renderer, scene, camera, uniforms, chunks, streamer, sky, clouds, precip, env, weather, pacer } = world;
weather.locked = BENCH;
const burnMs = Number([...cfg.exp].find((e) => e.startsWith('burn'))?.slice(4) ?? 0) || 0;
const ambience = new Ambience();

// ------------------------------------------------------------------ path planning
const path = new PathLog();
const planner = new Worker(new URL('./workers/planner.worker.ts', import.meta.url), { type: 'module' });
let requested = PRE_ROLL + 3000;
planner.postMessage({ type: 'init', seed: cfg.seed, need: requested });
planner.onmessage = (e: MessageEvent) => {
  const d = e.data;
  if (d.type === 'samples') path.append(d.s0, d.x, d.y, d.z);
};
const pilot = new Autopilot(path, PRE_ROLL, cfg.speed);

// ------------------------------------------------------------------ UI
let playing = true;
let debug = cfg.debug || BENCH;
document.body.classList.toggle('debug', debug);

function setSpeed(v: number): void {
  pilot.requested = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, v));
  if (!playing && Math.abs(v) > 0.05) togglePlay();
}
function togglePlay(): void {
  playing = !playing;
  pilot.paused = !playing;
  overlay.setPlaying(playing);
}
async function toggleSound(): Promise<void> {
  await ambience.setEnabled(!ambience.enabled);
  overlay.setSound(ambience.enabled);
}
function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen?.().catch(() => undefined);
}
function shareUrl(seed: number): string {
  const u = new URL(location.href);
  u.search = '';
  u.searchParams.set('seed', String(seed));
  return u.toString();
}
function newSeed(): void {
  location.href = shareUrl(Math.floor(Math.random() * 2147483647));
}

const overlay = new Overlay(document.getElementById('ui')!, {
  togglePlay,
  setSpeed,
  toggleSound: () => void toggleSound(),
  toggleFullscreen,
  newSeed,
  copyLink: async () => {
    try {
      await navigator.clipboard.writeText(shareUrl(cfg.seed));
      return true;
    } catch {
      return false;
    }
  },
}, cfg.seed);
overlay.setPlaying(true);
overlay.setSound(false);
overlay.setLoading(0);

const held = { up: false, down: false };
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.code) {
    case 'Space':
      e.preventDefault();
      if (!e.repeat) togglePlay();
      break;
    case 'ArrowUp':
      e.preventDefault();
      held.up = true;
      if (!playing) togglePlay();
      break;
    case 'ArrowDown':
      e.preventDefault();
      held.down = true;
      if (!playing) togglePlay();
      break;
    case 'KeyF':
      toggleFullscreen();
      break;
    case 'KeyM':
      void toggleSound();
      break;
    case 'KeyH':
      overlay.toggleHidden();
      break;
    case 'KeyN':
      newSeed();
      break;
    case 'KeyI':
      debug = !debug;
      document.body.classList.toggle('debug', debug);
      break;
    case 'KeyR':
      if (debug) weather.cycle();
      break;
    case 'KeyT':
      if (debug) timeOffset += 0.125;
      break;
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'ArrowUp') held.up = false;
  if (e.code === 'ArrowDown') held.down = false;
});
window.addEventListener('blur', () => {
  held.up = held.down = false;
});
window.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    const v = pilot.requested;
    setSpeed(v - dy * 0.012 * (1 + Math.abs(v) * 0.08));
  },
  { passive: false },
);

window.addEventListener('resize', () => world.resize());

// ------------------------------------------------------------------ helpers
const tmpP = { x: 0, y: 0, z: 0 };
const look = new THREE.Vector3();
const prefetchPts: { x: number; z: number }[] = [];

/** distance along the path (in travel direction) whose 3x3 chunk corridor is meshed */
function readyDistance(dir: number, maxD: number): number {
  for (let d = 0; d <= maxD; d += 8) {
    const p = path.sample(pilot.s + dir * d, tmpP);
    const cx = Math.floor(p.x / CHUNK);
    const cz = Math.floor(p.z / CHUNK);
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (!chunks.has(cx + i, cz + j)) return d;
  }
  return maxD;
}

// ------------------------------------------------------------------ frame loop
let started = false;
let flightTime = 0;
let clock = 0;
let timeOffset = 0;
let fps = 0;
let fpsAcc = 0;
let fpsN = 0;
let dReady = 0;
let lastNeedSent = requested;
let cpuMs = 0;

let benchState = 0; // 0 waiting, 1 warm-up, 2 recording, 3 done
let benchT = 0;
const gpuPixel = new Uint8Array(4);

function frame(now: number): void {
  requestAnimationFrame(frame);
  // frame pacing (after the world has settled); benchmarks keep it off unless asked for
  const pacing = started && flightTime > 8 && (!BENCH || cfg.exp.has('pacer'));
  if (!pacer.begin(now, pacing)) return;
  prof.mark(0);
  const t0 = performance.now();
  const dt = pacer.frameDt(now);
  const rawMs = pacer.lastInterval;
  if (world.contextLost) return;
  clock += dt;
  fpsAcc += dt;
  fpsN++;
  if (fpsAcc > 0.5) {
    fps = fpsN / fpsAcc;
    fpsAcc = 0;
    fpsN = 0;
  }

  // keep the planner ahead of us
  if (path.length - pilot.s < 3000 && pilot.s + 4500 > lastNeedSent) {
    lastNeedSent = Math.ceil(pilot.s + 4500);
    planner.postMessage({ type: 'need', need: lastNeedSent });
  }
  if (path.length < PRE_ROLL + 64) {
    overlay.setLoading((path.length / (PRE_ROLL + 64)) * 0.3);
    return;
  }

  // speed input
  if (held.up || held.down) {
    const v = pilot.requested;
    const rate = 6 + Math.abs(v) * 0.9;
    setSpeed(v + (held.up ? rate : -rate) * dt);
  }

  const R = streamer.radius;
  const dir = Math.abs(pilot.v) > 0.05 ? Math.sign(pilot.v) : Math.sign(pilot.requested) || 1;
  const cap = Math.max(48, (R - 1) * CHUNK);
  dReady = readyDistance(dir, cap);
  if (started) {
    pilot.setReadiness(dReady, dir, cap);
    pilot.update(dt);
    flightTime += dt;
  }
  pilot.pose(camera);
  camera.updateMatrixWorld();

  prof.mark(1);
  if (!started) {
    const ring = world.ringFraction(Math.min(R, 6));
    const prog = 0.3 + 0.7 * Math.min(ring, dReady / 96);
    overlay.setLoading(prog);
    if (ring >= 1 && dReady >= 96) {
      started = true;
      overlay.setLoading(null);
    }
  }

  // world sampling for biome / ambience
  world.sampleArea(dt);

  // time, weather, environment, fog
  const dayPos = cfg.startTime + timeOffset + (BENCH ? 0 : clock / cfg.dayLength);
  const time = ((dayPos % 1) + 1) % 1;
  world.updateEnvironment(dt, time, clock);

  prof.mark(2);
  // streaming: centre priorities ahead of us along the path, prefetch a bit further
  const ahead = Math.min(R * CHUNK * 0.5, 32 + 3 * Math.abs(pilot.v));
  const lp = path.sample(pilot.s + dir * ahead, tmpP);
  look.set(lp.x, lp.y, lp.z);
  prefetchPts.length = 0;
  for (let d = R * CHUNK; d <= (R + 2) * CHUNK; d += CHUNK) {
    const p = path.sample(pilot.s + dir * d, tmpP);
    prefetchPts.push({ x: p.x, z: p.z });
  }
  world.stream(look, prefetchPts, now);
  prof.mark(3);
  const nUploads = world.uploadAndCull(started);
  prof.mark(4);

  // sky, clouds, precipitation
  world.updateSky(dt, time, Math.floor(dayPos));

  prof.mark(5);
  if (cfg.exp.size) {
    chunks.group.visible = !cfg.exp.has('nochunks');
    clouds.group.visible = !cfg.exp.has('noclouds');
    // simulated slow frames (e.g. exp=burn22): busy-wait to test pacing
    if (burnMs > 0) for (const t1 = performance.now(); performance.now() - t1 < burnMs; );
  }
  world.render();
  let gpuMs = 0;
  if (cfg.gpuSync && prof.recording) {
    const g0 = performance.now();
    const gl = renderer.getContext();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, gpuPixel);
    gpuMs = performance.now() - g0;
  }
  const drawCalls = renderer.info.render.calls;
  const drawTris = renderer.info.render.triangles;
  cpuMs += (performance.now() - t0 - cpuMs) * 0.05;
  prof.mark(6);

  // ambience
  if (ambience.enabled) ambience.update(world.ambienceState(pilot.v), dt);

  // UI
  overlay.tick(dt);
  overlay.setSpeed(pilot.requested, pilot.v);
  overlay.setPlace(world.placeLabel(time));

  // frame rate divisor first, then render scale and distance
  if (pacing) world.adaptQuality(dt);

  if (debug) {
    const st = streamer.stats;
    const p = camera.position;
    overlay.hud.textContent =
      `fps ${fps.toFixed(0)} cpu ${cpuMs.toFixed(1)}ms  miss ${(pacer.missRate * 100).toFixed(0)}%  q${pacer.level} (1/${pacer.current.div} of ${(1000 / pacer.period).toFixed(0)}Hz x${pacer.current.scale} rd ${streamer.radius})\n` +
      `pos ${p.x.toFixed(0)} ${p.y.toFixed(0)} ${p.z.toFixed(0)}  s ${pilot.s.toFixed(0)} / ${path.length}\n` +
      `v ${pilot.v.toFixed(1)} req ${pilot.requested.toFixed(1)} ready ${dReady} (${pilot.readiness.toFixed(2)})\n` +
      `biome ${world.biomeInfo?.name ?? '?'}  time ${time.toFixed(3)}  wx ${weather.state} ${weather.rain.toFixed(2)}\n` +
      `meshes ${chunks.entries.size} pending ${chunks.pendingCount} geo ${renderer.info.memory.geometries} tex ${renderer.info.memory.textures} calls ${renderer.info.render.calls}\n` +
      (st ? `owner ${st.chunks} gen ${st.gen} (${(st.genMs / Math.max(1, st.gen)).toFixed(1)}ms) mesh ${st.mesh} (${(st.meshMs / Math.max(1, st.mesh)).toFixed(1)}ms) cred ${st.credits} fly ${st.inFlight}` : '') +
      ((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
        ? `\nheap ${((performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize / 1048576).toFixed(0)}MB`
        : '');
  }

  prof.endFrame(rawMs, nUploads, chunks.lastUploadBytes, drawCalls, drawTris, gpuMs);
  if (BENCH && started) {
    benchT += dt;
    if (benchState === 0) {
      benchState = 1;
      benchT = 0;
    } else if (benchState === 1 && benchT > 3) {
      benchState = 2;
      if (cfg.exp.has('freeze')) pilot.paused = true;
      benchT = 0;
      prof.start();
    } else if (benchState === 2 && benchT > cfg.bench) {
      benchState = 3;
      const res = prof.summary();
      (window as unknown as Record<string, unknown>).__benchResult = res;
      console.log('[bench]', JSON.stringify(res));
    }
  }
}
requestAnimationFrame(frame);

if (cfg.debug || BENCH) {
  (window as unknown as Record<string, unknown>).__eb = {
    renderer, scene, chunks, clouds, sky, precip, uniforms, pacer, pilot, weather, streamer, camera, env,
    setTime: (t: number) => {
      timeOffset = t - (cfg.startTime + clock / cfg.dayLength);
    },
  };
}

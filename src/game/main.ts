import './game.css';
import * as THREE from 'three';
import { Ambience } from '../audio/ambience';
import { PathLog } from '../autopilot/path';
import { CHUNK } from '../gen/constants';
import { World } from '../engine/world';
import { Bot } from './bot';
import { ChaseCam } from './chaseCam';
import { dailySeed, dayKey } from './daily';
import { Effects } from './fx';
import { Glider } from './glider';
import { Hud } from './hud';
import { GameInput } from './input';
import { Sfx } from './sfx';
import { DT, type GameEvent, GameState, RULES, SIDE_DOWN, type Spawn, step, type TickInput } from './sim';
import { Coll } from '../gen/blocks';
import { ChunkVoxels } from './voxels';
import { RULES_VERSION, SPAWN_S } from './rules';
import { encodeReplay } from './replay';
import * as api from './api';
import { SPAWN_NEED, spawnFromPath } from './spawn';

// ------------------------------------------------------------------ config
const params = new URLSearchParams(location.search);
const touch = matchMedia('(pointer: coarse)').matches;
const seedParam = params.get('seed');
const daily = seedParam === null || seedParam === '';
const day = dayKey();
const seed = daily ? dailySeed(day) : Math.floor(Number(seedParam)) >>> 0 || 1;
const renderDistance = Math.max(4, Math.min(16, Math.floor(Number(params.get('rd')) || (touch ? 7 : 10))));
const debug = params.has('debug');
const botMode = params.has('bot');
const benchSeconds = params.has('bench') ? Number(params.get('bench')) || 30 : 0;
/** today's leaderboard (Daily worlds only, when the build has an API) */
const board = daily && api.rankingEnabled && !botMode ? `daily-${day}` : '';
const START_TIME = 0.08;
/** seconds of flight per in-game day */
const DAY_SECONDS = 900;
const DEG = Math.PI / 180;

// ------------------------------------------------------------------ world
const canvas = document.getElementById('view') as HTMLCanvasElement;
const world = new World(canvas, { seed, renderDistance, workers: 0, collision: true, maxPixelRatio: touch ? 1.25 : 1.5 });
const { camera, chunks, weather, env } = world;
weather.locked = true; // clear skies: everyone flies the same conditions
const voxels = new ChunkVoxels(chunks);
const glider = new Glider();
world.scene.add(glider.object);
const chase = new ChaseCam();
const fx = new Effects();
world.scene.add(fx.group);
const ambience = new Ambience();
const sfx = new Sfx(ambience);

// route planner: only needed for the spawn point (and the benchmark bot)
const path = new PathLog();
const planner = new Worker(new URL('../workers/planner.worker.ts', import.meta.url), { type: 'module' });
let planned = SPAWN_S + (botMode ? 6000 : 300);
planner.postMessage({ type: 'init', seed, need: planned });
planner.onmessage = (e: MessageEvent) => {
  if (e.data.type === 'samples') path.append(e.data.s0, e.data.x, e.data.y, e.data.z);
};

// ------------------------------------------------------------------ storage
const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};
const bestKey = `eb.skim.best.${seed}`;
let best = Number(store.get(bestKey)) || 0;
let soundOn = store.get('eb.skim.sound') !== 'off';

// ------------------------------------------------------------------ UI and input
type Mode = 'loading' | 'title' | 'countdown' | 'play' | 'pause' | 'dead' | 'result';
let mode: Mode = 'loading';

const input = new GameInput(canvas);
input.settings.invertY = store.get('eb.skim.invert') === '1';
const hud = new Hud(document.getElementById('ui')!, {
  play: () => startRun(),
  retry: () => startRun(),
  resume: () => (mode === 'pause' ? resume() : pause()),
  menu: () => toTitle(),
  share: () => share(),
  newWorld: () => {
    location.href = `${location.pathname}?seed=${Math.floor(Math.random() * 2147483646) + 1}`;
  },
  daily: () => {
    location.href = location.pathname;
  },
  toggleSound: () => void setSound(!soundOn),
  submit: (name) => void submitName(name),
  setInvert: (on) => {
    input.settings.invertY = on;
    store.set('eb.skim.invert', on ? '1' : '0');
  },
}, touch);
input.bindBoostButton(hud.boostButton);
input.onPause = () => {
  if (mode === 'play' || mode === 'countdown') pause();
  else if (mode === 'pause') resume();
};
hud.setScreen('loading');
hud.setBest(best);
hud.setSound(soundOn);
hud.setInvert(input.settings.invertY);
hud.setWorld(daily ? `Today's world · ${day}` : `World ${seed}`, best > 0 ? `Your best here: ${best.toLocaleString('en-US')}` : '');
hud.setBoard('title', null, '');
hud.setBoard('result', null, '');
hud.setSubmit({ kind: 'hidden' });

document.addEventListener('pointerlockchange', () => {
  if (!input.pointerLocked && mode === 'play' && !botMode) pause();
});
window.addEventListener('resize', () => world.resize());
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || (e.target as HTMLElement).tagName === 'INPUT') return;
  if ((mode === 'title' || mode === 'result') && (e.code === 'Space' || e.code === 'Enter' || e.code === 'KeyR')) {
    e.preventDefault();
    startRun();
  } else if (e.code === 'KeyM') void setSound(!soundOn);
  else if (e.code === 'KeyI') {
    showDebug = !showDebug;
    dbg.style.display = showDebug ? 'block' : 'none';
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && mode === 'play' && !botMode) pause();
});

async function setSound(on: boolean): Promise<void> {
  soundOn = on;
  store.set('eb.skim.sound', on ? 'on' : 'off');
  hud.setSound(on);
  await ambience.setEnabled(on);
}

let wakeLock: { release(): Promise<void> } | null = null;
async function keepAwake(on: boolean): Promise<void> {
  const nav = navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } };
  try {
    if (on && !wakeLock && nav.wakeLock) wakeLock = await nav.wakeLock.request('screen');
    else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
}

// ------------------------------------------------------------------ run state
let spawn: Spawn = { x: 0, y: 100, z: 0, yaw: 0 };
let state = new GameState(spawn);
let bot: Bot | null = null;
const inputs: TickInput[] = [];
const events: GameEvent[] = [];
let acc = 0;
let countdown = 0;
let deadTimer = 0;
let held = 0; // seconds the simulation waited for the world
let lastCount = 0;
let wasBoosting = false;
// previous tick pose, for interpolation
const prev = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, yawRate: 0 };


function resetRun(): void {
  state = new GameState(spawn);
  inputs.length = 0;
  acc = 0;
  held = 0;
  chase.reset();
  fx.clear();
  savePrev();
  bot = botMode ? new Bot(path, SPAWN_S) : null;
  glider.object.visible = true;
}

function savePrev(): void {
  prev.x = state.x;
  prev.y = state.y;
  prev.z = state.z;
  prev.yaw = state.yaw;
  prev.pitch = state.pitch;
  prev.yawRate = state.yawRate;
}

function startRun(): void {
  if (mode === 'loading') return;
  (document.activeElement as HTMLElement | null)?.blur?.();
  resetRun();
  mode = 'countdown';
  countdown = botMode ? 0.01 : 2.4;
  pending = null;
  ticket = board ? api.startTicket(board).catch(() => null) : null;
  hud.setScreen('play');
  hud.clearEdges();
  if (soundOn && !ambience.enabled) void ambience.setEnabled(true);
  input.setEnabled(true, state.yaw, state.pitch);
  input.requestPointerLock();
  if (touch) void document.documentElement.requestFullscreen?.().catch(() => undefined);
  void keepAwake(true);
}

function pause(): void {
  if (mode !== 'play' && mode !== 'countdown') return;
  pausedFrom = mode;
  mode = 'pause';
  hud.setScreen('pause');
  input.setEnabled(false);
  if (document.pointerLockElement) void document.exitPointerLock();
}
let pausedFrom: Mode = 'play';

function resume(): void {
  if (mode !== 'pause') return;
  mode = pausedFrom;
  hud.setScreen('play');
  input.setEnabled(true, state.yaw, state.pitch);
  input.requestPointerLock();
  acc = 0;
}

function toTitle(): void {
  mode = 'title';
  resetRun();
  hud.setScreen('title');
  input.setEnabled(false);
  hud.setCenter('');
  if (document.pointerLockElement) void document.exitPointerLock();
  void keepAwake(false);
  hud.setWorld(daily ? `Today's world · ${day}` : `World ${seed}`, best > 0 ? `Your best here: ${best.toLocaleString('en-US')}` : '');
  void refreshBoard('title');
}

function finishRun(): void {
  const score = state.finalScore;
  if (state.time > 8 && tutorialRuns < 2) store.set('eb.skim.tutorial', String(++tutorialRuns));
  const newBest = score > best;
  if (newBest) {
    best = score;
    store.set(bestKey, String(best));
    hud.setBest(best);
  }
  mode = 'result';
  hud.setCenter('');
  hud.showResult({
    score, best, newBest, cause: state.cause === 'stall' ? 'stall' : 'crash', hitClass: state.hitClass,
    distance: state.distance, time: state.time, bestChain: state.bestChain, counts: state.counts,
  });
  hud.setScreen('result');
  input.setEnabled(false);
  if (document.pointerLockElement) void document.exitPointerLock();
  void keepAwake(false);
  if (botMode) setTimeout(startRun, 500);
  void offerRun(score);
}

// ------------------------------------------------------------------ leaderboard
let ticket: Promise<api.Ticket | null> | null = null;
/** the finished run waiting for a name (or for a retry after a network error) */
let pending: { ticket: Promise<api.Ticket | null>; claim: Promise<api.RunClaim> } | null = null;
let myRank = 0;
let boardReq = 0;

async function refreshBoard(screen: 'title' | 'result', footer?: string): Promise<void> {
  if (!board) return;
  const id = ++boardReq;
  try {
    const b = await api.fetchBoard(board, 10);
    if (id !== boardReq) return;
    const mine = api.sentBest.get(board);
    if (footer === undefined && mine > 0) {
      const r = await api.fetchRank(board, mine);
      myRank = r.rank;
      hud.setBest(best, myRank);
      footer = `Your best today: #${r.rank} · ${mine.toLocaleString('en-US')}`;
    }
    if (id === boardReq) hud.setBoard(screen, b, api.playerId(), footer ?? '');
  } catch {
    if (id === boardReq) hud.setBoard(screen, null, '');
  }
}

async function offerRun(score: number): Promise<void> {
  hud.setSubmit({ kind: 'hidden' });
  if (!board || !ticket) return;
  const sent = api.sentBest.get(board);
  if (score <= 0 || score <= sent) {
    ticket = null;
    void refreshBoard('result');
    return;
  }
  const runInputs = inputs.slice();
  const s = state;
  const claim = encodeReplay(runInputs).then((replay) => ({
    score, distance: s.distance, ticks: runInputs.length, bestChain: Math.floor(s.bestChain), rules: RULES_VERSION, spawn, replay,
  }));
  pending = { ticket, claim };
  ticket = null;
  const name = api.playerName.get();
  if (name) await submitName(name);
  else {
    hud.setSubmit({ kind: 'form', name: '', msg: 'Enter a name to post this score.' });
    void refreshBoard('result');
  }
}

async function submitName(raw: string): Promise<void> {
  const p = pending;
  if (!p) return;
  const problem = api.nameProblem(raw);
  if (problem) {
    hud.setSubmit({ kind: 'form', name: raw, msg: problem });
    return;
  }
  const name = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  hud.setSubmit({ kind: 'busy', msg: 'Posting score…' });
  try {
    const t = await p.ticket;
    if (!t) {
      if (pending === p) pending = null;
      hud.setSubmit({ kind: 'done', msg: "Couldn't reach the leaderboard.", error: true });
      return;
    }
    const res = await api.submitRun(t, api.playerId(), name, await p.claim);
    api.playerName.set(name);
    api.sentBest.set(board, Math.max(res.best, api.sentBest.get(board)));
    if (pending !== p) return;
    pending = null;
    myRank = res.rank;
    hud.setBest(best, myRank);
    lastRank = res.rank;
    const msg = res.improved
      ? `Posted! #${res.rank} of ${res.total} today as ${name}`
      : `Your best today stays at #${res.rank} (${res.best.toLocaleString('en-US')}).`;
    hud.setSubmit({ kind: 'done', msg });
    void refreshBoard('result', `Your best today: #${res.rank} · ${res.best.toLocaleString('en-US')}`);
  } catch (e) {
    if (pending !== p) return;
    const m = e instanceof Error ? e.message : 'failed';
    if (/name/.test(m)) hud.setSubmit({ kind: 'form', name: raw, msg: "That name isn't allowed. Try another." });
    else if (/token|already|closed|expired|version/.test(m)) {
      pending = null;
      hud.setSubmit({ kind: 'done', msg: `Not posted: ${m}.`, error: true });
    } else hud.setSubmit({ kind: 'form', name: raw, msg: `Not posted (${m}). Try again?` });
  }
}
let lastRank = 0;

function share(): void {
  const score = state.finalScore.toLocaleString('en-US');
  const url = daily ? `${location.origin}${location.pathname}` : `${location.origin}${location.pathname}?seed=${seed}`;
  const rank = lastRank && api.sentBest.get(board) === state.finalScore ? ` and placed #${lastRank}` : '';
  const text = daily ? `I scored ${score}${rank} in today's SKIM world. Can you beat it?` : `I scored ${score} in SKIM (world ${seed}). Can you beat it?`;
  const u = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
  window.open(u, '_blank', 'noopener');
}

// ------------------------------------------------------------------ helpers
/** how far ahead (blocks) the world is loaded with collision data, and whether we may step at all */
function readyAhead(): number {
  // the hitbox and side-ray scans reach ~4 blocks, and one tick moves up to ~1.3 blocks
  const r = RULES.sideRange + RULES.radius + 2;
  for (const [dx, dz] of [[-r, -r], [r, -r], [-r, r], [r, r]]) if (!voxels.loaded(state.x + dx, state.z + dz)) return -1;
  const hx = state.fx;
  const hz = state.fz;
  const hl = Math.hypot(hx, hz) || 1;
  for (let d = 8; d <= 96; d += 8) {
    if (!voxels.loaded(state.x + (hx / hl) * d, state.z + (hz / hl) * d)) return d - 8;
  }
  return 96;
}

const look = new THREE.Vector3();
const prefetch: { x: number; z: number }[] = [];
function updateStreaming(now: number, x: number, z: number, yaw: number, speed: number): void {
  const R = world.streamer.radius;
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const ahead = Math.min(R * CHUNK * 0.5, 32 + 3 * speed);
  look.set(x + fx * ahead, 0, z + fz * ahead);
  prefetch.length = 0;
  for (const a of [0, 35 * DEG, -35 * DEG]) {
    const c = Math.cos(a);
    const s = Math.sin(a);
    const dx = fx * c - fz * s;
    const dz = fx * s + fz * c;
    for (let d = R * CHUNK; d <= (R + 2) * CHUNK; d += CHUNK) prefetch.push({ x: x + dx * d, z: z + dz * d });
  }
  world.stream(look, prefetch, now);
}

const gPos = new THREE.Vector3();
const tipL = new THREE.Vector3();
const tipR = new THREE.Vector3();

/** -1..1: which side the nearest terrain is on (for panning sounds) */
function nearPan(): number {
  const n = state.near;
  if (n.dist === Infinity) return 0;
  const rx = Math.cos(state.yaw);
  const rz = -Math.sin(state.yaw);
  const dx = n.x - state.x;
  const dz = n.z - state.z;
  const l = Math.hypot(dx, n.y - state.y, dz) || 1;
  return (dx * rx + dz * rz) / l;
}
const gFwd = new THREE.Vector3();
let fov = 72;
let shownFov = 0;

function setFov(target: number, dt: number): void {
  fov += (target - fov) * Math.min(1, dt * 4);
  // keep at least ~80 degrees horizontally on portrait screens
  const minV = (2 * Math.atan(Math.tan(40 * DEG) / Math.max(0.3, camera.aspect))) / DEG;
  const v = Math.min(100, Math.max(fov, minV));
  if (Math.abs(v - shownFov) > 0.01) {
    camera.fov = v;
    shownFov = v;
  }
}

// ------------------------------------------------------------------ debug HUD
let showDebug = debug;
const dbg = document.createElement('pre');
dbg.style.cssText = 'position:fixed;right:10px;bottom:10px;margin:0;padding:6px 8px;background:rgba(0,0,0,.5);font-size:11px;pointer-events:none;display:' + (debug ? 'block' : 'none');
document.body.appendChild(dbg);
let fps = 0;
let fpsAcc = 0;
let fpsN = 0;
const bench: number[] = [];
let benchHeld = 0;
let benchT = 0;

// ------------------------------------------------------------------ frame loop
let clock = 0;
let titleT = 0;
let flightClock = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const pacing = mode === 'play' && flightClock > 6;
  if (!world.pacer.begin(now, pacing)) return;
  const dt = world.pacer.frameDt(now);
  if (world.contextLost) return;
  clock += dt;
  fpsAcc += dt;
  fpsN++;
  if (fpsAcc > 0.5) {
    fps = fpsN / fpsAcc;
    fpsAcc = 0;
    fpsN = 0;
  }

  if (mode === 'loading') {
    if (path.length < SPAWN_NEED) {
      hud.setLoading((path.length / SPAWN_NEED) * 0.3);
    } else {
      spawn = spawnFromPath(path);
      if (state.tick === 0 && state.x !== spawn.x) resetRun();
      const ring = world.ringFraction(Math.min(world.streamer.radius, 5));
      hud.setLoading(0.3 + 0.7 * ring);
      if (ring >= 1 && readyAhead() >= 48) {
        mode = 'title';
        hud.setScreen('title');
        void refreshBoard('title');
        if (botMode) startRun();
      }
    }
  }

  // ---- simulation
  if (mode === 'countdown') {
    countdown -= dt;
    input.update(dt, state.yaw, state.pitch);
    const n = Math.ceil(countdown / 0.8);
    if (countdown > 0 && n !== lastCount) {
      lastCount = n;
      sfx.beep(false);
    }
    hud.setCenter(countdown > 0 ? String(n) : '');
    if (countdown <= 0) {
      mode = 'play';
      flightClock = 0;
      lastCount = 0;
      sfx.beep(true);
      hud.setCenter('GO', 'small');
      setTimeout(() => mode === 'play' && hud.setCenter(''), 600);
    }
  } else if (mode === 'play') {
    flightClock += dt;
    input.update(dt, state.yaw, state.pitch);
    const need = 16 + state.speed * 1.2;
    const ready = readyAhead();
    const scale = ready < 0 ? 0 : Math.min(1, Math.max(0.05, ready / need));
    if (scale < 1) held += dt * (1 - scale);
    acc += Math.min(dt, 0.1) * scale;
    let ticks = 0;
    while (acc >= DT && ticks < 8 && state.alive) {
      const inp = bot ? bot.input(state) : input.tick();
      inputs.push(inp);
      savePrev();
      step(state, inp, voxels, events);
      chase.push(state.x, state.y, state.z);
      acc -= DT;
      ticks++;
    }
    if (ticks === 8) acc = 0;
    if (benchSeconds) {
      benchHeld += dt * (1 - scale);
    }
    handleEvents();
    if (!state.alive) {
      mode = 'dead';
      deadTimer = 1.3;
      acc = DT; // freeze the pose at the crash point
    }
  } else if (mode === 'dead') {
    deadTimer -= dt;
    if (deadTimer <= 0) finishRun();
  }

  // ---- glider and camera pose
  const a = mode === 'play' ? Math.min(1, acc / DT) : 1;
  const ix = prev.x + (state.x - prev.x) * a;
  const iy = prev.y + (state.y - prev.y) * a;
  const iz = prev.z + (state.z - prev.z) * a;
  let dyaw = state.yaw - prev.yaw;
  if (dyaw > Math.PI) dyaw -= 2 * Math.PI;
  if (dyaw < -Math.PI) dyaw += 2 * Math.PI;
  const iyaw = prev.yaw + dyaw * a;
  const ipitch = prev.pitch + (state.pitch - prev.pitch) * a;
  const bank = ((prev.yawRate + (state.yawRate - prev.yawRate) * a) / RULES.yawRate) * 0.85;
  gPos.set(ix, iy, iz);
  gFwd.set(-Math.sin(iyaw) * Math.cos(ipitch), Math.sin(ipitch), -Math.cos(iyaw) * Math.cos(ipitch));

  if (mode === 'title' || mode === 'loading') {
    // slow orbit around the waiting glider
    titleT += dt;
    const ang = state.yaw + Math.PI + 0.9 * Math.sin(titleT * 0.12);
    camera.position.set(ix - Math.sin(ang) * 6.5, iy + 1.6 + 0.4 * Math.sin(titleT * 0.3), iz - Math.cos(ang) * 6.5);
    camera.lookAt(ix + gFwd.x * 2, iy + 0.2, iz + gFwd.z * 2);
    setFov(64, dt);
  } else {
    chase.update(camera, gPos, gFwd, bank, voxels, dt);
    const speedT = mode === 'play' ? (state.speed - RULES.speed0) / (RULES.speedMax * RULES.boostSpeed - RULES.speed0) : 0;
    setFov(72 + 14 * Math.max(0, speedT) + (state.boosting ? 4 : 0), dt);
  }
  camera.updateProjectionMatrix();
  glider.set(ix, iy, iz, iyaw, ipitch, bank, env.skyLight);
  camera.updateMatrixWorld();

  // ---- effects and sound
  const flying = mode === 'play' && state.alive;
  const vx = gFwd.x * state.speed;
  const vy = gFwd.y * state.speed;
  const vz = gFwd.z * state.speed;
  if (flying) {
    const n = state.near;
    fx.scrape(dt, state.clearance, n.cls, n.x, n.y, n.z, ix, iy, iz, vx, vy, vz);
    if (state.sideCls[1] === Coll.LIQUID && state.sides & SIDE_DOWN) fx.spray(dt, state.sideDist[1], ix, iy, iz, vx, vz);
    tipL.set(-0.8, 0.04, 0.35);
    tipR.set(0.8, 0.04, 0.35);
    glider.object.localToWorld(tipL);
    glider.object.localToWorld(tipR);
    fx.pushTrail(tipL, tipR, dt);
    if (state.boosting && !wasBoosting) sfx.boostStart();
  }
  wasBoosting = flying && state.boosting;
  const trail = flying ? Math.min(1, 0.35 + Math.max(0, (state.speed - 18) / 30) + (state.boosting ? 0.3 : 0)) : mode === 'dead' ? 0.4 : 0;
  fx.update(dt, camera, gPos, trail, world.renderer.domElement.height, camera.fov);
  sfx.update(flying ? state.graze : 0, nearPan(), state.speed, flying);
  sfx.lowLift(flying && state.lift < 20, state.stalled, clock);

  // ---- world
  world.sampleArea(dt);
  const time = (START_TIME + state.time / DAY_SECONDS) % 1;
  world.updateEnvironment(dt, time, clock, 'none');
  updateStreaming(now, ix, iz, iyaw, state.speed);
  world.uploadAndCull(mode !== 'loading');
  world.updateSky(dt, time, 0);
  world.render();

  if (ambience.enabled) ambience.update(world.ambienceState(mode === 'play' ? state.speed : 4), dt);

  // ---- HUD
  if (mode === 'play' || mode === 'countdown' || mode === 'dead') {
    let aim: { x: number; y: number } | null = null;
    if (input.device === 'mouse' && mode === 'play') {
      const v = new THREE.Vector3(
        ix - Math.sin(input.aimYaw) * Math.cos(input.aimPitch) * 40,
        iy + Math.sin(input.aimPitch) * 40,
        iz - Math.cos(input.aimYaw) * Math.cos(input.aimPitch) * 40,
      ).project(camera);
      aim = { x: (v.x * 0.5) * window.innerWidth, y: (-v.y * 0.5) * window.innerHeight };
    }
    hud.update(state, state.speed * 3.6, aim, input.touch, state.boosting);
    hud.setHint(mode === 'play' ? tutorialHint() : '');
    const lines = mode === 'play' ? Math.max(0, (state.speed - 30) / 30) + (state.boosting ? 0.35 : 0) : 0;
    hud.setSpeedLines(Math.min(0.9, lines));
    if (mode === 'play') {
      if (state.stalled) hud.setCenter('STALL — GET LOW', 'warn');
      else if (state.lift < 20 && !hudCenterBusy()) hud.setCenter('LOW LIFT', 'warn');
      else if (hudCenterBusy() === 'warn') hud.setCenter('');
    }
  } else hud.setSpeedLines(0);

  if (pacing) world.adaptQuality(dt, 5);

  if (showDebug) {
    const st = world.streamer.stats;
    dbg.textContent =
      `fps ${fps.toFixed(0)} q${world.pacer.level} rd ${world.streamer.radius} meshes ${chunks.entries.size}\n` +
      `pos ${state.x.toFixed(1)} ${state.y.toFixed(1)} ${state.z.toFixed(1)} v ${state.speed.toFixed(1)} tick ${state.tick}\n` +
      `clr ${state.clearance === Infinity ? '-' : state.clearance.toFixed(2)} g ${state.graze.toFixed(2)} sides ${state.sides.toString(2).padStart(4, '0')} x${state.encMult}\n` +
      `lift ${state.lift.toFixed(1)} chain ${state.chain.toFixed(0)} x${state.chainMult} held ${held.toFixed(2)}s\n` +
      (st ? `owner ${st.chunks} gen ${st.gen} mesh ${st.mesh}` : '');
  }

  if (benchSeconds && mode === 'play') {
    benchT += dt;
    if (benchT > 3) bench.push(world.pacer.lastInterval);
    if (benchT > benchSeconds + 3 && bench.length) {
      const s = [...bench].sort((x, y) => x - y);
      const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
      const res = { frames: s.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), heldSeconds: benchHeld, rd: world.streamer.radius, speed: state.speed };
      (window as unknown as Record<string, unknown>).__benchResult = res;
      console.log('[bench]', JSON.stringify(res));
      bench.length = 0;
      benchT = -1e9;
    }
  }
}

// first flights only: two short tips while the player finds their feet
const TIPS: [number, number, string][] = [
  [0.5, 5, 'Fly close to the ground, trees and water to score'],
  [6, 11, 'Lift refills near terrain and drains up high'],
];
let tutorialRuns = Number(store.get('eb.skim.tutorial')) || 0;
function tutorialHint(): string {
  if (tutorialRuns >= 2 || botMode) return '';
  const t = flightClock;
  for (const [a, b, text] of TIPS) if (t >= a && t < b) return text;
  return '';
}

function hudCenterBusy(): string {
  const c = document.querySelector('.g-center');
  if (!c || !c.textContent) return '';
  return c.classList.contains('warn') ? 'warn' : 'other';
}

function handleEvents(): void {
  for (const e of events) {
    switch (e.kind) {
      case 'close':
        hud.pop(e.kind, e.pts);
        sfx.whoosh(nearPan());
        break;
      case 'thread':
      case 'skim':
      case 'canopy':
      case 'tube':
        hud.pop(e.kind, e.pts);
        sfx.bonus(e.kind);
        break;
      case 'chain':
        sfx.chain(state.chainMult);
        break;
      case 'bank':
        hud.bank(e.pts);
        sfx.bank(e.pts);
        break;
      case 'crash': {
        glider.object.visible = state.cause === 'stall' && state.hitClass === 0;
        chase.shake = 0.6;
        hud.flashScreen(state.hitClass === 3 ? '#cfe8ff' : '#fff', 0.85);
        hud.setCenter('');
        if (state.hitClass) {
          fx.crash(state.hitClass, state.x, state.y, state.z, state.fx * state.speed, state.fy * state.speed, state.fz * state.speed);
          sfx.crash(state.hitClass === Coll.LIQUID);
        }
        break;
      }
      case 'stall':
        hud.flashScreen('#ff5a3c', 0.25);
        sfx.stall();
        break;
      case 'recover':
        hud.setCenter('');
        break;
    }
  }
  events.length = 0;
}

requestAnimationFrame(frame);

if (debug || benchSeconds) {
  (window as unknown as Record<string, unknown>).__game = {
    world, get state() {
      return state;
    }, inputs, voxels, chase, input, path,
    exportRun: async () => ({ seed, spawn, ticks: inputs.length, score: state.finalScore, distance: state.distance, replay: await encodeReplay(inputs) }),
  };
}

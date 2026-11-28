/**
 * Synthesized ambient soundscape (WebAudio only, no samples).
 *
 * Usage:
 *   const amb = new Ambience();
 *   button.onclick = () => amb.setEnabled(!amb.enabled); // first enable must be in a user gesture
 *   // every frame:
 *   amb.update(state, dt);
 *
 * Node graph (persistent nodes are built once on first enable):
 *
 *   brown loop ─ lowpass ─ gain ──────────────────────────── wind (low rumble)
 *   pink loop A ─ bandpass ─ gain ────────────────────────── wind (rush / whistle)
 *   pink loop B ─ highpass ─ lowpass ─ gain ──────────────── rain hiss
 *               └ bandpass ─ gain ────────────────────────── rain body
 *   pink loop C ─ bandpass ─ swell gain (2 LFOs) ┐
 *               └ bandpass ─ lap gain (events)  ─┴ gain ──── water
 *   3x sine ─ gate (pulse envelopes) ─ pan ─ gain ────────── crickets
 *   one-shots: thunder, bird phrases, droplets ─ buses ──┐
 *                                                        v
 *   master(volume) ─ fade(enable) ─ HP 30 Hz ─ high shelf -5 dB ─ LP 10 kHz ─ compressor ─ out
 */

export interface AmbienceState {
  altitude: number; // camera height above the ground below it, in blocks (0..~120)
  rain: number; // 0..1 rain intensity (0 when snowing)
  snow: number; // 0..1 snowfall intensity
  thunder: number; // 0..1 storminess (probability/intensity of thunder rumbles)
  day: number; // 0 = deep night, 1 = full day (smooth across dusk/dawn)
  water: number; // 0..1 fraction of water in the area below the camera
  forest: number; // 0..1 tree density in the area below the camera
  warmth: number; // 0 = frozen biome .. 1 = hot biome
  speed: number; // camera speed in blocks/s (can be negative; use |speed| for wind rush)
}

const DEFAULT_VOLUME = 0.6;
const PARAM_INTERVAL = 1 / 15; // audio-param refresh rate (s)
const MAX_VOICES = 40; // cap on concurrently alive one-shot voices
const NOISE_RMS = 0.25;

type NoiseKind = 'pink' | 'brown';

function noop(): void {
  /* swallow */
}
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
function clampRange(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
function finite(x: number): number {
  return Number.isFinite(x) ? x : 0;
}
function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
function rand(a: number, b: number): number {
  return a + (b - a) * Math.random();
}
function randInt(lo: number, hi: number): number {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** Smoothed AudioParam setter; skips redundant updates so the event timeline stays small. */
class Smooth {
  private last = -1;
  constructor(
    private readonly param: AudioParam,
    private readonly tau: number,
    private readonly step: number,
  ) {}
  to(v: number, t: number): void {
    const d = v - this.last;
    if (d < this.step && d > -this.step) return;
    this.last = v;
    this.param.setTargetAtTime(v, t, this.tau);
  }
}

// ---------------------------------------------------------------------------
// Buffer generation (runs once)

function fillNoise(out: Float32Array, kind: NoiseKind): void {
  const n = out.length;
  if (kind === 'brown') {
    let b = 0;
    for (let i = 0; i < n; i++) {
      b = (b + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      out[i] = b;
    }
    return;
  }
  // Paul Kellet's pink noise filter
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
}

/**
 * Stereo noise loop with independent channels. The extra tail is cross-faded
 * (equal power) into the head, so the loop point continues the signal seamlessly.
 */
function makeNoise(ctx: BaseAudioContext, seconds: number, kind: NoiseKind): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(seconds * sr);
  const xf = Math.floor(0.5 * sr);
  const tmp = new Float32Array(len + xf);
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    fillNoise(tmp, kind);
    let mean = 0;
    for (let i = 0; i < tmp.length; i++) mean += tmp[i];
    mean /= tmp.length;
    const out = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) out[i] = tmp[i] - mean;
    for (let i = 0; i < xf; i++) {
      const x = i / xf;
      out[i] = (tmp[i] - mean) * Math.sqrt(x) + (tmp[len + i] - mean) * Math.sqrt(1 - x);
    }
    let sum = 0;
    for (let i = 0; i < len; i++) sum += out[i] * out[i];
    const k = NOISE_RMS / (Math.sqrt(sum / len) || 1);
    for (let i = 0; i < len; i++) out[i] *= k;
  }
  return buf;
}

/** Short soft "tick" of a raindrop: band-limited noise click plus a faint rising ping. */
function makeDroplet(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(0.09 * sr);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const f0 = rand(1500, 2800);
  const tauN = rand(0.002, 0.005);
  const tauT = rand(0.006, 0.014);
  const aLp = 1 - Math.exp((-2 * Math.PI * 4500) / sr);
  const aHp = Math.exp((-2 * Math.PI * 700) / sr);
  let lp = 0, hpIn = 0, hp = 0, phase = 0, peak = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    lp += aLp * (Math.random() * 2 - 1 - lp);
    hp = aHp * (hp + lp - hpIn);
    hpIn = lp;
    phase += (2 * Math.PI * f0 * (1 + 0.5 * Math.min(1, t / 0.015))) / sr;
    const v = (hp * Math.exp(-t / tauN) + 0.3 * Math.sin(phase) * Math.exp(-t / tauT)) * Math.min(1, t / 0.0008);
    d[i] = v;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  const k = 0.8 / (peak || 1);
  for (let i = 0; i < len; i++) d[i] *= k;
  return buf;
}

function biquad(ctx: BaseAudioContext, type: BiquadFilterType, freq: number, q: number, gainDb = 0): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q; // dB for lowpass/highpass, linear for bandpass
  f.gain.value = gainDb;
  return f;
}

function createContext(): AudioContext | null {
  const w = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const C = w.AudioContext ?? w.webkitAudioContext;
  if (!C) return null;
  try {
    return new C({ latencyHint: 'playback' });
  } catch {
    try {
      return new C();
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Birds

const UP = 0, DOWN = 1, CHEVRON = 2, WHISTLE = 3, TRILL = 4;

interface Species {
  base: number; // Hz
  spread: number; // sweep excursion ratio
  noteDur: number;
  noteGap: number;
  repGap: number;
  motif: number[]; // note shapes repeated to form a phrase
  minReps: number;
  maxReps: number;
  drift: number; // per-note pitch drift
  fmRate: number;
  fmDepth: number;
  endTrill: boolean;
}

function makeSpecies(): Species {
  const motif: number[] = [];
  const motifLen = randInt(1, 3);
  for (let i = 0; i < motifLen; i++) motif.push(randInt(0, 4));
  const fast = Math.random() < 0.5;
  return {
    base: rand(2000, 4000),
    spread: rand(1.15, 1.45),
    noteDur: fast ? rand(0.04, 0.09) : rand(0.1, 0.26),
    noteGap: fast ? rand(0.03, 0.07) : rand(0.06, 0.16),
    repGap: rand(0, 0.12),
    motif,
    minReps: fast ? 3 : 1,
    maxReps: fast ? 6 : 3,
    drift: rand(0.965, 1.02),
    fmRate: rand(22, 45),
    fmDepth: rand(0.04, 0.1),
    endTrill: Math.random() < 0.35,
  };
}

// ---------------------------------------------------------------------------

interface CricketVoice {
  gate: GainNode;
  pulseRate: number;
  pulses: number;
  period: number;
  next: number; // audio time of next chirp
}

interface Graph {
  ctx: AudioContext;
  nodes: AudioNode[]; // persistent nodes (for dispose)
  sources: AudioScheduledSourceNode[]; // persistent running sources
  brown: AudioBuffer;
  pink: AudioBuffer;
  drops: AudioBuffer[];
  master: GainNode;
  fade: GainNode;
  windLowGain: Smooth;
  windLowCut: Smooth;
  windHighGain: Smooth;
  windHighFreq: Smooth;
  rainGain: Smooth;
  rainCut: Smooth;
  rainBodyGain: Smooth;
  waterGain: Smooth;
  insectGain: Smooth;
  lapGain: GainNode;
  lapBP: BiquadFilterNode;
  thunderBus: GainNode;
  birdBus: GainNode;
  dropPans: StereoPannerNode[];
  crickets: CricketVoice[];
}

export class Ambience {
  private g: Graph | null = null;
  private _enabled = false;
  private disposed = false;
  private volume = DEFAULT_VOLUME;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingResolve: (() => void) | null = null;

  private readonly species: Species[] = [];

  // internal clock and event schedule (seconds on `clock`; -1 = not scheduled)
  private clock = 0;
  private paramTimer = 0;
  private lastResumeTry = 0;
  private nextGust = 0;
  private nextThunder = -1;
  private nextBird = -1;
  private nextDrop = -1;
  private nextLap = 0;
  private voices = 0;

  // smoothed inputs
  private primed = false;
  private sAlt = 0;
  private sRain = 0;
  private sSnow = 0;
  private sThunder = 0;
  private sDay = 1;
  private sWater = 0;
  private sForest = 0;
  private sWarmth = 0.5;
  private sSpeed = 0;
  private gust = 1;
  private gustTarget = 1;

  // derived levels (refreshed at PARAM_INTERVAL)
  private birdLevel = 0;
  private insectLevel = 0;
  private waterLevel = 0;
  private dropRate = 0;

  constructor() {
    for (let i = 0; i < 5; i++) this.species.push(makeSpecies());
  }

  get enabled(): boolean {
    return this._enabled;
  }

  /**
   * The audio context and the bus that sound effects can connect to (it shares the ambience's
   * volume, enable fade and output chain), or null before the first enable.
   */
  get output(): { ctx: AudioContext; bus: AudioNode; pink: AudioBuffer; brown: AudioBuffer } | null {
    const g = this.g;
    return g ? { ctx: g.ctx, bus: g.master, pink: g.pink, brown: g.brown } : null;
  }

  async setEnabled(on: boolean): Promise<void> {
    if (this.disposed) return;
    if (on) {
      // Everything up to the first await runs synchronously inside the caller's user gesture.
      if (this.g === null) {
        this.g = this.build();
        if (this.g === null) return; // WebAudio unavailable
      }
      const g = this.g;
      this.cancelPendingSuspend();
      this._enabled = true;
      this.paramTimer = 0;
      const resume = g.ctx.resume();
      this.rampFade(1, 0.5);
      try {
        await resume;
      } catch {
        /* update() retries periodically */
      }
      return;
    }
    if (!this._enabled || this.g === null) {
      this._enabled = false;
      return;
    }
    this._enabled = false;
    this.cancelPendingSuspend();
    this.rampFade(0, 0.22); // ~1% after 1 s
    await new Promise<void>((resolve) => {
      this.pendingResolve = resolve;
      this.suspendTimer = setTimeout(() => {
        this.suspendTimer = null;
        this.pendingResolve = null;
        const g = this.g;
        if (this._enabled || this.disposed || g === null) {
          resolve();
          return;
        }
        g.ctx.suspend().then(() => {
          // re-enabled while the suspend was in flight
          if (this._enabled && this.g === g) g.ctx.resume().catch(noop);
          resolve();
        }, () => resolve());
      }, 1050);
    });
  }

  setVolume(v: number): void {
    if (!Number.isFinite(v)) return;
    this.volume = clamp01(v);
    const g = this.g;
    if (g !== null) g.master.gain.setTargetAtTime(this.volume * this.volume, g.ctx.currentTime, 0.08);
  }

  update(state: AmbienceState, dt: number): void {
    if (!this._enabled) return;
    const g = this.g;
    if (g === null) return;
    dt = dt > 0 ? (dt < 0.25 ? dt : 0.25) : 0;
    this.clock += dt;
    const ctx = g.ctx;
    if (ctx.state !== 'running') {
      if (this.clock - this.lastResumeTry > 3) {
        this.lastResumeTry = this.clock;
        ctx.resume().catch(noop);
      }
      return;
    }

    // --- smooth inputs
    const alt = clampRange(finite(state.altitude), 0, 400);
    const rain = clamp01(finite(state.rain));
    const snow = clamp01(finite(state.snow));
    const thunder = clamp01(finite(state.thunder));
    const day = clamp01(finite(state.day));
    const water = clamp01(finite(state.water));
    const forest = clamp01(finite(state.forest));
    const warmth = clamp01(finite(state.warmth));
    const speed = Math.min(200, Math.abs(finite(state.speed)));
    if (!this.primed) {
      this.primed = true;
      this.sAlt = alt; this.sRain = rain; this.sSnow = snow; this.sThunder = thunder; this.sDay = day;
      this.sWater = water; this.sForest = forest; this.sWarmth = warmth; this.sSpeed = speed;
    } else {
      const k = 1 - Math.exp(-dt / 0.8);
      this.sAlt += (alt - this.sAlt) * k;
      this.sRain += (rain - this.sRain) * k;
      this.sSnow += (snow - this.sSnow) * k;
      this.sThunder += (thunder - this.sThunder) * k;
      this.sDay += (day - this.sDay) * k;
      this.sWater += (water - this.sWater) * k;
      this.sForest += (forest - this.sForest) * k;
      this.sWarmth += (warmth - this.sWarmth) * k;
      this.sSpeed += (speed - this.sSpeed) * k;
    }

    // --- slow random gusts (smoothed random walk)
    if (this.clock >= this.nextGust) {
      const storm = Math.max(this.sThunder, this.sRain * 0.7);
      const depth = Math.min(0.5, 0.2 + 0.28 * storm + 0.12 * clamp01(this.sAlt / 100));
      this.gustTarget = 1 + depth * (Math.random() * 2 - 1);
      this.nextGust = this.clock + rand(1.8, 6);
    }
    this.gust += (this.gustTarget - this.gust) * (1 - Math.exp(-dt / 1.8));

    const now = ctx.currentTime;
    this.paramTimer -= dt;
    if (this.paramTimer <= 0) {
      this.paramTimer = PARAM_INTERVAL;
      this.pushParams(g, now);
    }
    this.runEvents(g, now);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this._enabled = false;
    this.cancelPendingSuspend();
    const g = this.g;
    this.g = null;
    if (g === null) return;
    for (const s of g.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    for (const n of g.nodes) n.disconnect();
    g.ctx.close().catch(noop);
  }

  // -------------------------------------------------------------------------

  private cancelPendingSuspend(): void {
    if (this.suspendTimer !== null) {
      clearTimeout(this.suspendTimer);
      this.suspendTimer = null;
    }
    const r = this.pendingResolve;
    this.pendingResolve = null;
    if (r) r();
  }

  private rampFade(target: number, tau: number): void {
    const g = this.g;
    if (g === null) return;
    const p = g.fade.gain;
    const now = g.ctx.currentTime;
    p.cancelScheduledValues(now);
    p.setValueAtTime(p.value, now);
    p.setTargetAtTime(target, now, tau);
  }

  private build(): Graph | null {
    const ctx = createContext();
    if (ctx === null) return null;
    const nodes: AudioNode[] = [];
    const sources: AudioScheduledSourceNode[] = [];
    const keep = <T extends AudioNode>(n: T): T => {
      nodes.push(n);
      return n;
    };
    const gainNode = (v: number): GainNode => {
      const n = keep(ctx.createGain());
      n.gain.value = v;
      return n;
    };

    // master chain
    const master = gainNode(this.volume * this.volume);
    const fade = gainNode(0);
    const hp = keep(biquad(ctx, 'highpass', 30, -3));
    const shelf = keep(biquad(ctx, 'highshelf', 3500, 0, -5));
    const lp = keep(biquad(ctx, 'lowpass', 10000, -3));
    const comp = keep(ctx.createDynamicsCompressor());
    comp.threshold.value = -14;
    comp.knee.value = 6;
    comp.ratio.value = 12;
    comp.attack.value = 0.004;
    comp.release.value = 0.3;
    master.connect(fade);
    fade.connect(hp);
    hp.connect(shelf);
    shelf.connect(lp);
    lp.connect(comp);
    comp.connect(ctx.destination);

    const brown = makeNoise(ctx, 7, 'brown');
    const pink = makeNoise(ctx, 9, 'pink');
    const drops: AudioBuffer[] = [];
    for (let i = 0; i < 5; i++) drops.push(makeDroplet(ctx));

    const loops: Array<[AudioBufferSourceNode, number]> = [];
    const oscs: OscillatorNode[] = [];
    const loop = (buf: AudioBuffer, offset: number): AudioBufferSourceNode => {
      const s = keep(ctx.createBufferSource());
      s.buffer = buf;
      s.loop = true;
      sources.push(s);
      loops.push([s, offset]);
      return s;
    };

    // wind
    const srcBrown = loop(brown, 0);
    const windLP = keep(biquad(ctx, 'lowpass', 300, 1));
    const windLowG = gainNode(0);
    srcBrown.connect(windLP);
    windLP.connect(windLowG);
    windLowG.connect(master);

    const srcPinkA = loop(pink, 0);
    const windBP = keep(biquad(ctx, 'bandpass', 900, 0.9));
    const windHighG = gainNode(0);
    srcPinkA.connect(windBP);
    windBP.connect(windHighG);
    windHighG.connect(master);

    // rain
    const srcPinkB = loop(pink, 3.1);
    const rainHP = keep(biquad(ctx, 'highpass', 900, -3));
    const rainLP = keep(biquad(ctx, 'lowpass', 4000, -3));
    const rainG = gainNode(0);
    srcPinkB.connect(rainHP);
    rainHP.connect(rainLP);
    rainLP.connect(rainG);
    rainG.connect(master);
    const rainBodyBP = keep(biquad(ctx, 'bandpass', 500, 0.5));
    const rainBodyG = gainNode(0);
    srcPinkB.connect(rainBodyBP);
    rainBodyBP.connect(rainBodyG);
    rainBodyG.connect(master);

    // water: slow swell (two incommensurate LFOs) + lapping (event-driven)
    const srcPinkC = loop(pink, 6.3);
    const waterG = gainNode(0);
    waterG.connect(master);
    const swellBP = keep(biquad(ctx, 'bandpass', 380, 0.9));
    const swellMod = gainNode(0.55);
    srcPinkC.connect(swellBP);
    swellBP.connect(swellMod);
    swellMod.connect(waterG);
    const lfoRates = [0.09, 0.153];
    const lfoDepths = [0.25, 0.17];
    for (let i = 0; i < 2; i++) {
      const o = keep(ctx.createOscillator());
      o.frequency.value = lfoRates[i];
      const d = gainNode(lfoDepths[i]);
      o.connect(d);
      d.connect(swellMod.gain);
      sources.push(o);
      oscs.push(o);
    }
    const lapBP = keep(biquad(ctx, 'bandpass', 950, 1.3));
    const lapG = gainNode(0.22);
    srcPinkC.connect(lapBP);
    lapBP.connect(lapG);
    lapG.connect(waterG);

    // one-shot buses
    const thunderBus = gainNode(1);
    thunderBus.connect(master);
    const birdBus = gainNode(1);
    birdBus.connect(master);
    const dropBus = gainNode(1);
    dropBus.connect(master);
    const dropPans: StereoPannerNode[] = [];
    for (let i = 0; i < 5; i++) {
      const p = keep(ctx.createStereoPanner());
      p.pan.value = -0.8 + i * 0.4;
      p.connect(dropBus);
      dropPans.push(p);
    }

    // crickets: steady sines gated by scheduled pulse envelopes
    const insectG = gainNode(0);
    insectG.connect(master);
    const crickets: CricketVoice[] = [];
    for (let i = 0; i < 3; i++) {
      const o = keep(ctx.createOscillator());
      o.frequency.value = rand(3900, 5100);
      const gate = gainNode(0);
      const p = keep(ctx.createStereoPanner());
      p.pan.value = (i - 1) * 0.55 + rand(-0.15, 0.15);
      o.connect(gate);
      gate.connect(p);
      p.connect(insectG);
      sources.push(o);
      oscs.push(o);
      crickets.push({ gate, pulseRate: rand(26, 40), pulses: randInt(3, 5), period: rand(0.45, 1.1), next: 0 });
    }

    const t = ctx.currentTime;
    for (const [s, offset] of loops) s.start(t, offset);
    for (const o of oscs) o.start(t);

    return {
      ctx, nodes, sources, brown, pink, drops, master, fade,
      windLowGain: new Smooth(windLowG.gain, 0.4, 0.0005),
      windLowCut: new Smooth(windLP.frequency, 0.5, 2),
      windHighGain: new Smooth(windHighG.gain, 0.4, 0.001),
      windHighFreq: new Smooth(windBP.frequency, 0.5, 4),
      rainGain: new Smooth(rainG.gain, 0.6, 0.001),
      rainCut: new Smooth(rainLP.frequency, 0.6, 10),
      rainBodyGain: new Smooth(rainBodyG.gain, 0.6, 0.001),
      waterGain: new Smooth(waterG.gain, 0.8, 0.001),
      insectGain: new Smooth(insectG.gain, 1.0, 0.0002),
      lapGain: lapG, lapBP, thunderBus, birdBus, dropPans, crickets,
    };
  }

  /** Map smoothed state to bed levels / filter settings. Levels calibrated for noise RMS 0.25. */
  private pushParams(g: Graph, now: number): void {
    const alt = this.sAlt;
    const altN = clamp01(alt / 100);
    const spdN = clamp01(this.sSpeed / 30);
    const rain = this.sRain;
    const snow = this.sSnow;
    const storm = Math.max(this.sThunder, rain * 0.7);
    const gust = this.gust;

    // wind: louder and brighter with altitude / speed; snow muffles it
    const energy = Math.min(1.2, 0.28 + 0.42 * altN + 0.3 * spdN + 0.3 * storm);
    g.windLowGain.to(0.6 * energy * gust * (1 - 0.4 * snow), now);
    g.windLowCut.to((220 + 420 * altN + 300 * spdN + 250 * storm) * (0.7 + 0.3 * gust) * (1 - 0.5 * snow), now);
    const hi = Math.min(1.1, 0.18 + 0.55 * altN * altN + 0.45 * spdN * Math.sqrt(spdN) + 0.25 * storm);
    g.windHighGain.to(1.05 * hi * gust * gust * (1 - 0.6 * snow), now);
    g.windHighFreq.to((550 + 800 * altN + 700 * spdN) * (0.8 + 0.3 * gust) * (1 - 0.4 * snow), now);

    // rain
    g.rainGain.to(1.2 * Math.pow(rain, 1.3), now);
    g.rainCut.to(2600 + 3400 * rain, now);
    g.rainBodyGain.to(0.68 * rain * rain * (1 - 0.5 * altN), now);
    this.dropRate = rain > 0.3 ? ((rain - 0.3) / 0.7) * 4 * (1 - 0.5 * altN) : 0;

    // water
    this.waterLevel = this.sWater * (1 - smoothstep(6, 55, alt)) * (1 - 0.35 * rain) * (1 - 0.3 * snow);
    g.waterGain.to(1.5 * this.waterLevel, now);

    // birds (event-driven)
    this.birdLevel =
      smoothstep(0.55, 0.85, this.sDay) *
      smoothstep(0.15, 0.5, this.sForest) *
      (1 - smoothstep(12, 40, alt)) *
      (1 - smoothstep(0.02, 0.12, rain)) *
      (1 - 0.7 * smoothstep(0.05, 0.4, snow));

    // night insects
    this.insectLevel =
      (1 - smoothstep(0.12, 0.42, this.sDay)) *
      smoothstep(0.3, 0.45, this.sWarmth) *
      (1 - smoothstep(0.02, 0.1, rain)) *
      (1 - smoothstep(0.02, 0.1, snow)) *
      (1 - 0.85 * smoothstep(15, 70, alt));
    g.insectGain.to(0.05 * this.insectLevel, now);
  }

  private runEvents(g: Graph, now: number): void {
    const c = this.clock;

    // thunder: 20–90 s apart, more often when stormier
    if (this.sThunder > 0.03) {
      if (this.nextThunder < 0) this.nextThunder = c + rand(6, 25);
      else if (c >= this.nextThunder) {
        this.playThunder(g, now + 0.05, this.sThunder);
        this.nextThunder = c + rand(20, Math.max(25, 90 - 55 * this.sThunder));
      }
    } else this.nextThunder = -1;

    // birds: phrase, then 3–12 s of silence
    if (this.birdLevel > 0.03) {
      if (this.nextBird < 0) this.nextBird = c + rand(1, 5);
      else if (c >= this.nextBird) {
        const dur = this.playBirdPhrase(g, now + 0.03, this.birdLevel);
        this.nextBird = c + dur + 3 + 9 * Math.pow(Math.random(), 0.5 + this.birdLevel);
      }
    } else this.nextBird = -1;

    // rain droplets (Poisson)
    if (this.dropRate > 0.01) {
      if (this.nextDrop < 0) this.nextDrop = c + 0.05 - Math.log(1 - Math.random()) / this.dropRate;
      else if (c >= this.nextDrop) {
        this.playDrop(g, now + 0.01 + Math.random() * 0.02);
        this.nextDrop = c + 0.05 - Math.log(1 - Math.random()) / this.dropRate;
      }
    } else this.nextDrop = -1;

    // water lapping: gentle bumps on the lap band
    if (this.waterLevel > 0.02 && c >= this.nextLap) {
      const t = now + Math.random() * 0.1;
      const p = g.lapGain.gain;
      p.setTargetAtTime(rand(0.5, 1), t, rand(0.08, 0.2));
      p.setTargetAtTime(0.22, t + rand(0.25, 0.6), rand(0.35, 0.8));
      g.lapBP.frequency.setTargetAtTime(rand(650, 1300), t, rand(0.2, 0.5));
      this.nextLap = c + rand(0.9, 3.2);
    }

    // crickets: schedule pulse trains slightly ahead in audio time
    if (this.insectLevel > 0.01) {
      const horizon = now + 0.15;
      const cr = g.crickets;
      for (let i = 0; i < cr.length; i++) {
        const v = cr[i];
        if (v.next < now) v.next = now + rand(0.05, 1.2);
        while (v.next < horizon) {
          const a = rand(0.65, 1);
          const step = 1 / v.pulseRate;
          const p = v.gate.gain;
          for (let k = 0; k < v.pulses; k++) {
            const tp = v.next + k * step;
            p.setTargetAtTime(a, tp, 0.002);
            p.setTargetAtTime(0, tp + step * 0.5, 0.0035);
          }
          v.next += v.period * rand(0.9, 1.1);
          if (Math.random() < 0.05) v.next += rand(2, 7); // occasional pause
        }
      }
    }
  }

  private playDrop(g: Graph, t: number): void {
    if (this.voices >= MAX_VOICES) return;
    const ctx = g.ctx;
    const src = ctx.createBufferSource();
    src.buffer = g.drops[Math.floor(Math.random() * g.drops.length)];
    src.playbackRate.value = rand(0.75, 1.3);
    const amp = ctx.createGain();
    amp.gain.value = rand(0.03, 0.1) * (0.5 + 0.5 * this.sRain);
    src.connect(amp);
    amp.connect(g.dropPans[Math.floor(Math.random() * g.dropPans.length)]);
    this.voices++;
    src.onended = () => {
      src.disconnect();
      amp.disconnect();
      this.voices--;
    };
    src.start(t);
  }

  /** Distant rumble: slowed brown noise, steep low-pass, slow multi-roll envelope, long tail, optional crackle. */
  private playThunder(g: Graph, t0: number, intensity: number): void {
    if (this.voices >= MAX_VOICES) return;
    const ctx = g.ctx;
    const near = Math.random() * (0.35 + 0.65 * intensity); // 0 = far, 1 = close
    const amp = 1.1 * (0.35 + 0.65 * near) * (0.6 + 0.4 * intensity) * rand(0.75, 1);
    const cut = 130 + 280 * near;

    const src = ctx.createBufferSource();
    src.buffer = g.brown;
    src.loop = true;
    src.playbackRate.value = rand(0.55, 0.85);
    const lp1 = biquad(ctx, 'lowpass', cut * 1.8, 0);
    const lp2 = biquad(ctx, 'lowpass', cut * 2.5, -3);
    const hp = biquad(ctx, 'highpass', 38, -3);
    const env = ctx.createGain();
    env.gain.value = 0;
    const pan = ctx.createStereoPanner();
    pan.pan.value = rand(-0.6, 0.6);
    src.connect(lp1);
    lp1.connect(lp2);
    lp2.connect(hp);
    hp.connect(env);
    env.connect(pan);
    pan.connect(g.thunderBus);
    const nodes: AudioNode[] = [src, lp1, lp2, hp, env, pan];

    const eg = env.gain;
    eg.setValueAtTime(0, t0);
    let t = t0;
    const rolls = randInt(1, 3) + (near > 0.5 ? 1 : 0);
    for (let r = 0; r < rolls; r++) {
      const pk = amp * (r === 0 ? rand(0.7, 1) : rand(0.45, 1));
      eg.setTargetAtTime(pk, t, rand(0.25, 0.7) * (r === 0 ? 1.4 : 1)); // slow swell
      t += rand(0.8, 1.8);
      eg.setTargetAtTime(pk * rand(0.25, 0.45), t, rand(0.35, 0.8));
      t += rand(0.5, 1.4);
    }
    const tail = rand(1.6, 3.2);
    eg.setTargetAtTime(0, t, tail);
    const end = t + tail * 5.5;
    lp1.frequency.setValueAtTime(cut * 1.8, t0);
    lp1.frequency.setTargetAtTime(cut * 0.6, t0 + 0.6, (end - t0) * 0.35); // darkens as it rolls away

    if (near > 0.3) {
      const src2 = ctx.createBufferSource();
      src2.buffer = g.pink;
      src2.loop = true;
      const bp = biquad(ctx, 'bandpass', rand(500, 1300), 0.7);
      const cg = ctx.createGain();
      cg.gain.value = 0;
      src2.connect(bp);
      bp.connect(cg);
      cg.connect(pan);
      nodes.push(src2, bp, cg);
      const p = cg.gain;
      let tc = t0 + rand(0.15, 0.6);
      const n = 3 + Math.floor(near * 10 * Math.random());
      for (let k = 0; k < n; k++) {
        p.setTargetAtTime(amp * near * rand(0.15, 0.6), tc, 0.004);
        p.setTargetAtTime(0, tc + rand(0.01, 0.035), rand(0.05, 0.2));
        tc += rand(0.05, 0.45);
      }
      src2.start(t0, Math.random() * g.pink.duration);
      src2.stop(Math.min(end, tc + 1.5));
    }

    this.voices++;
    src.onended = () => {
      for (let i = 0; i < nodes.length; i++) nodes[i].disconnect();
      this.voices--;
    };
    src.start(t0, Math.random() * g.brown.duration);
    src.stop(end);
  }

  /** One songbird phrase on a single FM voice; returns its duration in seconds (0 if skipped). */
  private playBirdPhrase(g: Graph, t0: number, level: number): number {
    if (this.voices >= MAX_VOICES) return 0;
    const ctx = g.ctx;
    const sp = this.species[Math.floor(Math.random() * this.species.length)];
    const car = ctx.createOscillator();
    car.frequency.value = sp.base;
    const mod = ctx.createOscillator();
    const modAmt = ctx.createGain();
    modAmt.gain.value = 0;
    const env = ctx.createGain();
    env.gain.value = 0;
    const pan = ctx.createStereoPanner();
    pan.pan.value = rand(-0.75, 0.75);
    mod.connect(modAmt);
    modAmt.connect(car.frequency);
    car.connect(env);
    env.connect(pan);
    pan.connect(g.birdBus);

    const peak = 0.14 * level * rand(0.35, 1); // distance variety
    const pitch = rand(0.92, 1.08);
    const tempo = rand(0.85, 1.15);
    const reps = randInt(sp.minReps, sp.maxReps);
    let t = t0;
    let i = 0;
    for (let r = 0; r < reps; r++) {
      for (let m = 0; m < sp.motif.length; m++) {
        const d = sp.noteDur * tempo * rand(0.8, 1.2);
        this.birdNote(car, mod, modAmt, env, sp, sp.motif[m], sp.base * pitch * Math.pow(sp.drift, i), t, d, peak * rand(0.75, 1));
        t += d + sp.noteGap * tempo * rand(0.7, 1.3);
        i++;
      }
      t += sp.repGap * tempo;
    }
    if (sp.endTrill && Math.random() < 0.6) {
      const d = rand(0.3, 0.7);
      this.birdNote(car, mod, modAmt, env, sp, TRILL, sp.base * pitch, t, d, peak * 0.8);
      t += d;
    }
    const end = t + 0.05;
    car.start(t0);
    mod.start(t0);
    car.stop(end);
    mod.stop(end);
    this.voices++;
    car.onended = () => {
      car.disconnect();
      mod.disconnect();
      modAmt.disconnect();
      env.disconnect();
      pan.disconnect();
      this.voices--;
    };
    return end - t0;
  }

  private birdNote(
    car: OscillatorNode,
    mod: OscillatorNode,
    modAmt: GainNode,
    env: GainNode,
    sp: Species,
    shape: number,
    freq: number,
    t: number,
    d: number,
    a: number,
  ): void {
    const f = clampRange(freq, 1600, 4500);
    const top = f * sp.spread;
    const fr = car.frequency;
    let fmRate = rand(5, 9);
    let fmDepth = f * 0.008; // slight vibrato
    switch (shape) {
      case UP:
        fr.setValueAtTime(f * 0.78, t);
        fr.exponentialRampToValueAtTime(top, t + d);
        break;
      case DOWN:
        fr.setValueAtTime(top, t);
        fr.exponentialRampToValueAtTime(f * 0.78, t + d);
        break;
      case CHEVRON:
        fr.setValueAtTime(f * 0.85, t);
        fr.exponentialRampToValueAtTime(top, t + d * 0.4);
        fr.exponentialRampToValueAtTime(f * 0.8, t + d);
        break;
      case WHISTLE:
        fr.setValueAtTime(f, t);
        fr.exponentialRampToValueAtTime(f * 1.04, t + d);
        break;
      default: // TRILL
        fr.setValueAtTime(f * 1.05, t);
        fr.exponentialRampToValueAtTime(f * 0.95, t + d);
        fmRate = sp.fmRate;
        fmDepth = f * sp.fmDepth;
        break;
    }
    mod.frequency.setValueAtTime(fmRate, t);
    modAmt.gain.setValueAtTime(fmDepth, t);
    const eg = env.gain;
    eg.setValueAtTime(0, t);
    eg.linearRampToValueAtTime(a, t + Math.min(0.012, d * 0.25));
    eg.linearRampToValueAtTime(a * 0.7, t + d * 0.7);
    eg.linearRampToValueAtTime(0, t + d);
  }
}

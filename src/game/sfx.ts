import type { Ambience } from '../audio/ambience';

// Synthesized game sounds (WebAudio, no samples). They play through the ambience's output chain,
// so the same mute, volume and limiter apply.

interface Graze {
  src: AudioBufferSourceNode;
  bp: BiquadFilterNode;
  gain: GainNode;
  pan: StereoPannerNode;
}

export class Sfx {
  private graze: Graze | null = null;
  private lastBeep = 0;

  constructor(private readonly amb: Ambience) {}

  private get out() {
    return this.amb.enabled ? this.amb.output : null;
  }

  /** continuous hiss while grazing, panned toward the near side */
  update(graze: number, pan: number, speed: number, flying: boolean): void {
    const o = this.out;
    if (!o) return;
    const { ctx } = o;
    if (!this.graze) {
      const src = ctx.createBufferSource();
      src.buffer = o.pink;
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 0.9;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const p = ctx.createStereoPanner();
      src.connect(bp).connect(gain).connect(p).connect(o.bus);
      src.start();
      this.graze = { src, bp, gain, pan: p };
    }
    const t = ctx.currentTime;
    const g = this.graze;
    const level = flying ? Math.min(1, graze * 1.3) : 0;
    g.gain.gain.setTargetAtTime(level * 0.55, t, 0.05);
    g.bp.frequency.setTargetAtTime(900 + speed * 45 + graze * 1800, t, 0.08);
    g.pan.pan.setTargetAtTime(Math.max(-0.9, Math.min(0.9, pan)), t, 0.06);
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, when = 0, slideTo = 0): void {
    const o = this.out;
    if (!o) return;
    const { ctx } = o;
    const t = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    osc.connect(g).connect(o.bus);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private noise(dur: number, type: BiquadFilterType, f0: number, f1: number, vol: number, pan = 0, brown = false): void {
    const o = this.out;
    if (!o) return;
    const { ctx } = o;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = brown ? o.brown : o.pink;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = type === 'bandpass' ? 1.4 : 0.7;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    src.connect(f).connect(g).connect(p).connect(o.bus);
    src.start(t, Math.random() * 5);
    src.stop(t + dur + 0.05);
  }

  whoosh(pan: number): void {
    this.noise(0.45, 'bandpass', 3800, 500, 0.9, pan);
  }

  chain(mult: number): void {
    const f = 660 * Math.pow(2, (mult - 1) / 2.5);
    this.tone(f, 0.18, 'triangle', 0.22);
    this.tone(f * 1.5, 0.22, 'sine', 0.12, 0.05);
  }

  bank(pts: number): void {
    const n = pts > 5000 ? 4 : pts > 1000 ? 3 : 2;
    const notes = [784, 988, 1175, 1568];
    for (let i = 0; i < n; i++) this.tone(notes[i], 0.16, 'square', 0.06, i * 0.06);
  }

  bonus(kind: string): void {
    const base = kind === 'tube' ? 523 : kind === 'thread' ? 659 : 587;
    this.tone(base, 0.25, 'triangle', 0.2);
    this.tone(base * 1.25, 0.25, 'triangle', 0.16, 0.07);
    this.tone(base * 1.5, 0.35, 'triangle', 0.14, 0.14);
  }

  crash(water: boolean): void {
    if (water) {
      this.noise(1.1, 'highpass', 1200, 300, 1.2);
      this.noise(0.6, 'lowpass', 600, 120, 0.8, 0, true);
    } else {
      this.noise(0.9, 'lowpass', 1400, 90, 1.3, 0, true);
      this.tone(90, 0.5, 'sine', 0.6, 0, 38);
    }
  }

  beep(high: boolean): void {
    this.tone(high ? 880 : 440, high ? 0.25 : 0.12, 'square', 0.07);
  }

  /** repeating warning while lift is low; call every frame */
  lowLift(on: boolean, stalled: boolean, now: number): void {
    if (!on) return;
    const period = stalled ? 0.28 : 0.6;
    if (now - this.lastBeep > period) {
      this.lastBeep = now;
      this.tone(stalled ? 520 : 760, 0.09, 'square', 0.05);
    }
  }

  stall(): void {
    this.tone(700, 0.7, 'sawtooth', 0.08, 0, 180);
  }

  boostStart(): void {
    this.noise(0.5, 'bandpass', 400, 2600, 0.5);
  }
}

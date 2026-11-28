import { Rng } from './rng';

// Seeded improved Perlin noise (Ken Perlin 2002) with a random coordinate offset per instance,
// plus octave and "double" combinations. Output of a single octave is roughly in [-1, 1].

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(t: number, a: number, b: number): number {
  return a + t * (b - a);
}

function grad3(h: number, x: number, y: number, z: number): number {
  switch (h & 15) {
    case 0: return x + y;
    case 1: return -x + y;
    case 2: return x - y;
    case 3: return -x - y;
    case 4: return x + z;
    case 5: return -x + z;
    case 6: return x - z;
    case 7: return -x - z;
    case 8: return y + z;
    case 9: return -y + z;
    case 10: return y - z;
    case 11: return -y - z;
    case 12: return y + x;
    case 13: return -y + z;
    case 14: return y - x;
    default: return -y - z;
  }
}

function grad2(h: number, x: number, z: number): number {
  switch (h & 7) {
    case 0: return x + z;
    case 1: return -x + z;
    case 2: return x - z;
    case 3: return -x - z;
    case 4: return x;
    case 5: return -x;
    case 6: return z;
    default: return -z;
  }
}

export class Perlin {
  private readonly p = new Uint8Array(512);
  private readonly ox: number;
  private readonly oy: number;
  private readonly oz: number;

  constructor(rng: Rng) {
    this.ox = rng.next() * 256;
    this.oy = rng.next() * 256;
    this.oz = rng.next() * 256;
    const perm = new Uint8Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = rng.int(i + 1);
      const t = perm[i];
      perm[i] = perm[j];
      perm[j] = t;
    }
    for (let i = 0; i < 512; i++) this.p[i] = perm[i & 255];
  }

  noise3(x: number, y: number, z: number): number {
    x += this.ox;
    y += this.oy;
    z += this.oz;
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    const fz = Math.floor(z);
    const X = fx & 255;
    const Y = fy & 255;
    const Z = fz & 255;
    x -= fx;
    y -= fy;
    z -= fz;
    const u = fade(x);
    const v = fade(y);
    const w = fade(z);
    const p = this.p;
    const A = p[X] + Y;
    const AA = p[A] + Z;
    const AB = p[A + 1] + Z;
    const B = p[X + 1] + Y;
    const BA = p[B] + Z;
    const BB = p[B + 1] + Z;
    return lerp(
      w,
      lerp(
        v,
        lerp(u, grad3(p[AA], x, y, z), grad3(p[BA], x - 1, y, z)),
        lerp(u, grad3(p[AB], x, y - 1, z), grad3(p[BB], x - 1, y - 1, z)),
      ),
      lerp(
        v,
        lerp(u, grad3(p[AA + 1], x, y, z - 1), grad3(p[BA + 1], x - 1, y, z - 1)),
        lerp(u, grad3(p[AB + 1], x, y - 1, z - 1), grad3(p[BB + 1], x - 1, y - 1, z - 1)),
      ),
    );
  }

  noise2(x: number, z: number): number {
    x += this.ox;
    z += this.oz;
    const fx = Math.floor(x);
    const fz = Math.floor(z);
    const X = fx & 255;
    const Z = fz & 255;
    x -= fx;
    z -= fz;
    const u = fade(x);
    const w = fade(z);
    const p = this.p;
    const A = p[X] + Z;
    const B = p[X + 1] + Z;
    return lerp(
      w,
      lerp(u, grad2(p[A], x, z), grad2(p[B], x - 1, z)),
      lerp(u, grad2(p[A + 1], x, z - 1), grad2(p[B + 1], x - 1, z - 1)),
    );
  }
}

/**
 * Sum of octaves. Octave i has frequency baseFreq * 2^i and amplitude amps[i] * 0.5^i,
 * normalised so the total amplitude is 1.
 */
export class Octaves {
  private readonly layers: Perlin[] = [];
  private readonly freqs: number[] = [];
  private readonly amps: number[] = [];

  constructor(rng: Rng, baseFreq: number, amps: number[]) {
    let total = 0;
    for (let i = 0; i < amps.length; i++) total += amps[i] / (1 << i); // exact powers of two
    for (let i = 0; i < amps.length; i++) {
      const perlin = new Perlin(rng);
      if (amps[i] === 0) continue;
      this.layers.push(perlin);
      this.freqs.push(baseFreq * (1 << i));
      this.amps.push(amps[i] / (1 << i) / total);
    }
  }

  sample3(x: number, y: number, z: number): number {
    let v = 0;
    const L = this.layers;
    for (let i = 0; i < L.length; i++) {
      const f = this.freqs[i];
      v += L[i].noise3(x * f, y * f, z * f) * this.amps[i];
    }
    return v;
  }

  /** anisotropic: separate vertical frequency scale */
  sample3v(x: number, y: number, z: number, yScale: number): number {
    let v = 0;
    const L = this.layers;
    for (let i = 0; i < L.length; i++) {
      const f = this.freqs[i];
      v += L[i].noise3(x * f, y * f * yScale, z * f) * this.amps[i];
    }
    return v;
  }

  sample2(x: number, z: number): number {
    let v = 0;
    const L = this.layers;
    for (let i = 0; i < L.length; i++) {
      const f = this.freqs[i];
      v += L[i].noise2(x * f, z * f) * this.amps[i];
    }
    return v;
  }
}

/** Two independent octave sets summed at slightly different scales: smoother distribution, fewer grid artefacts. */
export class DoubleNoise {
  private readonly a: Octaves;
  private readonly b: Octaves;
  constructor(rng: Rng, baseFreq: number, amps: number[]) {
    this.a = new Octaves(rng, baseFreq, amps);
    this.b = new Octaves(rng, baseFreq, amps);
  }
  sample2(x: number, z: number): number {
    return (this.a.sample2(x, z) + this.b.sample2(x * 1.0137 + 31.7, z * 1.0137 - 17.3)) * 0.5;
  }
}

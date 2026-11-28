// Deterministic math: the same bits on every JavaScript engine.
//
// Math.sin, Math.exp and friends are not required to be correctly rounded, and browsers use different
// libm implementations, so their last bits can differ between Chrome, Safari and Firefox. Anything
// that must replay identically everywhere (the game simulation, scores verified on a server) uses
// these instead. They are built only from + - * / and Math.round/floor/abs, which IEEE 754 pins down.

const PIO2_HI = 1.5707963267948966;
const PIO2_LO = 6.123233995736766e-17;
const TWO_OVER_PI = 0.6366197723675814;

/** sin on [-pi/4, pi/4] */
function kSin(r: number): number {
  const z = r * r;
  return r + r * z * (-1 / 6 + z * (1 / 120 + z * (-1 / 5040 + z * (1 / 362880 + z * (-1 / 39916800 + z * (1 / 6227020800))))));
}

/** cos on [-pi/4, pi/4] */
function kCos(r: number): number {
  const z = r * r;
  return 1 + z * (-1 / 2 + z * (1 / 24 + z * (-1 / 720 + z * (1 / 40320 + z * (-1 / 3628800 + z * (1 / 479001600 + z * (-1 / 87178291200)))))));
}

/** quadrant (0..3) and remainder in [-pi/4, pi/4] (accurate for |x| up to ~1e6) */
function reduce(x: number, out: { r: number }): number {
  const k = Math.round(x * TWO_OVER_PI);
  out.r = x - k * PIO2_HI - k * PIO2_LO;
  return ((k % 4) + 4) % 4;
}

const tmp = { r: 0 };

export function dsin(x: number): number {
  const q = reduce(x, tmp);
  const r = tmp.r;
  switch (q) {
    case 0:
      return kSin(r);
    case 1:
      return kCos(r);
    case 2:
      return -kSin(r);
    default:
      return -kCos(r);
  }
}

export function dcos(x: number): number {
  const q = reduce(x, tmp);
  const r = tmp.r;
  switch (q) {
    case 0:
      return kCos(r);
    case 1:
      return -kSin(r);
    case 2:
      return -kCos(r);
    default:
      return kSin(r);
  }
}

/** atan on [-1, 1] by argument halving plus an odd series */
function kAtan(x: number): number {
  // atan(x) = 2 atan(x / (1 + sqrt(1 + x^2))): two halvings bring |x| <= ~0.2
  let s = 1;
  for (let i = 0; i < 2; i++) {
    x = x / (1 + Math.sqrt(1 + x * x));
    s *= 2;
  }
  const z = x * x;
  let p = 0;
  for (let n = 23; n >= 1; n -= 2) p = (n % 4 === 1 ? 1 : -1) / n + z * p;
  return s * x * p;
}

export function datan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  let a = ay <= ax ? kAtan(ay / ax) : PIO2_HI - kAtan(ax / ay);
  if (x < 0) a = 2 * PIO2_HI - a;
  return y < 0 ? -a : a;
}

const LN2_HI = 0.6931471803691238;
const LN2_LO = 1.9082149292705877e-10;
const INV_LN2 = 1.4426950408889634;

/** 2^k for an integer k, exactly (by repeated multiplication) */
function pow2i(k: number): number {
  let r = 1;
  if (k >= 0) {
    while (k >= 30) {
      r *= 1073741824;
      k -= 30;
    }
    return r * (1 << k);
  }
  k = -k;
  while (k >= 30) {
    r /= 1073741824;
    k -= 30;
  }
  return r / (1 << k);
}

export function dexp(x: number): number {
  if (x !== x) return NaN;
  if (x > 709.7) return Infinity;
  if (x < -745) return 0;
  const k = Math.round(x * INV_LN2);
  const r = x - k * LN2_HI - k * LN2_LO; // |r| <= ln2/2
  // Taylor series of e^r to degree 14 (error < 1e-17 on this range)
  let p = 1 / 87178291200;
  for (let n = 13; n >= 1; n--) p = p * r + FACT_INV[n];
  p = p * r + 1;
  return p * pow2i(k);
}
const FACT_INV: number[] = [];
{
  let f = 1;
  FACT_INV.push(1);
  for (let n = 1; n <= 14; n++) {
    f *= n;
    FACT_INV.push(1 / f);
  }
}

/** natural log for x > 0 */
export function dlog(x: number): number {
  if (!(x > 0)) return x === 0 ? -Infinity : NaN;
  if (x === Infinity) return Infinity;
  // x = m * 2^k with m in [sqrt(1/2), sqrt(2))
  let k = 0;
  let m = x;
  while (m >= 1.4142135623730951) {
    m *= 0.5;
    k++;
  }
  while (m < 0.7071067811865476) {
    m *= 2;
    k--;
  }
  // log(m) = 2 atanh(s), s = (m - 1) / (m + 1), |s| < 0.172
  const s = (m - 1) / (m + 1);
  const z = s * s;
  let p = 0;
  for (let n = 27; n >= 1; n -= 2) p = 1 / n + z * p;
  return 2 * s * p + k * LN2_HI + k * LN2_LO;
}

/** x^y for x > 0 (and x = 0 with y > 0) */
export function dpow(x: number, y: number): number {
  if (x === 0) return y > 0 ? 0 : y === 0 ? 1 : Infinity;
  if (y === 0) return 1;
  return dexp(y * dlog(x));
}

export function dhypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

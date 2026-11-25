// A mesh job works on a 3x3 chunk neighbourhood ("region"): 48 x H x 48, centre chunk at [16,32).
export const RW = 48;
export const RA = RW * RW;
export const RC = 16; // centre offset

export function ridx(x: number, y: number, z: number): number {
  return (y * RW + z) * RW + x;
}

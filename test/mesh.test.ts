import { describe, expect, it } from 'vitest';
import { B } from '../src/gen/blocks';
import { computeLight } from '../src/mesh/light';
import { buildMesh } from '../src/mesh/mesher';
import { RA, RW } from '../src/mesh/region';

function mesh(place: (r: Uint8Array) => void, H = 32) {
  const blocks = new Uint8Array(RA * H);
  place(blocks);
  const light = new Uint8Array(RA * 320);
  computeLight(blocks, H, light);
  const tints = new Uint8Array(256 * 9).fill(200);
  return { m: buildMesh({ blocks, light, H, tints, seed: 1, wx0: 0, wz0: 0 }), light };
}
const at = (x: number, y: number, z: number) => (y * RW + z + 16) * RW + x + 16;

describe('mesher', () => {
  it('emits 6 faces for a lone block and 10 for two touching blocks', () => {
    expect(mesh((r) => (r[at(8, 10, 8)] = B.STONE)).m.opaque.length / 12).toBe(6);
    expect(
      mesh((r) => {
        r[at(8, 10, 8)] = B.STONE;
        r[at(9, 10, 8)] = B.STONE;
      }).m.opaque.length / 12,
    ).toBe(10);
  });

  it('gives open air full sky light and darkens sealed cavities', () => {
    const { light } = mesh((r) => {
      // a sealed 1-block cavity: a 3x3x3 stone cube with an air centre
      for (let y = 9; y <= 11; y++) for (let z = 7; z <= 9; z++) for (let x = 7; x <= 9; x++) r[at(x, y, z)] = B.STONE;
      r[at(8, 10, 8)] = B.AIR;
    });
    expect(light[at(3, 20, 3)] >> 4).toBe(15);
    expect(light[at(8, 10, 8)]).toBe(0);
  });

  it('does not emit faces into pitch-dark cave air', () => {
    const { m } = mesh((r) => {
      for (let y = 9; y <= 11; y++) for (let z = 7; z <= 9; z++) for (let x = 7; x <= 9; x++) r[at(x, y, z)] = B.STONE;
      r[at(8, 10, 8)] = B.AIR;
    });
    // only the outer shell of the 3x3x3 cube: 6 sides * 9 faces
    expect(m.opaque.length / 12).toBe(54);
  });
});

import { createContext, generateChunk } from '../src/gen/generateChunk';
import { computeLight } from '../src/mesh/light';
import { buildMesh } from '../src/mesh/mesher';
import { RA, RW } from '../src/mesh/region';
const ctx = createContext(12345);
let tot = { o: 0, c: 0, t: 0, l: 0 };
const light = new Uint8Array(RA * 320); const tints = new Uint8Array(256 * 9).fill(200);
for (const [cx, cz] of [[0, 140], [3, 141], [-2, 150], [10, 135], [-60, 80], [40, -30], [100, 100], [-150, 20]]) {
  const cs = [] as Uint8Array[]; let maxY = 0;
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { const c = generateChunk(ctx, cx + dx, cz + dz); cs.push(c.blocks); for (const h of c.heights) maxY = Math.max(maxY, h); }
  const H = Math.min(320, maxY + 3); const r = new Uint8Array(RA * H);
  let k = 0;
  for (let dz = 0; dz < 3; dz++) for (let dx = 0; dx < 3; dx++) { const b = cs[k++];
    for (let y = 0; y < H; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) r[(y * RW + dz * 16 + z) * RW + dx * 16 + x] = b[(y << 8) | (z << 4) | x]; }
  computeLight(r, H, light);
  const m = buildMesh({ blocks: r, light, H, tints, seed: 1, wx0: 0, wz0: 0 });
  tot.o += m.opaque.length / 12; tot.c += m.cutout.length / 12; tot.t += m.translucent.length / 12; tot.l += m.leaves.length / 12;
}
console.log('quads/chunk', Object.fromEntries(Object.entries(tot).map(([k, v]) => [k, Math.round(v / 8)])));

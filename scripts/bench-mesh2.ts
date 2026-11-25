import { createContext, generateChunk } from '../src/gen/generateChunk';
import { computeLight } from '../src/mesh/light';
import { buildMesh } from '../src/mesh/mesher';
import { RA, RW } from '../src/mesh/region';
const ctx = createContext(777);
const cs = [] as Uint8Array[]; let maxY = 0;
for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { const c = generateChunk(ctx, -200+dx, 300+dz); cs.push(c.blocks); for (const h of c.heights) maxY = Math.max(maxY, h); }
const H = Math.min(320, maxY + 3); const r = new Uint8Array(RA * H);
let k = 0;
for (let dz = 0; dz < 3; dz++) for (let dx = 0; dx < 3; dx++) { const b = cs[k++];
  for (let y = 0; y < H; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) r[(y*RW + dz*16+z)*RW + dx*16+x] = b[(y<<8)|(z<<4)|x]; }
const light = new Uint8Array(RA * 320); const tints = new Uint8Array(256*9).fill(200);
for (let i = 0; i < 30; i++) {
  let t0 = performance.now(); computeLight(r, H, light); const tl = performance.now() - t0;
  t0 = performance.now(); buildMesh({ blocks: r, light, H, tints, seed: 1, wx0: 0, wz0: 0 }); const tm = performance.now() - t0;
  if (i % 5 === 0 || i === 29) console.log(i, tl.toFixed(1), tm.toFixed(1));
}

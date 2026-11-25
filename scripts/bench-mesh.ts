import { createContext, generateChunk } from '../src/gen/generateChunk';
import { computeLight } from '../src/mesh/light';
import { buildMesh } from '../src/mesh/mesher';
import { RA, RW } from '../src/mesh/region';
const seed = Number(process.argv[2] ?? 12345);
const ctx = createContext(seed);
const CX = Number(process.argv[3] ?? 40), CZ = Number(process.argv[4] ?? 10);
function region(cx: number, cz: number) {
  const cs = [] as Uint8Array[]; let maxY = 0;
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { const c = generateChunk(ctx, cx+dx, cz+dz); cs.push(c.blocks); for (const h of c.heights) maxY = Math.max(maxY, h); }
  const H = Math.min(320, maxY + 3); const r = new Uint8Array(RA * H);
  let k = 0;
  for (let dz = 0; dz < 3; dz++) for (let dx = 0; dx < 3; dx++) { const b = cs[k++];
    for (let y = 0; y < H; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) r[(y*RW + dz*16+z)*RW + dx*16+x] = b[(y<<8)|(z<<4)|x]; }
  return { r, H };
}
const light = new Uint8Array(RA * 320); const tints = new Uint8Array(256*9).fill(200);
let tl = 0, tm = 0, q = 0;
for (let i = 0; i < 12; i++) {
  const { r, H } = region(CX + i * 3, CZ);
  let t0 = performance.now(); computeLight(r, H, light); tl += performance.now() - t0;
  t0 = performance.now(); const m = buildMesh({ blocks: r, light, H, tints, seed, wx0: 0, wz0: 0 }); tm += performance.now() - t0;
  q += (m.opaque.length + m.cutout.length + m.translucent.length) / 12;
  if (i === 0) console.log('H', H);
}
console.log(`light ${(tl/12).toFixed(1)}ms mesh ${(tm/12).toFixed(1)}ms quads ${(q/12).toFixed(0)}`);

import { createContext, generateChunk } from '../src/gen/generateChunk';
import { NAMES } from '../src/gen/blocks';
import { BIOMES } from '../src/gen/climate';
function h(a: Uint8Array) { let x = 2166136261; for (let i = 0; i < a.length; i++) { x ^= a[i]; x = Math.imul(x, 16777619); } return (x>>>0).toString(16); }
const seed = Number(process.argv[2] ?? 12345);
const ctx = createContext(seed);
const counts = new Map<number, number>(); const biomeCount = new Map<number, number>();
let t0 = performance.now(); let n = 0;
for (let cz = -6; cz < 6; cz++) for (let cx = -6; cx < 6; cx++) {
  const c = generateChunk(ctx, cx, cz); n++;
  for (const b of c.blocks) counts.set(b, (counts.get(b) ?? 0) + 1);
  for (const b of c.biomes) biomeCount.set(b, (biomeCount.get(b) ?? 0) + 1);
}
const dt = performance.now() - t0;
console.log(`chunks ${n}, ms/chunk ${(dt/n).toFixed(2)}`);
// warm second pass timing (cache warm)
t0 = performance.now(); for (let i = 0; i < 20; i++) generateChunk(ctx, 100 + i, 50); console.log('fresh area ms/chunk', ((performance.now()-t0)/20).toFixed(2));
console.log([...counts].sort((a,b)=>b[1]-a[1]).slice(0, 30).map(([k,v])=>`${NAMES[k]}:${v}`).join(' '));
console.log([...biomeCount].sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${BIOMES[k].name}:${v}`).join(', '));
// determinism
const a = generateChunk(createContext(seed), 3, -2).blocks; const b = generateChunk(ctx, 3, -2).blocks;
console.log('deterministic', h(a) === h(b));

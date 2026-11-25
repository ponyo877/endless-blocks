import { createContext, generateChunk } from '../src/gen/generateChunk';
import { B } from '../src/gen/blocks';
const [seed, X, Z] = process.argv.slice(2).map(Number);
const ctx = createContext(seed);
const name = Object.fromEntries(Object.entries(B).map(([k, v]) => [v, k]));
const get = (x: number, z: number) => { const cx = Math.floor(x / 16), cz = Math.floor(z / 16); const c = generateChunk(ctx, cx, cz); const i = (z - cz * 16) * 16 + (x - cx * 16); return { h: c.heights[i], id: c.topIds[i], blocks: c.blocks, lx: x - cx * 16, lz: z - cz * 16 }; };
let out = '';
for (let z = Z - 6; z <= Z + 6; z++) { let row = ''; for (let x = X - 6; x <= X + 6; x++) { const g = get(x, z); row += String(g.h).padStart(4); } out += row + '\n'; }
console.log(out);
const c = get(X, Z);
const col: string[] = [];
for (let y = c.h; y >= c.h - 25 && y >= 0; y--) col.push(`${y}:${name[c.blocks[(y << 8) | (c.lz << 4) | c.lx]]}`);
const w = get(X + 3, Z);
const col2: string[] = [];
for (let y = w.h; y >= w.h - 25 && y >= 0; y--) col2.push(`${y}:${name[w.blocks[(y << 8) | (w.lz << 4) | w.lx]]}`);
console.log('centre', col.join(' '));
console.log('wall  ', col2.join(' '));

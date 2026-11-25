import { Terrain } from '../src/gen/terrain';
import { BIOMES } from '../src/gen/climate';
const t = new Terrain(Number(process.argv[2] ?? 7));
const counts = new Map<number, number>(); let N = 0; const H: number[] = [];
for (let i = 0; i < 60000; i++) {
  const ix = Math.floor((Math.random() - 0.5) * 100000), iz = Math.floor((Math.random() - 0.5) * 100000);
  const c = t.corner(ix, iz); counts.set(c.biome, (counts.get(c.biome) ?? 0) + 1); N++; H.push(c.top);
}
console.log([...counts].sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${BIOMES[k].name} ${(100*v/N).toFixed(1)}%`).join('\n'));
H.sort((a,b)=>a-b); console.log('top percentiles', [0.05,0.25,0.5,0.75,0.9,0.97,0.995].map(p=>H[Math.floor(p*H.length)]).join(' '));

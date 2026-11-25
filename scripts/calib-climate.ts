import { Climate } from '../src/gen/climate';
const names = ['t','h','c','e','w'];
const acc = names.map(() => ({ s: 0, s2: 0, n: 0 }));
const out: number[] = [0,0,0,0,0];
for (const seed of [1, 42, 1234, 99999]) {
  const cl = new Climate(seed);
  for (let i = 0; i < 40000; i++) {
    const x = (Math.random() - 0.5) * 400000, z = (Math.random() - 0.5) * 400000;
    cl.raw(x, z, out);
    for (let k = 0; k < 5; k++) { acc[k].s += out[k]; acc[k].s2 += out[k]*out[k]; acc[k].n++; }
  }
}
for (let k = 0; k < 5; k++) { const a = acc[k]; const m = a.s/a.n; console.log(names[k], 'mean', m.toFixed(4), 'sigma', Math.sqrt(a.s2/a.n - m*m).toFixed(4)); }
const t0 = performance.now(); const cl = new Climate(5); let s = 0; const o = {t:0,h:0,c:0,e:0,w:0,pv:0};
for (let i = 0; i < 100000; i++) { cl.sample(i*3.1, i*1.7, o); s += o.t; }
console.log('climate sample us', ((performance.now()-t0)/100000*1000).toFixed(2));

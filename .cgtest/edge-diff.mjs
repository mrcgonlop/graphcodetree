// Scratch: find edge-level differences involving a given file path fragment.
// Usage: node edge-diff.mjs <before.json> <after.json> <file-fragment>
import { readFileSync } from 'node:fs';

const sort = (v) => {
  if (Array.isArray(v)) return v.map(sort);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
  }
  return v;
};
const canon = (x) => JSON.stringify(sort(x));
const load = (p) => JSON.parse(readFileSync(p, 'utf8'));
const A = load(process.argv[2]);
const B = load(process.argv[3]);
const frag = process.argv[4];
const mentions = (e) => JSON.stringify(e).includes(frag);
const Aset = new Set(A.edges.map(canon));
const Bset = new Set(B.edges.map(canon));

const onlyA = A.edges.filter((e) => mentions(e) && !Bset.has(canon(e)));
const onlyB = B.edges.filter((e) => mentions(e) && !Aset.has(canon(e)));
console.log(`edges mentioning ${frag}: before ${A.edges.filter(mentions).length}, after ${B.edges.filter(mentions).length}`);
console.log(`  only before: ${onlyA.length}`);
for (const e of onlyA) console.log('   -', JSON.stringify(e));
console.log(`  only after: ${onlyB.length}`);
for (const e of onlyB) console.log('   +', JSON.stringify(e));

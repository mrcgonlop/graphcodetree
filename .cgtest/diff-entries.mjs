// Scratch: set-diff two snapshots' nodes and edges (order-insensitive).
// Usage: node diff-entries.mjs <a.json> <b.json> [limit]
import { readFileSync } from 'node:fs';
const [pa, pb, lim = '5'] = process.argv.slice(2);
const A = JSON.parse(readFileSync(pa, 'utf8'));
const B = JSON.parse(readFileSync(pb, 'utf8'));
const N = Number(lim);

function diff(label, x, y) {
  const kx = new Map();
  for (const o of x) kx.set(JSON.stringify(o), (kx.get(JSON.stringify(o)) ?? 0) + 1);
  const ky = new Map();
  for (const o of y) ky.set(JSON.stringify(o), (ky.get(JSON.stringify(o)) ?? 0) + 1);
  const onlyA = [];
  const onlyB = [];
  for (const [k, n] of kx) if ((ky.get(k) ?? 0) < n) onlyA.push([k, n - (ky.get(k) ?? 0)]);
  for (const [k, n] of ky) if ((kx.get(k) ?? 0) < n) onlyB.push([k, n - (kx.get(k) ?? 0)]);
  console.log(`\n== ${label}: only-in-A=${onlyA.length} only-in-B=${onlyB.length} (A=${x.length} B=${y.length})`);
  onlyA.slice(0, N).forEach(([k, n]) => console.log(`  - x${n} ${k}`));
  onlyB.slice(0, N).forEach(([k, n]) => console.log(`  + x${n} ${k}`));
}

diff('nodes', A.nodes ?? [], B.nodes ?? []);
diff('edges', A.edges ?? [], B.edges ?? []);

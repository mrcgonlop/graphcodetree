// Scratch: bucket the entries that exist in one snapshot but not the other by
// the file they belong to (nodes: key.file; edges: source file).
// Usage: node bucket-entries.mjs <a.json> <b.json>
import { readFileSync } from 'node:fs';
const [pa, pb] = process.argv.slice(2);
const A = JSON.parse(readFileSync(pa, 'utf8'));
const B = JSON.parse(readFileSync(pb, 'utf8'));

const fileOf = (o) => o?.source?.file ?? o?.source?.ancestor?.file ?? o?.key?.file ?? '?';

function bucket(label, x, y) {
  const key = (o) => JSON.stringify(o);
  const kx = new Map();
  for (const o of x) kx.set(key(o), (kx.get(key(o)) ?? 0) + 1);
  const ky = new Map();
  for (const o of y) ky.set(key(o), (ky.get(key(o)) ?? 0) + 1);
  const onlyA = new Map();
  const onlyB = new Map();
  for (const [k, n] of kx) {
    const d = n - (ky.get(k) ?? 0);
    if (d > 0) onlyA.set(k, d);
  }
  for (const [k, n] of ky) {
    const d = n - (kx.get(k) ?? 0);
    if (d > 0) onlyB.set(k, d);
  }
  const tally = (m) => {
    const byFile = new Map();
    for (const [k, n] of m) {
      const f = fileOf(JSON.parse(k));
      byFile.set(f, (byFile.get(f) ?? 0) + n);
    }
    return [...byFile.entries()].sort((a, b) => b[1] - a[1]);
  };
  const a = tally(onlyA);
  const b = tally(onlyB);
  console.log(`\n== ${label}: only-in-A=${[...onlyA.values()].reduce((s, n) => s + n, 0)} only-in-B=${[...onlyB.values()].reduce((s, n) => s + n, 0)}`);
  console.log('  -- only in A (lost) --');
  if (!a.length) console.log('     (none)');
  a.forEach(([f, n]) => console.log(`     ${String(n).padStart(4)}  ${f}`));
  console.log('  -- only in B (gained) --');
  if (!b.length) console.log('     (none)');
  b.forEach(([f, n]) => console.log(`     ${String(n).padStart(4)}  ${f}`));
}

bucket('nodes', A.nodes ?? [], B.nodes ?? []);
bucket('edges', A.edges ?? [], B.edges ?? []);

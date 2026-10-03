// Scratch: tally data_flow edges of a snapshot by source file.
// Usage: node df-tally.mjs <snapshot.json>
import { readFileSync } from 'node:fs';
const g = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const short = (p) => String(p ?? '?').replace(/^\.\\/, '').replace(/^\.[^\\]*\\/, '');
const m = new Map();
for (const e of g.edges) {
  if (e.kind !== 'data_flow') continue;
  const f = short(e.source.file ?? e.source.ancestor?.file ?? '?');
  m.set(f, (m.get(f) ?? 0) + 1);
}
const df = [...m.entries()].sort((a, b) => b[1] - a[1]);
console.log(`${process.argv[2]}: ${df.reduce((a, [, n]) => a + n, 0)} data_flow edges in ${df.length} files`);
for (const [f, n] of df) console.log(`  ${String(n).padStart(3)}  ${f}`);

// Scratch: dump per-file snapshot stats and edge/node kinds, to explain
// golden-vs-worktree differences. Usage: node golden-stats.mjs <a.json> [...]
import { readFileSync } from 'node:fs';

const tally = (arr, pick) => {
  const m = new Map();
  for (const x of arr) {
    const k = pick(x);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
};

const show = (label, m) => {
  console.log(`  ${label}: ${m.map(([k, v]) => `${k}=${v}`).join(' ')}`);
};

for (const path of process.argv.slice(2)) {
  const g = JSON.parse(readFileSync(path, 'utf8'));
  console.log(`\n== ${path}`);
  console.log(`  file_count=${g.file_count} nodes=${g.nodes.length} edges=${g.edges.length}`);
  console.log(`  stats=${JSON.stringify(g.stats)}`);
  const ek = new Map();
  for (const e of g.edges) {
    const k = e.kind ?? e.data?.kind ?? Object.keys(e).join(',');
    ek.set(k, (ek.get(k) ?? 0) + 1);
  }
  show('edge keys', tally(g.edges, (e) => Object.keys(e).join('+')));
  show('edge kind', tally(g.edges, (e) => e.kind ?? e.data?.kind ?? '?'));
  show('node kind', tally(g.nodes, (n) => n.kind ?? '?'));
  show('node lang', tally(g.nodes, (n) => n.key?.lang ?? '?'));
  show('file lang', tally(g.files ?? [], (f) => f.key?.lang ?? '?'));
}

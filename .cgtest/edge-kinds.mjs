// Scratch: bucket the edges that exist in one snapshot but not the other by
// kind, and (for the losses) by kind × source file. Set difference on the exact
// JSON, same as bucket-entries.mjs, but keyed by `kind` so a "the extractor lost
// N edges" claim can be read as "of which M were data_flow".
// Usage: node edge-kinds.mjs <before.json> <after.json>
import { readFileSync } from 'node:fs';

const A = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const B = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const fileOf = (e) => e?.source?.file ?? e?.source?.ancestor?.file ?? '?';

function survey(label, x, y) {
  const counts = (arr) => {
    const m = new Map();
    for (const e of arr) m.set(JSON.stringify(e), (m.get(JSON.stringify(e)) ?? 0) + 1);
    return m;
  };
  const kx = counts(x);
  const ky = counts(y);
  const only = [];
  for (const [k, n] of kx) {
    const d = n - (ky.get(k) ?? 0);
    if (d > 0) for (let i = 0; i < d; i++) only.push(JSON.parse(k));
  }
  const byKind = new Map();
  for (const e of only) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
  console.log(`\n== ${label}: ${only.length} edges`);
  for (const [k, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(5)}  ${k}`);
  }
  for (const kind of byKind.keys()) {
    const perFile = new Map();
    for (const e of only.filter((e) => e.kind === kind)) {
      const f = fileOf(e);
      perFile.set(f, (perFile.get(f) ?? 0) + 1);
    }
    const rows = [...perFile.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`   -- ${kind}`);
    for (const [f, n] of rows.slice(0, 6)) console.log(`      ${String(n).padStart(4)}  ${f}`);
    if (rows.length > 6) console.log(`      … ${rows.length - 6} more file(s)`);
  }
}

survey(`only in A (${process.argv[2]})`, A.edges, B.edges);
survey(`only in B (${process.argv[3]})`, B.edges, A.edges);

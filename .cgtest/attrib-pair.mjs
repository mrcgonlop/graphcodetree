// Scratch: pair up removed/added nodes to separate "span-only" churn (same
// identity, different byte offsets) from real removals/additions.
// Usage: node attrib-pair.mjs <before.json> <after.json>
import { readFileSync } from 'node:fs';

const idOf = (n) =>
  [n.key.lang, n.key.file, n.key.qualified_name, n.key.kind, n.key.disambiguator].join('|');

const load = (p) => {
  const g = JSON.parse(readFileSync(p, 'utf8'));
  return {
    nodes: g.nodes,
    edges: g.edges,
    byId: new Map(g.nodes.map((n) => [idOf(n), n])),
    set: new Set(g.nodes.map((n) => JSON.stringify(n))),
  };
};

const [beforePath, afterPath] = process.argv.slice(2);
const A = load(beforePath);
const B = load(afterPath);

const perFile = new Map();
const bump = (f, k, n = 1) => {
  const e = perFile.get(f) ?? { before: 0, after: 0, spanOnly: 0, removed: 0, added: 0 };
  e[k] += n;
  perFile.set(f, e);
};
for (const n of A.nodes) bump(n.key.file, 'before');
for (const n of B.nodes) bump(n.key.file, 'after');

// removed nodes: span-only if the same identity (lang/file/name/kind/disambiguator) survives in B
const removedSpanOnly = [];
const removedReal = [];
for (const n of A.nodes) {
  if (B.set.has(JSON.stringify(n))) continue;
  if (B.byId.has(idOf(n))) {
    removedSpanOnly.push(n);
    bump(n.key.file, 'spanOnly');
  } else {
    removedReal.push(n);
    bump(n.key.file, 'removed');
  }
}
const Aids = new Set(A.nodes.map(idOf));
const addedReal = [];
for (const n of B.nodes) {
  if (A.set.has(JSON.stringify(n))) continue;
  if (Aids.has(idOf(n))) continue;
  addedReal.push(n);
  bump(n.key.file, 'added');
}

console.log(`before ${beforePath}: ${A.nodes.length} nodes / ${A.edges.length} edges`);
console.log(`after  ${afterPath}: ${B.nodes.length} nodes / ${B.edges.length} edges`);
console.log(`\nspan-only churn   : ${removedSpanOnly.length} nodes (same identity, new byte offsets)`);
console.log(`really removed    : ${removedReal.length} nodes`);
console.log(`really added      : ${addedReal.length} nodes`);
console.log('\nper file: before after  spanOnly removed added');
for (const [f, e] of [...perFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const interesting = e.spanOnly || e.removed || e.added || e.before !== e.after;
  if (!interesting) continue;
  console.log(
    `  ${f}\n     ${String(e.before).padStart(4)} ${String(e.after).padStart(4)}  ${String(
      e.spanOnly,
    ).padStart(6)} ${String(e.removed).padStart(5)} ${String(e.added).padStart(5)}`,
  );
}
if (removedReal.length) {
  console.log('\nreal removals:');
  for (const n of removedReal.slice(0, 40)) console.log(`  - ${idOf(n)}`);
}

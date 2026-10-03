// Scratch: attribute snapshot differences to files, to prove a refactor is
// output-neutral. Usage: node attrib.mjs <before.json> <after.json>
import { readFileSync } from 'node:fs';

const canon = (x) => {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    }
    return v;
  };
  return JSON.stringify(sort(x));
};

const fileOf = (key) => {
  if (!key) return '<no-key>';
  if (key.file) return key.file;
  if (key.ancestor) return fileOf(key.ancestor.key);
  return '<other>';
};

const load = (p) => {
  const g = JSON.parse(readFileSync(p, 'utf8'));
  return {
    file_count: g.file_count,
    nodes: new Map(g.nodes.map((n) => [canon(n), n])),
    edges: new Map(g.edges.map((e) => [canon(e), e])),
  };
};

const [beforePath, afterPath] = process.argv.slice(2);
const A = load(beforePath);
const B = load(afterPath);
console.log(`before: ${beforePath}  files=${A.file_count} nodes=${A.nodes.size} edges=${A.edges.size}`);
console.log(`after : ${afterPath}  files=${B.file_count} nodes=${B.nodes.size} edges=${B.edges.size}`);

const bucket = (map, other, label) => {
  const only = new Map();
  for (const [k, v] of map) {
    if (!other.has(k)) {
      const f = fileOf(v.key ?? v.source);
      only.set(f, (only.get(f) ?? 0) + 1);
    }
  }
  const total = [...only.values()].reduce((a, b) => a + b, 0);
  console.log(`\n${label}: ${total} entries not present in the other side`);
  for (const [f, n] of [...only.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(5)}  ${f}`);
  }
  return total;
};

const added = bucket(B.nodes, A.nodes, 'ADDED nodes') + bucket(B.edges, A.edges, 'ADDED edges');
const removed = bucket(A.nodes, B.nodes, 'REMOVED nodes') + bucket(A.edges, B.edges, 'REMOVED edges');
console.log(`\nTOTAL added=${added} removed=${removed}`);

// Scratch: list the *really added* node identities between two snapshots (same
// identity test as attrib-pair.mjs), so an "N added nodes" number can be read
// back as actual names.
// Usage: node added-names.mjs <before.json> <after.json>
import { readFileSync } from 'node:fs';

const idOf = (n) =>
  [n.key.lang, n.key.file, n.key.qualified_name, n.key.kind, n.key.disambiguator].join('|');

const A = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const B = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const Aids = new Set(A.nodes.map(idOf));
const added = B.nodes.filter((n) => !Aids.has(idOf(n)));

for (const n of [...added].sort((a, b) => idOf(a).localeCompare(idOf(b)))) {
  console.log(`${String(n.key.kind).padEnd(10)} ${n.key.file}  ${n.key.qualified_name}`);
}
console.log('total added:', added.length);

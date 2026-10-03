// Scratch: print every edge of one kind (optionally only those whose from/to/locus
// mentions a substring), so a set-difference can be read as actual edges.
// Usage: node dump-edges.mjs <snapshot.json> <kind> [substring]
import { readFileSync } from 'node:fs';

const [path, kind, needle] = process.argv.slice(2);
const s = JSON.parse(readFileSync(path, 'utf8'));
const id = (k) => `${k.lang}:${k.file}#${k.qualified_name}@${k.disambiguator}`;

const rows = s.edges.filter((e) => e.kind === kind).filter((e) => {
  if (!needle) return true;
  const hay = [id(e.source ?? {}), id(e.target ?? {}), e.source?.file, e.target?.file]
    .filter(Boolean)
    .join(' ');
  return hay.includes(needle);
});

console.log(`${path}: ${rows.length} ${kind} edge(s)${needle ? ` matching ${needle}` : ''}`);
for (const e of rows) {
  const locus = e.locus ? ` @${e.locus.file}:${e.locus.start_line ?? e.locus.line ?? ''}` : '';
  const extra = e.extra && Object.keys(e.extra).length ? ' ' + JSON.stringify(e.extra) : '';
  console.log(`  ${id(e.source)}  ->  ${id(e.target)}${locus}${extra}`);
}

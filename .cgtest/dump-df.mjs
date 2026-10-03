// Scratch: list data_flow edges of a snapshot as "file::name -> file::name".
// Usage: node dump-df.mjs <snapshot.json>
import { readFileSync } from 'node:fs';
const g = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const short = (p) => String(p ?? '?').replace(/^\.\\/, '').split('\\').slice(-2).join('/');
const name = (k) => {
  if (!k) return '?';
  if (k.key === 'symbol' || k.file) return `${short(k.file)}::${k.qualified_name}`;
  if (k.key === 'anchored') return `${name(k.ancestor)}#${k.ordinal}`;
  return `{${k.key}:${k.name ?? k.path ?? ''}}`;
};
const df = g.edges.filter((e) => e.kind === 'data_flow');
console.log(`${process.argv[2]}: ${df.length} data_flow edges`);
for (const e of df) console.log(`  ${name(e.source)} -> ${name(e.target)}`);

// Scratch: print the distinct `key.file` values and the stats block of a snapshot,
// to see how a run's path prefix differs from the golden's.
// Usage: node file-keys.mjs <snapshot.json>
import { readFileSync } from 'node:fs';

const s = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const files = [...new Set(s.nodes.map((n) => n.key.file))].sort();
console.log(`file_count: ${s.file_count}  distinct node files: ${files.length}`);
console.log('stats:', JSON.stringify(s.stats));
for (const f of files.slice(0, 15)) console.log('  ' + f);
if (files.length > 15) console.log(`  … ${files.length - 15} more`);

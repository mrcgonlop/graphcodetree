// Why does the built graph have 391 symbols when the snapshot lists 393 nodes?
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { S } from '../web/refactor/app/state.js';
import { buildElements } from '../web/refactor/app/builder.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const snap = JSON.parse(readFileSync(path.join(here, '..', 'web', 'refactor', 'graph.json'), 'utf8'));
S.snapshot = snap;

const ids = new Map();
const bad = snap.nodes.filter((n) => !n || !n.data || !n.data.id);
console.log('nodes entries lacking .data.id: ' + bad.length + (bad.length ? '  e.g. ' + JSON.stringify(bad[0]).slice(0, 300) : ''));
for (const n of snap.nodes) {
    if (!n || !n.data || !n.data.id) continue;
    ids.set(n.data.id, (ids.get(n.data.id) || 0) + 1);
}
const dup = [...ids].filter(([, c]) => c > 1);
console.log('snapshot nodes   ' + snap.nodes.length);
console.log('distinct ids     ' + ids.size);
console.log('duplicate ids    ' + dup.length + (dup.length ? '  -> ' + JSON.stringify(dup) : ''));
for (const [id, c] of dup) {
    const copies = snap.nodes.filter((n) => n.data.id === id);
    for (const cp of copies) console.log('     ' + c + 'x ' + id + '  label=' + cp.data.label + '  class=' + cp.classes);
}

const el = buildElements();
console.log('built nodes      ' + el.nodes.length + '  (' + el.nodes.filter((n) => n.data._isSymbol).length + ' symbols)');

// the 2 that vanish: nodeId() has no disambiguator, so same-qualified-name
// symbols in the same file collapse onto one id.
const { nodeId } = await import('../web/refactor/app/utils.js');
const seen = new Map();
for (const n of snap.nodes) {
    if (!n.key || n.key.key !== 'symbol') { console.log('   non-symbol key: ' + JSON.stringify(n.key)); continue; }
    const id = nodeId(n.key);
    if (seen.has(id)) {
        console.log('   COLLISION  ' + id);
        console.log('      kept   ' + JSON.stringify(seen.get(id)));
        console.log('      dropped ' + JSON.stringify(n.key));
    } else seen.set(id, n.key);
}
console.log('distinct nodeId  ' + seen.size);

// Scratch check that Phase 3 changed nothing about Rust: the Phase-0 golden was
// taken over a pre-refactor worktree, so re-snapshotting that worktree with the
// Python profile registered must yield the same nodes/edges/stats — the only
// delta is `file_count`, because the worktree's stray `web/*.py` scripts are now
// recognised as Python files (and contribute no definitions).
const fs = require('fs');
const path = require('path');

const root = '.kilo/worktrees/octagonal-governor';
const SKIP = new Set([
    'target',
    'node_modules',
    'vendor',
    'dist',
    'build',
    'coverage',
    '__pycache__',
    '.venv',
    'venv',
]);

let rs = 0;
let py = 0;
(function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue; // VCS noise + scratch
        if (entry.isDirectory()) {
            if (!SKIP.has(entry.name)) walk(path.join(dir, entry.name));
            continue;
        }
        if (entry.name.endsWith('.rs')) rs++;
        else if (entry.name.endsWith('.py')) py++;
    }
})(root);

const after = require(path.resolve('.cgtest/goldens/rust-repo-after.json'));
const filesWithNodes = new Set(after.nodes.map((n) => n.file));
const nonRs = [...filesWithNodes].filter((f) => !f.endsWith('.rs'));

console.log(`worktree census        : ${rs} .rs + ${py} .py = ${rs + py} recognised files`);
console.log(`snapshot file_count    : ${after.file_count}`);
console.log(`files carrying nodes   : ${filesWithNodes.size} (non-.rs: ${nonRs.length})`);
if (rs + py !== after.file_count) throw new Error('file_count does not match the census');
if (filesWithNodes.size !== rs) throw new Error('a non-Rust file contributed nodes');
if (nonRs.length !== 0) throw new Error(`non-Rust files with nodes: ${nonRs}`);
console.log('RUST-UNCHANGED CENSUS PASSED');

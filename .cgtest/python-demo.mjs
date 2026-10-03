// ── Python-snapshot harness for the viewer ───────────────────────────
//
// The extractor learned Python in Phase 3 (`crates/extract/src/python.rs`),
// but the view's own snapshot (`web/refactor/graph.json`) is, by design, this
// Rust repo. `web/python-demo/` is the other half of that claim: a real
// Python checkout (agx-emulsion) rendered by the same viewer and committed,
// so the multi-language path is visible without a Rust toolchain.
//
// A second snapshot is data the other two harnesses never see, and a copied
// page is markup that can drift, so this file pins both:
//
//   1. the snapshot is Python-only and keyed the way python.rs keys it: the
//      `lang` matches the file, every node is a symbol key, and no qualified
//      name carries Rust's `::` (`python.rs`'s `qual_sep` is `.`) — the same
//      rules `.cgtest/fixtures-check.cjs` applies to the fixtures;
//   2. the export is self-consistent (`stats` counts what `nodes`/`edges`
//      hold), so the numbers the sidebar prints for the demo mean something;
//   3. the calls that cross a file boundary are the enricher's work, not the
//      extractor's, so their count is pinned: `cg-enrich`'s R2 resolves them
//      from the caller's import records (in Python's dotted spelling), and the
//      picture cannot show whether that happened at all;
//   4. the REAL builder.js turns it into a tree at every detail level —
//      unique ids, no orphan parents, one container per file, a single root —
//      and the REAL hierarchy engine lays that tree out, i.e. nothing in the
//      view assumes the Rust snapshot's shape;
//   5. the demo page declares exactly the controls `web/refactor/index.html`
//      declares and still points its assets at `../refactor/`. `wiring.mjs`
//      only ever parses the refactor page, so a control added there would
//      silently become a no-op in the demo — `bindRange()` in controls.js
//      returns quietly when its element is missing.
//
// Run: node --experimental-default-type=module .cgtest/python-demo.mjs

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const cytoscape = require('./cytoscape.min.cjs');

const { S } = await import('../web/refactor/app/state.js');
const { buildElements } = await import('../web/refactor/app/builder.js');
const { buildLayoutOptions } = await import('../web/refactor/app/layout.js');
const { registerHierarchyLayout } = await import('../web/refactor/app/hierarchy.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const refactorDir = path.join(here, '..', 'web', 'refactor');
const demoDir = path.join(here, '..', 'web', 'python-demo');

const snapshot = JSON.parse(readFileSync(path.join(demoDir, 'graph.json'), 'utf8'));
S.snapshot = snapshot;

const EPS = 0.5;
let failures = 0, checks = 0;

function ok(cond, label, detail) {
    checks++;
    if (!cond) { failures++; console.log('   FAIL  ' + label + (detail !== undefined ? '  [' + detail + ']' : '')); }
    return cond;
}

// ── 1. What the snapshot is ─────────────────────────────────────────

/// Histogram of one field over the snapshot's nodes.
function tally(field) {
    const out = {};
    for (const n of snapshot.nodes) {
        const v = field === 'lang' ? (n.key || {}).lang : n.kind;
        out[v] = (out[v] || 0) + 1;
    }
    return out;
}

console.log('# snapshot: web/python-demo/graph.json');
console.log('# ' + snapshot.file_count + ' source files walked, ' + snapshot.nodes.length +
    ' defs, ' + snapshot.edges.length + ' edges');

const files = new Set(), dirs = new Set(), keyKinds = {};
let badLang = 0, badExt = 0, rustSep = 0, notSymbol = 0, fileMismatch = 0;
for (const n of snapshot.nodes) {
    const k = n.key || {};
    keyKinds[k.key] = (keyKinds[k.key] || 0) + 1;
    if (k.key !== 'symbol') notSymbol++;
    if (k.lang !== 'python') badLang++;
    const f = String(k.file || '');
    if (!f.toLowerCase().endsWith('.py')) badExt++;
    if (String(k.qualified_name || '').includes('::')) rustSep++;
    if (n.file !== k.file) fileMismatch++;
    files.add(f);
    const parts = f.split(/[\\/]/);
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
}
const kinds = tally('kind');

console.log('# languages ' + JSON.stringify(tally('lang')) + '  node kinds ' + JSON.stringify(kinds));
console.log('# ' + files.size + ' files with defs, ' + dirs.size + ' folders');

ok(snapshot.nodes.length > 0 && snapshot.edges.length > 0, 'snapshot is not empty');
ok(badLang === 0, 'every node is `lang: python`', badLang + ' non-python');
ok(badExt === 0, '...and lives in a .py file', badExt + ' other extension');
ok(notSymbol === 0, 'every node is a symbol key (no anchored key became a node)',
    JSON.stringify(keyKinds));
ok(rustSep === 0, 'no qualified name carries Rust\'s `::` separator', rustSep + ' with ::');
ok(fileMismatch === 0, '`node.file` mirrors `node.key.file`', fileMismatch + ' mismatched');
ok(files.size > 1 && dirs.size > 1, 'the walk found a real package tree',
    files.size + ' files / ' + dirs.size + ' folders');
ok((kinds['class'] || 0) > 0 && (kinds['function'] || 0) > 0 && (kinds['method'] || 0) > 0,
    'classes, functions and methods all classified', JSON.stringify(kinds));
ok(!Object.prototype.hasOwnProperty.call(kinds, 'struct'),
    'no Rust-only node kind leaked into a Python walk');
ok(snapshot.file_count >= files.size,
    'the walk counted at least the files that contributed a def (a def-less file gets no box)',
    snapshot.file_count + ' walked vs ' + files.size + ' with defs');

// ── 2. The export agrees with itself ────────────────────────────────

const counted = {};
for (const e of snapshot.edges) counted[e.kind] = (counted[e.kind] || 0) + 1;
const st = snapshot.stats || {};

console.log('\n## stats vs. contents');
console.log('   ' + JSON.stringify(st));

ok(st.total_nodes === snapshot.nodes.length, 'stats.total_nodes === nodes.length',
    st.total_nodes + ' vs ' + snapshot.nodes.length);
ok(st.total_edges === snapshot.edges.length, 'stats.total_edges === edges.length',
    st.total_edges + ' vs ' + snapshot.edges.length);
ok(st.function_count === (kinds['function'] || 0) + (kinds['method'] || 0),
    'stats.function_count counts functions + methods',
    st.function_count + ' vs ' + ((kinds['function'] || 0) + (kinds['method'] || 0)));
ok(st.calls_edge_count === (counted['calls'] || 0), 'stats.calls_edge_count === `calls` edges',
    st.calls_edge_count + ' vs ' + (counted['calls'] || 0));
ok(st.contains_edge_count === (counted['contains'] || 0),
    'stats.contains_edge_count === `contains` edges',
    st.contains_edge_count + ' vs ' + (counted['contains'] || 0));
ok(st.impl_edge_count === 0 && st.trait_count === 0 && st.struct_count === 0,
    'Rust-only counters stay at zero on a Python snapshot',
    JSON.stringify([st.impl_edge_count, st.trait_count, st.struct_count]));
ok(st.data_flow_edge_count === (counted['data_flow'] || 0),
    'stats.data_flow_edge_count === `data_flow` edges',
    st.data_flow_edge_count + ' vs ' + (counted['data_flow'] || 0));

// ── 3. The real builder turns it into a tree ────────────────────────

console.log('\n## builder.js at every detail level');

const folderSet = new Set();
for (const f of files) {
    const parts = f.split(/[\\/]/);
    for (let i = 1; i < parts.length; i++) folderSet.add(parts.slice(0, i).join('/'));
}

const built = {};
for (const detail of ['full', 'files', 'flat']) {
    S.detail = detail;
    let el = null;
    try { el = buildElements(); } catch (err) { el = null; }
    if (!ok(!!el, 'buildElements() survives detail = ' + detail, el ? undefined : 'threw')) continue;

    const ids = new Set(el.nodes.map(n => n.data.id));
    built[detail] = el;
    const symbols = el.nodes.filter(n => n.data._isSymbol).length;
    const fileBoxes = el.nodes.filter(n => n.data._isFileContainer).length;
    const folderBoxes = el.nodes.filter(n => n.data._isFolder).length;
    const roots = el.nodes.filter(n => !n.data.parent);
    const orphans = el.nodes.filter(n => n.data.parent && !ids.has(n.data.parent));
    const dangling = el.edges.filter(e => !ids.has(e.data.source) || !ids.has(e.data.target));

    console.log('   ' + detail.padEnd(6) + el.nodes.length + ' boxes (' + folderBoxes + ' folder, ' +
        fileBoxes + ' file, ' + symbols + ' symbol), ' + el.edges.length + ' edges, ' +
        roots.length + ' root(s)');

    ok(ids.size === el.nodes.length, detail + ': element ids are unique',
        (el.nodes.length - ids.size) + ' duplicate(s)');
    ok(orphans.length === 0, detail + ': no orphan parent references', orphans.length);
    ok(symbols === snapshot.nodes.length, detail + ': every def became a node',
        symbols + ' vs ' + snapshot.nodes.length);
    ok(folderBoxes === (detail === 'full' ? folderSet.size + 1 : 0),
        detail + ': a folder box per directory, plus the synthetic root (only at detail=full)',
        folderBoxes + ' vs ' + (folderSet.size + 1));
    ok(detail !== 'full' || (roots.length === 1 && roots[0].data.id === 'folder:__root__'),
        detail + ': the single root is the synthetic root folder',
        detail === 'full' ? String(roots[0] && roots[0].data.id) : 'n/a');
    ok(fileBoxes === (detail === 'flat' ? 0 : files.size),
        detail + ': a file box per file (and only when files are drawn)',
        fileBoxes + ' vs ' + files.size);
    ok(roots.length === (detail === 'full' ? 1 : detail === 'files' ? files.size : snapshot.nodes.length),
        detail + ': the tree has the root(s) it should', roots.length);
    ok(dangling.length === 0, detail + ': every edge endpoint exists', dangling.length);
    ok(el.edges.every(e => e.data.source !== e.data.target), detail + ': no self-edges',
        el.edges.filter(e => e.data.source === e.data.target).length);
}

// ── 4. The real engine lays that tree out ───────────────────────────

const { BORDERS } = await import('../web/refactor/app/constants.js');

/// The geometry-bearing half of main.js's stylesheet (the `node` /
/// `[_isSymbol]` / `[_isFileContainer]` / `[_isFolder]` rules): width, height,
/// padding and border are the only style values hierarchy.js measures.
function viewerStyle() {
    return [
        { selector: 'node', style: { 'border-width': BORDERS.symbol, label: '' } },
        { selector: 'node[_isSymbol]', style: { width: S.nodeSize, height: S.nodeSize } },
        {
            selector: 'node[_isFileContainer]',
            style: { 'border-width': BORDERS.file, padding: S.containerPadding, label: '' },
        },
        {
            selector: 'node[_isFolder]',
            style: { 'border-width': BORDERS.folder, padding: S.folderPadding, label: '' },
        },
    ];
}

console.log('\n## hierarchy engine on the Python tree');

registerHierarchyLayout(cytoscape);
S.detail = 'full';
S.engine = 'hierarchy';
const fullEl = built['full'];
const cy = cytoscape({
    headless: true,
    styleEnabled: true,
    elements: [].concat(fullEl.nodes, fullEl.edges),
    style: viewerStyle(),
});
const opts = buildLayoutOptions();
ok(opts.name === 'hierarchy', 'buildLayoutOptions() selects the tree engine', opts.name);

let stops = 0;
const lg = cy.layout(opts);
lg.one('layoutstop', function () { stops++; });
lg.run();
ok(stops === 1, 'layoutstop fired exactly once');
ok(!!S.hierarchyStats, 'S.hierarchyStats populated',
    S.hierarchyStats ? JSON.stringify(S.hierarchyStats) : 'missing');
console.log('   stats ' + JSON.stringify(S.hierarchyStats));

let badPos = 0, escaped = 0, containers = 0;
cy.nodes().forEach(function (n) {
    const p = n.position();
    if (!isFinite(p.x) || !isFinite(p.y)) badPos++;
});
cy.nodes().forEach(function (parent) {
    const kids = parent.children();
    if (kids.length === 0) return;
    containers++;
    const p = parent.boundingBox({ includeLabels: false, includeOverlays: false });
    kids.forEach(function (c) {
        const b = c.boundingBox({ includeLabels: false, includeOverlays: false });
        if (b.x1 < p.x1 - EPS || b.y1 < p.y1 - EPS || b.x2 > p.x2 + EPS || b.y2 > p.y2 + EPS) escaped++;
    });
});

console.log('   ' + containers + ' compound containers, ' + cy.nodes().length + ' boxes laid out');
ok(badPos === 0, 'every box got a finite position', badPos);
ok(containers === folderSet.size + 1 + files.size,
    'every folder (plus the root) and every file box is compound',
    containers + ' vs ' + (folderSet.size + 1 + files.size));
ok(escaped === 0, 'every child box sits inside its parent (measured)', escaped);
cy.destroy();

// ── 5. Cross-file resolution ────────────────────────────────────────
//
// The extractor only wires calls it can see inside one file. Everything that
// crosses a file boundary is added afterwards, by cg-enrich's R2
// (`CallGraphEnricher`), from the caller's own import records. For Python that
// used to produce *nothing* — the hints are dotted (`pkg.mod.helper`) and were
// split on Rust's `::` — so the picture showed a Python project whose files
// never called each other. The counts are pinned because none of it is visible
// on screen: a picture of only same-file calls looks the same either way.

console.log('\n## cross-file edges (cg-enrich\'s job)');

/// The symbol an edge endpoint names, the way utils.resolveToSymbol does it: a
/// call site is an `Anchored` key hanging off the definition that owns it.
function endpoint(keyRef) {
    let cur = keyRef;
    while (cur && cur.key !== 'symbol') {
        if (cur.key === 'anchored' && cur.ancestor) cur = cur.ancestor;
        else break;
    }
    return cur && cur.key === 'symbol' ? cur : null;
}

const symbolKeys = new Set(snapshot.nodes.map(n => JSON.stringify(n.key)));
let sameFileCalls = 0, crossFileCalls = 0, danglingCalls = 0;
let crossDataFlow = 0, crossImports = 0;
const callTargets = new Set(), crossCallPairs = new Set();
for (const e of snapshot.edges) {
    if (e.kind !== 'calls' && e.kind !== 'data_flow' && e.kind !== 'imports') continue;
    const s = endpoint(e.source), t = endpoint(e.target);
    if (!s || !t) {
        if (e.kind === 'calls') danglingCalls++;
        continue;
    }
    const cross = s.file !== t.file;
    if (e.kind === 'calls') {
        // A call edge is drawn symbol-to-symbol, so both ends have to be
        // definitions in `nodes` — an endpoint that is not would be dropped by
        // builder.js and leave the count meaningless.
        if (!symbolKeys.has(JSON.stringify(s)) || !symbolKeys.has(JSON.stringify(t))) {
            danglingCalls++;
            continue;
        }
        if (cross) {
            crossFileCalls++;
            callTargets.add(String(t.file).replace(/\\/g, '/'));
            crossCallPairs.add(s.qualified_name + ' -> ' + t.qualified_name);
        } else sameFileCalls++;
    } else if (e.kind === 'data_flow' && cross) crossDataFlow++;
    // An import edge starts at the importing *file*, a node the export leaves
    // out on purpose, so this is counted by file and not by node membership.
    else if (e.kind === 'imports' && cross) crossImports++;
}
console.log('   calls ' + sameFileCalls + ' same-file + ' + crossFileCalls + ' cross-file, ' +
    crossDataFlow + ' cross-file data_flow, ' + crossImports + ' cross-file imports');

ok(danglingCalls === 0, 'every call edge points at two definitions', danglingCalls);
ok(sameFileCalls === 196, 'the extractor still wires the same-file calls it always did', sameFileCalls);
ok(crossFileCalls === 83,
    'the enricher resolved 83 cross-file calls (it resolved none before R2 learnt Python)',
    crossFileCalls);
ok(callTargets.size >= 20, 'those calls land in many modules, not one',
    callTargets.size + ' target files');
ok(crossDataFlow === 26, 'data flow follows the resolved calls across files', crossDataFlow);
ok(crossImports === 100, 'every import edge crosses a file', crossImports);
ok(crossCallPairs.has('compute_with_lut -> apply_lut_cubic_3d'),
    'a known cross-file call, end to end',
    [...crossCallPairs].slice(0, 3).join(', '));


// ── 6. The demo page is the refactor page, re-pointed ───────────────

console.log('\n## web/python-demo/index.html vs web/refactor/index.html');

/// Everything `initControls()` looks for in the markup, extracted the same
/// way wiring.mjs extracts it.
function declarations(html) {
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(function (m) { return m[1]; }).sort();
    const presets = [...html.matchAll(/data-preset="([^"]+)"/g)].map(function (m) { return m[1]; }).sort();
    const checkboxes = [...html.matchAll(/type="checkbox"[^>]*id="([^"]+)"/g)]
        .map(function (m) { return m[1]; }).sort();
    const ranges = {};
    for (const m of html.matchAll(/<input[^>]*type="range"[^>]*>/g)) {
        const idm = /id="([^"]+)"/.exec(m[0]);
        if (!idm) continue;
        const attrs = {};
        for (const a of m[0].matchAll(/(min|max|step|value)="([^"]+)"/g)) attrs[a[1]] = a[2];
        ranges[idm[1]] = attrs;
    }
    const selects = {};
    for (const m of html.matchAll(/<select id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
        selects[m[1]] = [...m[2].matchAll(/<option value="([^"]+)"/g)].map(function (o) { return o[1]; });
    }
    return { ids: ids, presets: presets, checkboxes: checkboxes, ranges: ranges, selects: selects };
}

const refactorHtml = readFileSync(path.join(refactorDir, 'index.html'), 'utf8');
const demoHtml = readFileSync(path.join(demoDir, 'index.html'), 'utf8');
const refactor = declarations(refactorHtml);
const page = declarations(demoHtml);

// The extraction above is regex-based: if a pattern stops matching, both
// sides come back empty and every comparison below passes for the wrong
// reason. So first prove the parser found the real page.
ok(refactor.ids.length > 20 && refactor.presets.length > 0 && refactor.checkboxes.length > 0 &&
    Object.keys(refactor.ranges).length > 5 && Object.keys(refactor.selects).length > 0,
    'the parser really read the refactor page',
    refactor.ids.length + ' ids / ' + Object.keys(refactor.ranges).length + ' ranges / ' +
    refactor.presets.length + ' presets');

console.log('   refactor ' + JSON.stringify([refactor.ids.length, Object.keys(refactor.ranges).length,
    Object.keys(refactor.selects).length, refactor.presets.length, refactor.checkboxes.length]));
console.log('   demo     ' + JSON.stringify([page.ids.length, Object.keys(page.ranges).length,
    Object.keys(page.selects).length, page.presets.length, page.checkboxes.length]));

for (const [what, a, b] of [
    ['ids', refactor.ids, page.ids],
    ['preset buttons', refactor.presets, page.presets],
    ['checkboxes', refactor.checkboxes, page.checkboxes],
]) {
    const missing = a.filter(function (x) { return !b.includes(x); });
    const extra = b.filter(function (x) { return !a.includes(x); });
    ok(missing.length === 0 && extra.length === 0, 'the demo page declares the same ' + what,
        'missing ' + JSON.stringify(missing) + ' extra ' + JSON.stringify(extra));
}

ok(JSON.stringify(refactor.ranges) === JSON.stringify(page.ranges),
    'the demo page declares the same sliders with the same bounds');
ok(JSON.stringify(refactor.selects) === JSON.stringify(page.selects),
    'the demo page declares the same selects with the same options');

ok(demoHtml.includes('src="../refactor/app/main.js"'),
    'the demo page runs the viewer modules from ../refactor/');
ok(demoHtml.includes('href="../refactor/style.css"'),
    '...and the viewer stylesheet');
ok(!demoHtml.includes('src="app/main.js"') && !demoHtml.includes('href="style.css"'),
    'no asset is referenced as if it lived next to the page');
ok(!/fetch\(\s*['"]|JSON\.parse\(/.test(demoHtml),
    'the page fetches its data like the viewer expects, rather than inlining it');

// A page opened straight off the filesystem is served from a `file://` origin,
// where browsers run neither ES modules nor fetch() — so the viewer never
// boots, the sidebar (static HTML) still renders, and the canvas stays empty.
// That looks exactly like "the graph is broken", which is why both pages
// carry the same inline guard that names the real problem.
function inlineScripts(html) {
    return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
        .map(function (m) { return m[1].trim(); });
}
const demoGuard = inlineScripts(demoHtml);
const refGuard = inlineScripts(refactorHtml);
ok(demoGuard.length === 1 && /location\.protocol === 'file:'/.test(demoGuard[0] || ''),
    'the page guards against a file:// origin (the silent empty-canvas failure)',
    demoGuard.length + ' inline script(s)');
ok(JSON.stringify(demoGuard) === JSON.stringify(refGuard),
    '...and that guard is identical to the one on web/refactor/index.html');
ok(/python -m http\.server/.test(demoGuard[0] || ''),
    '...and it names the server command that fixes it');
ok(/never started/.test(demoGuard[0] || '') && /setTimeout\(cgBootHint/.test(demoGuard[0] || ''),
    '...and it also covers being served from the page\'s own folder (assets 404, module never loads)');

// A `<script src>` that 404s looks exactly like a viewer that never boots, so
// resolve every local reference the page makes, one folder at a time.
const localRefs = [...demoHtml.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map(function (m) { return m[1]; })
    .filter(function (u) { return !/^https?:/.test(u); });
console.log('   local refs ' + JSON.stringify(localRefs));
ok(localRefs.length > 0 && localRefs.every(function (u) { return existsSync(path.resolve(demoDir, u)); }),
    'every local reference on the page resolves to a file',
    localRefs.filter(function (u) { return !existsSync(path.resolve(demoDir, u)); }).join(', '));
ok(existsSync(path.join(demoDir, 'graph.json')),
    '...including the graph.json that fetch() will look for next to the page');

const mainJs = readFileSync(path.join(refactorDir, 'app', 'main.js'), 'utf8');
ok(mainJs.includes("fetch('graph.json')"),
    'main.js still fetches `graph.json` relative to the page — that is what makes the copy work');

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED') +
    '   (' + checks + ' assertions)');

process.exit(failures === 0 ? 0 : 1);


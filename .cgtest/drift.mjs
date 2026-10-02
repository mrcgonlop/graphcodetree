// ── Why does the tree extent differ after visiting another engine? ────
// hierarchy.js sizes a box with `measure()` (= cytoscape's rendered
// boundingBox) and only falls back to the analytic subtree size when
// cytoscape cannot answer. If that measured value depends on the
// arrangement the PREVIOUS engine left behind, the same tree can come out
// marginally different (wiring.mjs saw 134x16 on a 14968x3377 picture).
//
// This probe separates the two possibilities:
//   • the engine is non-deterministic (same input, different output), or
//   • the measurement it reads is not a function of the tree alone.
//
// Progress is appended to drift-out.txt synchronously, so a slow run still
// leaves what it got to. Bounding-box queries on a deep compound graph can
// be far more expensive than the layout itself, hence the timings.
//
// Run: node --experimental-default-type=module .cgtest/drift.mjs

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const cytoscape = require('./cytoscape.min.cjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', 'web', 'refactor');
const outFile = path.join(here, 'drift-out.txt');
writeFileSync(outFile, '');

function log(s) {
    console.log(s);
    appendFileSync(outFile, s + '\n');
}

const { S } = await import('../web/refactor/app/state.js');
const { buildElements } = await import('../web/refactor/app/builder.js');
const { buildLayoutOptions } = await import('../web/refactor/app/layout.js');
const { registerHierarchyLayout } = await import('../web/refactor/app/hierarchy.js');

S.snapshot = JSON.parse(readFileSync(path.join(root, 'graph.json'), 'utf8'));
S.detail = 'full';
S.engine = 'hierarchy';

registerHierarchyLayout(cytoscape);
const built = buildElements();
const cy = cytoscape({
    headless: true, styleEnabled: true, elements: [].concat(built.nodes, built.edges),
    style: [
        { selector: 'node[_isSymbol]', style: { width: S.nodeSize, height: S.nodeSize } },
        { selector: 'node[_isFileContainer]', style: { 'border-width': 1.5, padding: S.containerPadding } },
        { selector: 'node[_isFolder]', style: { 'border-width': 2, padding: S.folderPadding } },
    ],
});
S.cy = cy;

const allNodes = cy.nodes();
log('# ' + allNodes.length + ' nodes, ' + cy.edges().length + ' edges');

let boxes = null;
function containerNodes() {
    if (!boxes) boxes = allNodes.filter(function (n) { return n.children().length > 0; });
    return boxes;
}

/// Rendered size of every box. Only containers matter here: a symbol's size
/// is style-driven and fixed, a container's is derived from its children.
function measureBoxes() {
    const m = new Map();
    for (const n of containerNodes()) {
        const t0 = Date.now();
        const bb = n.boundingBox({ includeLabels: false, includeOverlays: false });
        const dt = Date.now() - t0;
        if (dt > 50) log('#   slow boundingBox: ' + n.id() + ' took ' + dt + 'ms');
        m.set(n.id(), bb ? { w: Math.round(bb.w * 100) / 100, h: Math.round(bb.h * 100) / 100 } : null);
    }
    return m;
}

function extent() {
    const bb = cy.elements().boundingBox({ includeLabels: false, includeOverlays: false });
    return { w: Math.round(bb.w), h: Math.round(bb.h) };
}

/// Which measured sizes changed between two snapshots, largest first.
function diffSizes(a, b) {
    const out = [];
    for (const [id, va] of a) {
        const vb = b.get(id);
        if (!va || !vb) { if (va !== vb) out.push({ id: id, before: va, after: vb, d: Infinity }); continue; }
        const dw = Math.abs(vb.w - va.w), dh = Math.abs(vb.h - va.h);
        if (dw > 1e-9 || dh > 1e-9) out.push({ id: id, before: va, after: vb, d: dw + dh });
    }
    out.sort(function (p, q) { return q.d - p.d; });
    return out;
}

let checks = 0, fails = 0;
function ok(cond, label, detail) {
    checks++;
    if (!cond) fails++;
    log((cond ? '# PASS  ' : '# FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
}

function runTree() { return cy.layout(buildLayoutOptions()).run(); }

function stamp(t0, what) {
    log('#   ' + what + ' in ' + (Date.now() - t0) + 'ms');
    return Date.now();
}

// ── 1. fresh state → tree, twice ────────────────────────────────────
let t = Date.now();
const M0 = measureBoxes();
t = stamp(t, 'measure fresh (' + containerNodes().length + ' boxes)');
runTree();
const ext1 = extent();
t = stamp(t, 'tree run 1');
const M1 = measureBoxes();
t = stamp(t, 'measure 1');
runTree();
const ext2 = extent();
t = stamp(t, 'tree run 2');
const M2 = measureBoxes();
stamp(t, 'measure 2');

log('# fresh build            extent ' + ext1.w + 'x' + ext1.h);
log('# tree → tree            extent ' + ext2.w + 'x' + ext2.h +
    (ext1.w === ext2.w && ext1.h === ext2.h ? '   (identical)' : '   *** DIFFERS ***'));
log('# measured sizes: fresh → tree   ' + diffSizes(M0, M1).length + ' box(es) changed');
log('# measured sizes: tree  → tree   ' + diffSizes(M1, M2).length + ' box(es) changed');

ok(ext1.w === ext2.w && ext1.h === ext2.h, 'tree run 2 reproduces run 1 extent',
    ext1.w + 'x' + ext1.h + ' vs ' + ext2.w + 'x' + ext2.h);
ok(diffSizes(M1, M2).length === 0, 'tree run 2 changes no rendered box size');


// ── 2. wander off to another engine, then come back ─────────────────
// 'grid' rather than 'cose': the question is whether *any* other engine
// perturbs what the tree engine measures, and grid is instant.
t = Date.now();
S.engine = 'grid';
cy.layout(buildLayoutOptions()).run();
t = stamp(t, 'grid run');
t = Date.now();
const M3 = measureBoxes();
t = stamp(t, 'measure 3');
console.log('# measured sizes: tree  → grid   ' + diffSizes(M2, M3).length + ' node(s) changed');
for (const d of diffSizes(M2, M3).slice(0, 6)) {
    log('     ' + d.id + '   ' + JSON.stringify(d.before) + ' → ' + JSON.stringify(d.after));
}

S.engine = 'hierarchy';
runTree();
const ext3 = extent();
t = stamp(t, 'tree run 3');
const M4 = measureBoxes();
stamp(t, 'measure 4');
log('# grid → tree            extent ' + ext3.w + 'x' + ext3.h +
    (ext3.w === ext1.w && ext3.h === ext1.h ? '   (identical to fresh)' : '   *** DIFFERS from fresh ***'));

log('# measured sizes: grid → tree   ' + diffSizes(M3, M4).length + ' box(es) changed');
const pathological = diffSizes(M1, M4).filter(function (d) { return Math.abs(d.after.w - d.before.w) + Math.abs(d.after.h - d.before.h) > 0.5; });
log('# settled-tree sizes vs post-grid sizes: ' + pathological.length + ' box(es) differ by >0.5u');
for (const d of pathological.slice(0, 8)) {
    log('     ' + d.id + '   ' + d.before.w + 'x' + d.before.h + ' → ' + d.after.w + 'x' + d.after.h);

ok(ext3.w === ext1.w && ext3.h === ext1.h, 'tree after grid matches the fresh tree',
    ext3.w + 'x' + ext3.h + ' vs ' + ext1.w + 'x' + ext1.h);
ok(pathological.length === 0, 'post-grid box sizes match the settled tree');
ok(diffSizes(M4, M5).length === 0, 'measuring twice with no run in between changes nothing');

}

// Does the engine's own output feed back into what it measures next?
// (a container's rendered size can go stale until something refreshes it)
const M5 = measureBoxes();
log('# measured sizes: tree → tree-again (measured twice, no run): ' + diffSizes(M4, M5).length + ' changed');
log('# done');

// ── 2b. is the tree a fixed point for *every* parameter set? ────────
// The wiring test drives every slider to its maximum (as declared in
// index.html) and then saw 14968x3377 on the run that followed the last
// tree slider, but 14834x3361 after leaving and returning to the engine.
// Same parameters, different picture — so run the extreme set several
// times and watch for a fixed point.
S.engine = 'hierarchy';
S.nodeSize = 80;            // node-size-range max
S.containerPadding = 60;    // pad-range max
S.folderPadding = 80;       // folder-pad-range max
S.hierNodeGapX = 80;        // hier-nodegapx-range max
S.hierNodeGapY = 80;        // hier-nodegapy-range max
S.hierColGap = 160;         // hier-colgap-range max
S.hierRowGap = 240;         // hier-rowgap-range max
S.hierAspect = 3;           // hier-aspect-range max
S.layout.layoutPadding = 200;

log('');
log('## extreme sliders: nodeSize 80, pads 60/80, gaps 80/80/160/240, aspect 3');
cy.style()
    .selector('node[_isSymbol]').style('width', S.nodeSize).style('height', S.nodeSize)
    .selector('node[_isFileContainer]').style('padding', S.containerPadding)
    .selector('node[_isFolder]').style('padding', S.folderPadding)
    .update();

let prevSizes = measureBoxes();
let firstPassExt = null;

let prevExt = null;
for (let pass = 1; pass <= 4; pass++) {
    runTree();
    const e = extent();
    const sizes = measureBoxes();
    const changed = diffSizes(prevSizes, sizes);
    log('# pass ' + pass + ': extent ' + e.w + 'x' + e.h +
        '   boxes whose size changed during the pass: ' + changed.length +
        (prevExt && prevExt.w === e.w && prevExt.h === e.h ? '   (same extent as previous pass)' : ''));
    for (const d of changed.slice(0, 4)) {
        log('     resize: ' + d.id + '   ' + d.before.w + 'x' + d.before.h + ' → ' + d.after.w + 'x' + d.after.h);
    }
    prevSizes = sizes;
    if (firstPassExt === null) firstPassExt = e;
    else ok(e.w === firstPassExt.w && e.h === firstPassExt.h,
        'extreme parameters: pass ' + pass + ' reproduces the fixed point',
        e.w + 'x' + e.h + ' vs ' + firstPassExt.w + 'x' + firstPassExt.h);

    prevExt = e;
}
// ── 2c. bisect the perturbation ─────────────────────────────────────
// Same parameter set, one other engine in between, and compare against
// the reference tree. Whatever changes the answer is what to look at.
const ref = extent();
log('## reference tree: ' + ref.w + 'x' + ref.h);

// ── 2d. what exactly does breadthfirst leave behind? ────────────────
// The engine sizes every box from its *measured* (rendered) box, so the
// question is whether the children sit centred inside their box. If they
// do not, the measured box is larger than the eventual arrangement and a
// pass packs with stale numbers.
function probeBox(id, sizes) {
    const n = cy.getElementById(id);
    if (!n || n.length === 0) return null;
    const bb = sizes.get(id);
    const kids = n.children();
    if (!bb || kids.length === 0) return null;
    const p = n.position();
    let l = Infinity, r = -Infinity, t = Infinity, bb2 = -Infinity;
    kids.forEach(function (k) {
        const kp = k.position();
        l = Math.min(l, kp.x - p.x); r = Math.max(r, kp.x - p.x);
        t = Math.min(t, kp.y - p.y); bb2 = Math.max(bb2, kp.y - p.y);
    });
    const round = function (v) { return Math.round(v * 10) / 10; };
    return {
        id: id, w: bb.w, h: bb.h, n: kids.length,
        offX: round(r + l),          // 0 when the children are centred
        offY: round(bb2 + t),
        fitX: round(r - l - bb.w),   // 0 when the box hugs its children
        fitY: round(bb2 - t - bb.h),
    };
}

const leaves = [];
cy.nodes().forEach(function (n) {
    const k = n.children();
    if (k.length > 0) {
        let all = true;
        k.forEach(function (c) { if (c.children().length > 0) all = false; });
        if (all) leaves.push(n.id());
    }
});
const probeIds = ['folder:crates/store/src', 'folder:crates/ir/src'];
if (leaves.length > 0) probeIds.push(leaves[0]);

function reportProbes(tag) {
    const sizes = measureBoxes();
    for (const id of probeIds) {
        const p = probeBox(id, sizes);
        if (p) log('    ' + tag + ' ' + p.id + '  box ' + p.w + 'x' + p.h + '  kids ' + p.n +
            '  centreOffset ' + p.offX + '/' + p.offY + '  boxMinusKids ' + p.fitX + '/' + p.fitY);
    }
}

function probeKey() {
    const sizes = measureBoxes();
    return probeIds.map(function (id) {
        const p = probeBox(id, sizes);
        return p ? p.w + 'x' + p.h : '-';
    }).join(' | ');
}

reportProbes('settled ');
const settledProbes = probeKey();

// Leave the graph in the worst state cytoscape can hand us: breadthfirst on a
// compound graph scatters a box's children to absurd coordinates and leaves
// the box 153.5x153.5 (see the probe lines above), so every size the old
// measure()-based engine would have read is garbage.
S.engine = 'breadthfirst';
cy.layout(buildLayoutOptions()).run();
reportProbes('after bf');

S.engine = 'hierarchy';
runTree();
reportProbes('after tree');
const afterTreeProbes = probeKey();
const extAfterBf = extent();

ok(extAfterBf.w === ref.w && extAfterBf.h === ref.h,
    'tree after breadthfirst matches the reference extent',
    extAfterBf.w + 'x' + extAfterBf.h + ' vs ' + ref.w + 'x' + ref.h);
ok(afterTreeProbes === settledProbes,
    'box sizes after breadthfirst match the settled tree exactly',
    afterTreeProbes === settledProbes ? '' : 'settled ' + settledProbes + '  now ' + afterTreeProbes);


// ── 3. same question for positions: is the tree itself stable? ──────
function positions() {
    const m = new Map();
    cy.nodes().forEach(function (n) { const p = n.position(); m.set(n.id(), { x: p.x, y: p.y }); });
    return m;
}
const P1 = positions();
runTree();
const P2 = positions();
let moved = 0, maxD = 0;
for (const [id, p] of P1) {
    const q = P2.get(id);
    const d = Math.abs(q.x - p.x) + Math.abs(q.y - p.y);
    if (d > 1e-6) { moved++; maxD = Math.max(maxD, d); }
}
ok(moved === 0, 'consecutive tree runs move nothing',
    moved + ' node(s) moved, max ' + (Math.round(maxD * 1000) / 1000) + 'u');

log('');
log(fails === 0 ? 'ALL DRIFT CHECKS PASSED   (' + checks + ' assertions)'
    : 'FAILED ' + fails + ' of ' + checks + ' drift checks');
process.exit(fails === 0 ? 0 : 1);

// ── Validation harness for the 'hierarchy' containment engine ────────
//
// Runs the REAL app modules (state, builder, layout, hierarchy) against the
// REAL graph.json inside a REAL (headless) cytoscape, with the same sizing
// rules main.js applies, and then asserts the invariants that force-directed
// cose has never satisfied:
//
//   1. every child box sits inside its parent box — measured, not assumed;
//   2. sibling boxes never overlap, at any level;
//   3. every box is snug and symmetric around its own position, i.e.
//      exactly (children + padding) — which is what makes 1 and 2 hold;
//   4. the result is deterministic: two runs give identical positions;
//   5. the packed tree is far smaller than the cose cloud, which is the
//      actual point — at fit-to-view the symbols end up readable.
//
// Run: node --experimental-default-type=module .cgtest/validate.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const cytoscape = require('./cytoscape.min.cjs');

const { S, applyPreset, PRESETS } = await import('../web/refactor/app/state.js');
const { buildElements } = await import('../web/refactor/app/builder.js');
const { buildLayoutOptions } = await import('../web/refactor/app/layout.js');
const { hierarchyLayout, registerHierarchyLayout } = await import('../web/refactor/app/hierarchy.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const snapshot = JSON.parse(readFileSync(path.join(here, '..', 'web', 'refactor', 'graph.json'), 'utf8'));
S.snapshot = snapshot;

const EPS = 0.75;
let failures = 0, checks = 0;

function ok(cond, label, detail) {
    checks++;
    if (!cond) { failures++; console.log('   FAIL  ' + label + (detail ? '  [' + detail + ']' : '')); }
    return cond;
}

/// Mirror of the sizing rules in main.js: width/height/padding/border are the
/// only style values the engine's geometry depends on.
function stylesheet() {
    return [
        { selector: 'node', style: { 'border-width': 2, 'border-color': '#4a5080', label: '' } },
        { selector: 'node[_isSymbol]', style: { width: S.nodeSize, height: S.nodeSize } },
        {
            selector: 'node[_isFileContainer]',
            style: {
                'border-width': 1.5, padding: S.containerPadding, shape: 'round-rectangle',
                label: 'data(label)', 'text-valign': 'top',
            },
        },
        {
            selector: 'node[_isFolder]',
            style: {
                'border-width': 2, padding: S.folderPadding, shape: 'round-rectangle',
                label: 'data(label)', 'text-valign': 'top',
            },
        },
    ];
}

function createCy(detail) {
    S.detail = detail;
    const el = buildElements();
    return cytoscape({
        headless: true,
        styleEnabled: true,
        elements: [].concat(el.nodes, el.edges),
        style: stylesheet(),
    });
}

/// The box cytoscape has assigned to a node (children + padding for a
/// compound parent). Independent of the layout code under test.
function box(n) {
    const bb = n.boundingBox({ includeLabels: false, includeOverlays: false });
    return { x1: bb.x1, y1: bb.y1, x2: bb.x2, y2: bb.y2, w: bb.w, h: bb.h };
}

function positions(cy) {
    const out = new Map();
    cy.nodes().forEach(function (n) { const p = n.position(); out.set(n.id(), p.x.toFixed(6) + ',' + p.y.toFixed(6)); });
    return out;
}

function overlapArea(a, b) {
    const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
    const h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
    return (w > 0 && h > 0) ? w * h : 0;
}

function groups(cy) {
    const kids = new Map(), roots = [], byId = new Map();
    const nodes = cy.nodes().toArray();
    for (const n of nodes) { kids.set(n.id(), []); byId.set(n.id(), n); }
    for (const n of nodes) {
        const pid = n.data('parent');
        if (pid && kids.has(pid)) kids.get(pid).push(n); else roots.push(n);
    }
    return { kids: kids, roots: roots, nodes: nodes };
}

// ── Invariant checks ────────────────────────────────────────────────

let worstGap = Infinity, worstInsetErr = 0, worstSymErr = 0, mostLevels = 0, minLeafGap = Infinity;
const insetByStyle = new Map();

function checkInvariants(cy, tag) {
    const g = groups(cy);
    const boxes = new Map();
    for (const n of g.nodes) boxes.set(n.id(), box(n));

    let containers = 0, held = 0, snugged = 0, siblingPairs = 0, overlaps = 0;

    for (const [pid, list] of g.kids) {
        if (list.length === 0) continue;
        containers++;
        const parent = cy.getElementById(pid);
        const pad = parent.data('_isFolder') ? S.folderPadding : S.containerPadding;
        const bw = parseFloat(parent.style('border-width')) || 0;
        const outer = boxes.get(pid);

        // (1) containment + (3) snug, symmetric box around its position
        let left = Infinity, right = Infinity, top = Infinity, bottom = Infinity;
        for (const c of list) {
            const b = boxes.get(c.id());
            left = Math.min(left, b.x1 - outer.x1);
            right = Math.min(right, outer.x2 - b.x2);
            top = Math.min(top, b.y1 - outer.y1);
            bottom = Math.min(bottom, outer.y2 - b.y2);
        }
        // The predicted inset is padding + the box's own border (cytoscape
        // draws a compound node's border outside its padding). The engine
        // must land on that number, since it now computes box sizes from it.
        const want = pad + bw;
        const insetErr = Math.max(Math.abs(left - want), Math.abs(right - want),
            Math.abs(top - want), Math.abs(bottom - want));
        worstInsetErr = Math.max(worstInsetErr, insetErr);

        // How much slack does cytoscape leave around "children + padding"?
        // Observe it instead of guessing (it folds in the container's own
        // border), and check it is the SAME on every side of every box —
        // that is what keeps a box centred on its own position, and
        // therefore keeps the parent's packing correct.
        const tight = Math.min(left, right, top, bottom);
        const loose = Math.max(left, right, top, bottom);
        const key = 'pad ' + pad + ' + border ' + bw;
        const rec = insetByStyle.get(key) || { tight: Infinity, loose: -Infinity, boxes: 0 };
        rec.tight = Math.min(rec.tight, tight);
        rec.loose = Math.max(rec.loose, loose);
        rec.boxes++;
        insetByStyle.set(key, rec);

        if (Math.abs(tight - want) <= 0.5 && Math.abs(loose - want) <= 0.5) snugged++;
        if (tight >= want - 0.5) held++;

        const symErr = Math.max(Math.abs(left - right), Math.abs(top - bottom));
        worstSymErr = Math.max(worstSymErr, symErr);

        // (2) sibling boxes must be disjoint
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                siblingPairs++;
                const a = boxes.get(list[i].id()), b = boxes.get(list[j].id());
                if (overlapArea(a, b) > 0) overlaps++;
                const dx = Math.max(a.x1 - b.x2, b.x1 - a.x2);
                const dy = Math.max(a.y1 - b.y2, b.y1 - a.y2);
                worstGap = Math.min(worstGap, Math.max(dx, dy));
            }
        }
    }

    let lvls = 0;
    for (const n of g.nodes) {
        let d = 0, pid2 = n.data('parent'), guard = 0;
        while (pid2 && guard++ < 64) { d++; const p = cy.getElementById(pid2); if (!p || p.length === 0) break; pid2 = p.data('parent'); }
        lvls = Math.max(lvls, d + 1);
    }
    mostLevels = Math.max(mostLevels, lvls);

    // (2b) no two *symbols* anywhere may overlap — the actual complaint:
    //      stacked nodes are invisible nodes.
    const leaves = g.nodes.filter(function (n) { return (g.kids.get(n.id()) || []).length === 0; });
    let leafPairs = 0, leafOverlaps = 0;
    for (let i = 0; i < leaves.length; i++) {
        for (let j = i + 1; j < leaves.length; j++) {
            leafPairs++;
            const a = boxes.get(leaves[i].id()), b = boxes.get(leaves[j].id());
            if (overlapArea(a, b) > 0) leafOverlaps++;
            const dx = Math.max(a.x1 - b.x2, b.x1 - a.x2);
            const dy = Math.max(a.y1 - b.y2, b.y1 - a.y2);
            minLeafGap = Math.min(minLeafGap, Math.max(dx, dy));
        }
    }

    ok(overlaps === 0, tag + ': sibling boxes overlap', overlaps + '/' + siblingPairs + ' pairs');
    ok(leafOverlaps === 0, tag + ': symbols overlap each other', leafOverlaps + '/' + leafPairs + ' pairs');
    ok(held === containers, tag + ': children escaped their box', (containers - held) + '/' + containers);
    ok(snugged === containers, tag + ': box not snug (children + padding + border)', (containers - snugged) + '/' + containers);
    ok(worstSymErr <= 1.5, tag + ': children block off-centre in its box', 'worst ' + worstSymErr.toFixed(2) + 'u');
    return { containers: containers, pairs: siblingPairs, levels: lvls };
}

// ── Run ─────────────────────────────────────────────────────────────

registerHierarchyLayout(cytoscape);

const VP = { w: 1280, h: 760 };   // typical #graph-container size

function extentOf(cy) {
    const bb = cy.elements().boundingBox({ includeLabels: false, includeOverlays: false });
    return { w: bb.w, h: bb.h };
}

console.log('# cytoscape ' + cytoscape.version);
console.log('# snapshot: ' + snapshot.nodes.length + ' nodes / ' + snapshot.edges.length + ' edges');
console.log('# nodeSize=' + S.nodeSize + ' filePad=' + S.containerPadding + ' folderPad=' + S.folderPadding +
    ' gaps=' + [S.hierNodeGapX, S.hierNodeGapY, S.hierColGap, S.hierRowGap].join('/') +
    ' aspect=' + S.hierAspect + ' label=' + S.currentFontSize + 'px');

// ── 0. Sanity: headless cytoscape really does size the tree ──
{
    const cy = createCy('full');
    const sym = box(cy.$('node[_isSymbol]').first());
    const fil = box(cy.$('node[_isFileContainer]').first());
    const fol = box(cy.$('node[_isFolder]').first());
    console.log('\n## sizing probe');
    console.log('   symbol box ' + sym.w + ' x ' + sym.h + '   (expect ' + (S.nodeSize + 4) + ')');
    console.log('   file   box ' + fil.w + ' x ' + fil.h);
    console.log('   folder box ' + fol.w + ' x ' + fol.h);
    ok(Math.abs(sym.w - (S.nodeSize + 4)) < 0.01, 'symbol box = nodeSize + 2x border', sym.w);
    ok(fil.w > 0 && fil.h > 0, 'compound file box has a measured size');
    ok(fol.w > 0 && fol.h > 0, 'compound folder box has a measured size');
    cy.destroy();
}

// ── 1. full detail ──
console.log('\n## detail = full (folder -> file -> symbol)');
S.detail = 'full';
const cyFull = createCy('full');
const opts = buildLayoutOptions();
ok(opts.name === 'hierarchy', 'buildLayoutOptions() selects the tree engine', opts.name);
let stops = 0;
const lg = cyFull.layout(opts);
lg.one('layoutstop', function () { stops++; });
lg.run();
ok(stops === 1, 'layoutstop fired exactly once');
ok(!!S.hierarchyStats, 'S.hierarchyStats populated');
console.log('   stats ' + JSON.stringify(S.hierarchyStats));
const rFull = checkInvariants(cyFull, 'full');
const extFull = extentOf(cyFull);
console.log('   boxes checked ' + rFull.containers + '  sibling pairs ' + rFull.pairs + '  levels ' + rFull.levels);

// ── 2. determinism ──
{
    const cyB = createCy('full');
    hierarchyLayout(cyB, buildLayoutOptions());
    const a = positions(cyFull), b = positions(cyB);
    let same = a.size === b.size;
    if (same) for (const [k, v] of a) if (b.get(k) !== v) { same = false; break; }
    ok(same, 'two runs produce identical positions');
    cyB.destroy();
}

// ── 3. the same tree, the old way (real cose) ──
console.log('\n## same graph / cose (force-directed), for comparison');
applyPreset('cose defaults');
const cyCose = createCy('full');
const t0 = Date.now();
const coseLayout = cyCose.layout(buildLayoutOptions());
coseLayout.run();
console.log('   cose took ' + (Date.now() - t0) + 'ms');
const extCose = extentOf(cyCose);
const boxedCose = (function () {
    // how many children does cose leave outside their own box?
    const g = groups(cyCose);
    let bad = 0, pairs = 0, overlaps = 0, uncontained = 0;
    const bx = new Map();
    for (const n of g.nodes) bx.set(n.id(), box(n));
    for (const [pid, list] of g.kids) {
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                pairs++;
                if (overlapArea(bx.get(list[i].id()), bx.get(list[j].id())) > 0) overlaps++;
            }
        }
    }
    return { overlaps: overlaps, pairs: pairs, uncontained: uncontained };
})();
cyCose.destroy();

// ── 4. the other detail levels ──
S.engine = 'hierarchy';
for (const detail of ['files', 'flat']) {
    console.log('\n## detail = ' + detail);
    const cy = createCy(detail);
    const st = hierarchyLayout(cy, buildLayoutOptions());
    console.log('   stats ' + JSON.stringify(st));
    checkInvariants(cy, detail);
    const e = extentOf(cy);
    console.log('   extent ' + Math.round(e.w) + ' x ' + Math.round(e.h) + 'u');
    cy.destroy();
}

// ── 5. what all of that means at fit-to-view ──
console.log('\n## fit-to-view readability (' + VP.w + 'x' + VP.h + ' viewport; labels are DOM overlays at a fixed ' + S.currentFontSize + 'px)');
function report(name, ext) {
    const z = Math.min(VP.w / ext.w, VP.h / ext.h);
    const nodePx = S.nodeSize * z;
    console.log('   ' + name.padEnd(10) + 'extent ' + Math.round(ext.w) + ' x ' + Math.round(ext.h) + 'u' +
        '   zoom ' + z.toFixed(3) + '   node ' + nodePx.toFixed(1) + 'px' +
        '   label/node ' + (S.currentFontSize / nodePx).toFixed(2) + 'x');
    return { z: z, nodePx: nodePx };
}
const rh = report('hierarchy', extFull);
const rc = report('cose', extCose);
ok(rh.nodePx > rc.nodePx * 2, 'tree puts nodes at least 2x bigger than cose at fit',
    rh.nodePx.toFixed(1) + 'px vs ' + rc.nodePx.toFixed(1) + 'px');

console.log('\n## largest boxes in the tree');
{
    const g = groups(cyFull);
    const all = g.nodes.map(function (n) { return { n: n, b: box(n) }; })
        .sort(function (a, b) { return b.b.w * b.b.h - a.b.w * a.b.h; });
    for (const x of all.slice(0, 6)) {
        console.log('   ' + String(x.b.w.toFixed(0)).padStart(6) + ' x ' + String(x.b.h.toFixed(0)).padStart(5) +
            'u   ' + (x.n.data('_isFolder') ? 'folder ' : 'file   ') + x.n.data('label'));
    }
}

// ── 6. presets still route correctly ──
console.log('\n## presets');
for (const name of Object.keys(PRESETS)) {
    const okPreset = applyPreset(name) === true;
    const routed = (name.indexOf('tree') === 0) ? S.engine === 'hierarchy' : S.engine === 'cose';
    const gapOk = (name === 'tree (roomy)') ? S.hierRowGap === 120 : true;
    ok(okPreset && routed && gapOk, 'preset "' + name + '" applied and routed', S.engine + ' rowGap=' + S.hierRowGap);
}

// ── summary ──
console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED') +
    '   (' + checks + ' assertions)');
console.log('worst sibling gap ' + worstGap.toFixed(2) + 'u' +
    '   min symbol gap ' + minLeafGap.toFixed(2) + 'u' +
    '   worst box-inset error ' + worstInsetErr.toFixed(2) + 'u (vs pad+border)' +
    '   worst centring error ' + worstSymErr.toFixed(2) + 'u' +
    '   levels ' + mostLevels);
console.log('observed inset per box style (tight = nearest child to the edge, loose = furthest):');
for (const [k, v] of insetByStyle) {
    console.log('   ' + k + '  ->  tight ' + v.tight + 'u, loose ' + v.loose + 'u  over ' + v.boxes + ' boxes');
}
process.exit(failures === 0 ? 0 : 1);

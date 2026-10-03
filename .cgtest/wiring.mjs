// ── UI wiring test for the 'hierarchy' engine ────────────────────────
//
// The layout harness (validate.mjs) proves the *engine* is correct, but it
// cannot see the UI. `bindRange()` in controls.js returns silently when its
// element is missing, so a single mistyped id in index.html would turn a
// slider into a no-op with no error anywhere. And the wiring only runs for
// real in a browser, which is where it is most expensive to test.
//
// So: parse index.html for the ids it really declares, build a DOM shim
// from that, then run the REAL initControls() against a REAL headless
// cytoscape and drive every control the way a user would.
//
// Run: node --experimental-default-type=module .cgtest/wiring.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const cytoscape = require('./cytoscape.min.cjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', 'web', 'refactor');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');

let failures = 0, checks = 0;
function ok(cond, label, detail) {
    checks++;
    if (!cond) { failures++; console.log('   FAIL  ' + label + (detail !== undefined ? '  [' + detail + ']' : '')); }
    return cond;
}

// ── What index.html actually declares ───────────────────────────────

const declaredIds = new Set();
for (const m of html.matchAll(/\bid="([^"]+)"/g)) declaredIds.add(m[1]);

const presetButtons = [];
for (const m of html.matchAll(/data-preset="([^"]+)"/g)) presetButtons.push(m[1]);

const optionValues = {};
for (const m of html.matchAll(/<select id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    optionValues[m[1]] = Array.from(m[2].matchAll(/<option value="([^"]+)"/g)).map((o) => o[1]);
}

// Ranges the HTML declares, with their bounds.
const declaredRanges = new Map();
for (const m of html.matchAll(/<input[^>]*type="range"[^>]*>/g)) {
    const idm = /id="([^"]+)"/.exec(m[0]);
    if (!idm) continue;
    const attrs = {};
    for (const a of m[0].matchAll(/(min|max|step|value)="([^"]+)"/g)) attrs[a[1]] = parseFloat(a[2]);
    declaredRanges.set(idm[1], attrs);
}

console.log('# index.html declares ' + declaredIds.size + ' ids, ' +
    declaredRanges.size + ' range sliders, ' + presetButtons.length + ' preset buttons');
console.log('# selects: ' + Object.keys(optionValues).map((k) => k + '=' + optionValues[k].join('|')).join('  '));

// ── DOM shim ────────────────────────────────────────────────────────

const misses = [];

/// A stylesheet-like inline style object. The browser parses
/// `style.cssText = 'a:b;c:d'` into individual properties, and overlay.js
/// builds every label that way — so the shim has to do the same or every
/// label would look unpositioned. Plain `style.left = ...` assignments
/// (updatePositions) just land on the object.
function mkStyle() {
    const st = { _css: '' };
    Object.defineProperty(st, 'cssText', {
        get() { return st._css; },
        set(v) {
            st._css = String(v);
            const re = /([a-z-]+)\s*:\s*([^;]+)/gi;
            let m;
            while ((m = re.exec(st._css)) !== null) st[m[1]] = m[2].trim();
        },
    });
    return st;
}

class El {
    constructor(tag, id) {
        this.tagName = (tag || 'div').toUpperCase();
        this.id = id || '';
        this.value = '';
        this.checked = false;
        this.textContent = '';
        this.dataset = {};
        this.style = mkStyle();
        /// Real children, so the label overlay's spans can be inspected:
        /// overlay.js builds them with createElement + appendChild + innerHTML.
        this.children = [];
        this._html = '';
        this.classList = { add() {}, remove() {}, contains() { return false; }, toggle() {} };
        this._h = {};
    }
    /// Assigning innerHTML wipes the children (that is all overlay.js needs).
    set innerHTML(v) { this._html = v; this.children.length = 0; }
    get innerHTML() { return this._html; }
    addEventListener(type, fn) { (this._h[type] = this._h[type] || []).push(fn); }
    removeEventListener() {}
    appendChild(child) { this.children.push(child); return child; }
    /// Only the selectors the app actually uses: 'span' for the label overlay
    /// and '.clickable-edge' for the details panel.
    querySelectorAll(sel) {
        if (sel === 'span') return this.children.filter(function (c) { return c.tagName === 'SPAN'; });
        return [];
    }
    setAttribute() {}
    getAttribute() { return null; }
    /// Fire a listener list the way a browser would (so `this` is the element).
    fire(type) {
        const list = this._h[type] || [];
        for (const fn of list) fn.call(this, { type: type, target: this });
        return list.length;
    }
}

let lookups = 0;
const cache = new Map();
// Stable instances: controls.js binds listeners to whatever
// querySelectorAll() returns, so a second call must hand back the SAME
// elements or the listeners are unreachable.
const presetEls = presetButtons.map(function (p) {
    const e = new El('button', 'preset:' + p);
    e.dataset.preset = p;
    return e;
});
globalThis.document = {
    getElementById(id) {
        lookups++;
        if (!declaredIds.has(id)) { misses.push(id); return null; }
        if (!cache.has(id)) cache.set(id, new El(declaredRanges.has(id) ? 'input' : 'div', id));
        return cache.get(id);
    },
    querySelectorAll(sel) {
        return sel === '.preset-btn' ? presetEls : [];
    },
    createElement(tag) { return new El(tag); },
};
globalThis.requestAnimationFrame = function (fn) { return setTimeout(fn, 0); };

// ── Real cytoscape + real app modules ───────────────────────────────

const { S, PRESETS } = await import('../web/refactor/app/state.js');
const { buildElements } = await import('../web/refactor/app/builder.js');
const { buildLayoutOptions } = await import('../web/refactor/app/layout.js');
const { registerHierarchyLayout } = await import('../web/refactor/app/hierarchy.js');
const { initControls, updateMetrics } = await import('../web/refactor/app/controls.js');
const { BORDERS } = await import('../web/refactor/app/constants.js');

const snapshot = JSON.parse(readFileSync(path.join(root, 'graph.json'), 'utf8'));
S.snapshot = snapshot;
S.detail = 'full';

registerHierarchyLayout(cytoscape);
const built = buildElements();
S.cy = cytoscape({
    headless: true, styleEnabled: true, elements: [].concat(built.nodes, built.edges),
    style: [
        // Mirrors main.js's stylesheet, and sourced from the same BORDERS
        // constant the engine reads — if either side drifts, section 1b fails.
        { selector: 'node', style: { 'border-width': BORDERS.symbol } },
        { selector: 'node[_isSymbol]', style: { width: S.nodeSize, height: S.nodeSize } },
        { selector: 'node[_isFileContainer]', style: { 'border-width': BORDERS.file, padding: S.containerPadding } },
        { selector: 'node[_isFolder]', style: { 'border-width': BORDERS.folder, padding: S.folderPadding } },
        // Mirrors main.js's edge rule. Not decoration: focus.js re-colours the
        // focused node's edges by *direction* and takes that back with
        // removeStyle('line-color'), so the fallback this rule provides is
        // exactly what "the tag colour came back" means in section 13.
        { selector: 'edge', style: { 'line-color': 'data(color)', width: 'data(edgeWidth)' } },
    ],
});

let rebuilds = 0;
S.rebuild = function () { rebuilds++; };

const t0 = Date.now();
initControls();
console.log('# initControls() ran in ' + (Date.now() - t0) + 'ms');

// ── 1. every id the UI touches must exist in the HTML ───────────────
// `label-overlay` is created at runtime by overlay.js, so null is right.
const RUNTIME_CREATED = ['label-overlay'];
const badMisses = [...new Set(misses)].filter((id) => RUNTIME_CREATED.indexOf(id) < 0);
ok(badMisses.length === 0, 'no control references an id missing from index.html', JSON.stringify(badMisses));
ok(lookups > 0, 'the UI actually asked the document for elements', lookups + ' lookups');
console.log('   ' + lookups + ' getElementById lookups, ' + misses.length + ' of them missing from index.html');

// ── 1b. the engine's geometry model must match what cytoscape draws ───
// The tree engine predicts every box from these numbers instead of asking
// cytoscape to measure, so if the model and the stylesheet ever disagree the
// packing is silently wrong (that mismatch is what made the extent drift).
{
    const o = buildLayoutOptions();
    const styleNum = (sel, prop) => {
        const el = S.cy.nodes(sel)[0];
        return el ? parseFloat(el.style(prop)) : NaN;
    };
    ok(o.nodeSize === styleNum('[_isSymbol]', 'width'),
        'engine nodeSize matches the drawn symbol width', o.nodeSize + ' vs ' + styleNum('[_isSymbol]', 'width'));
    ok(o.symbolBorder === styleNum('[_isSymbol]', 'border-width'),
        'engine symbol border matches the stylesheet', o.symbolBorder + ' vs ' + styleNum('[_isSymbol]', 'border-width'));
    ok(o.filePad === styleNum('[_isFileContainer]', 'padding') && o.fileBorder === styleNum('[_isFileContainer]', 'border-width'),
        'engine file pad/border match the stylesheet',
        o.filePad + '/' + o.fileBorder + ' vs ' + styleNum('[_isFileContainer]', 'padding') + '/' + styleNum('[_isFileContainer]', 'border-width'));
    ok(o.folderPad === styleNum('[_isFolder]', 'padding') && o.folderBorder === styleNum('[_isFolder]', 'border-width'),
        'engine folder pad/border match the stylesheet',
        o.folderPad + '/' + o.folderBorder + ' vs ' + styleNum('[_isFolder]', 'padding') + '/' + styleNum('[_isFolder]', 'border-width'));

    // ...and main.js must not hand-roll those widths, or the two sides drift.
    const mainSrc = readFileSync(path.join(root, 'app', 'main.js'), 'utf8');
    const literals = Array.from(mainSrc.matchAll(/'border-width':\s*([0-9][0-9.]*)/g)).map((m) => m[1]);
    ok(literals.length === 0,
        'main.js takes every border width from constants.BORDERS', literals.join(', '));
    ok((mainSrc.match(/'border-width': BORDERS\./g) || []).length === 4,
        'main.js uses BORDERS for all four node border widths');
    ok(typeof BORDERS.symbol === 'number' && BORDERS.symbol > 0,
        'BORDERS is importable and non-empty', JSON.stringify(BORDERS));
}

// ── 2. sliders: declared, bound, and actually wired ─────────────────
for (const [id, attrs] of declaredRanges) {
    const outId = id.replace(/-range$/, '-val');
    ok(declaredIds.has(outId), 'slider ' + id + ' has its readout span #' + outId);
    const input = document.getElementById(id);
    ok(input && (input._h.input || []).length >= 1, 'slider ' + id + ' has an input handler bound');
    ok(String(input.value) !== '', 'slider ' + id + ' was seeded from state', input.value);
    if (attrs && isFinite(attrs.min) && isFinite(attrs.max)) {
        const v = parseFloat(input.value);
        ok(v >= attrs.min && v <= attrs.max, 'slider ' + id + ' default is inside its min/max',
            v + ' in [' + attrs.min + ',' + attrs.max + ']');
    }
}

// ── 3. every preset has a button, every button has a preset ─────────
for (const name of Object.keys(PRESETS)) {
    ok(presetButtons.indexOf(name) >= 0, 'preset "' + name + '" has a button');
}
for (const name of presetButtons) {
    ok(Object.prototype.hasOwnProperty.call(PRESETS, name), 'button data-preset="' + name + '" is a real preset');
}

// ── 4. the UI only offers regimes that keep the hierarchy ───────────
// The engine is the containment tree, full stop: the cose/grid/breadthfirst
// select and the force/overlap sliders that came with it are what used to
// scatter the boxes this view exists to keep together. Their absence is a
// check, not an accident — re-introducing one has to come here and say so.
const OBSOLETE = [
    'engine-select', 'auto-relayout', 'box-enabled',
    'repulsion-range', 'contratio-range', 'gravity-range', 'idealedge-range',
    'elasticity-range', 'nesting-range', 'componentspace-range',
    'nodeoverlap-range', 'numiter-range', 'boxpad-range', 'boxiter-range',
];
for (const id of OBSOLETE) {
    ok(!declaredIds.has(id), 'index.html no longer offers the obsolete control "' + id + '"');
}
ok(!('boxLayoutEnabled' in S) && !('autoRelayout' in S) && !('boxLayoutPad' in S) && !('boxLayoutIter' in S),
    'no trace of the box-overlap pass or auto-relayout left in state');
for (const d of ['full', 'files', 'flat']) {
    ok((optionValues['detail-select'] || []).indexOf(d) >= 0, 'detail-select offers "' + d + '"');
}
for (const name of Object.keys(PRESETS)) {
    ok(PRESETS[name].engine === 'hierarchy',
        'preset "' + name + '" keeps the tree engine', PRESETS[name].engine);
}
ok(S.engine === 'hierarchy', 'state starts on the tree engine', S.engine);

// ── 5. drive it like a user ─────────────────────────────────────────

/// Extent of the graph in model units, to prove a control did something.
function extent() {
    const bb = S.cy.elements().boundingBox({ includeLabels: false, includeOverlays: false });
    return Math.round(bb.w) + 'x' + Math.round(bb.h);
}

console.log('\n## moving every slider (engine = ' + S.engine + ')');
// main.js lays the graph out once after initControls(); do the same, or the
// baseline extent would be the un-laid-out pile of nodes at the origin.
document.getElementById('relayout-btn').fire('click');
const before = {
    nodeSize: S.nodeSize, extent: extent(),
    gaps: [S.hierNodeGapX, S.hierNodeGapY, S.hierColGap, S.hierRowGap, S.hierAspect].join('/'),
};
for (const [id, attrs] of declaredRanges) {
    const input = document.getElementById(id);
    input.value = String((attrs && isFinite(attrs.max)) ? attrs.max : parseFloat(input.value) + 1);
    ok(input.fire('input') >= 1, 'slider ' + id + ' reacts to input');
}
console.log('   nodeSize ' + before.nodeSize + ' -> ' + S.nodeSize);
console.log('   gaps ' + before.gaps + ' -> ' +
    [S.hierNodeGapX, S.hierNodeGapY, S.hierColGap, S.hierRowGap, S.hierAspect].join('/'));
console.log('   extent ' + before.extent + ' -> ' + extent());
ok(extent() !== before.extent, 'sliders changed the packed extent');
ok(!!S.hierarchyStats && S.hierarchyStats.levels > 0, 'HUD has tree stats to show', JSON.stringify(S.hierarchyStats));

// The tree layout is deterministic: re-running it with these (now extreme)
// slider values must reproduce the exact same extent. There is no engine
// select to leave and come back through any more, so this is the direct
// version of the same claim.
const packed = extent();

// the readouts must have followed the sliders
for (const id of declaredRanges.keys()) {
    const out = document.getElementById(id.replace(/-range$/, '-val'));
    ok(out && String(out.textContent) !== '', 'readout for ' + id + ' shows a number', out && out.textContent);
}

// The HUD must describe the tree when the tree engine is active.
updateMetrics();
const metrics = document.getElementById('metrics').innerHTML;
ok(metrics.indexOf('tree ') >= 0, 'HUD switches to the tree summary when the engine is hierarchy');
ok(/tree \d+ lvls/.test(metrics), 'HUD line matches "tree N lvls ..."', metrics.split('<br>')[2]);
console.log('   HUD: ' + metrics.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

// engine select — gone. The sidebar no longer offers a second engine, so the
// claim to hold is simply that the tree is what gets laid out, and that the
// one engine is reproducible.
ok(!!buildLayoutOptions(), 'layout options build for the tree engine');
ok(S.engine === 'hierarchy', 'the app lays out the containment tree', S.engine);
document.getElementById('relayout-btn').fire('click');
ok(extent() === packed, 're-running the tree layout reproduces the same extent (deterministic)',
    extent() + ' vs ' + packed);

// detail select
const detailSel = document.getElementById('detail-select');
for (const d of ['flat', 'files', 'full']) {
    detailSel.value = d;
    detailSel.fire('change');
    ok(S.detail === d, 'detail-select switched to ' + d);
}
ok(rebuilds === 3, 'a detail change triggers a full rebuild (the scene changes, not just geometry)', rebuilds);

// preset buttons
console.log('\n## clicking every preset button');
for (const name of presetButtons) {
    const btn = document.querySelectorAll('.preset-btn').filter((b) => b.dataset.preset === name)[0];
    const detailBefore = S.detail;
    btn.fire('click');
    ok(S.engine === PRESETS[name].engine && S.engine === 'hierarchy',
        'preset "' + name + '" set the engine', S.engine);
    if (PRESETS[name].detail && PRESETS[name].detail !== detailBefore) {
        ok(String(detailSel.value) === String(S.detail), 'detail-select followed preset "' + name + '"');
    }
    ok(buildLayoutOptions().name === S.engine, 'preset "' + name + '" left coherent layout options');
    updateMetrics();
    console.log('   ' + name.padEnd(20) + ' engine=' + S.engine.padEnd(12) + ' extent=' + extent());
}

// plain buttons
document.getElementById('relayout-btn').fire('click');
ok(!!S.hierarchyStats, 'relayout button re-ran the engine');
document.getElementById('reset-view-btn').fire('click');
document.getElementById('reset-params-btn').fire('click');
ok(S.hierNodeGapX === 24 && S.hierAspect === 1.7, 'reset-params restored the tree defaults',
    S.hierNodeGapX + '/' + S.hierAspect);
ok(String(document.getElementById('hier-nodegapx-range').value) === '24',
    'reset-params refreshed the slider position', document.getElementById('hier-nodegapx-range').value);

// ── 6. every remaining knob bites immediately ───────────────────────
// The tree engine is one deterministic sweep, so nothing in the sidebar may
// be debounced: a slider, a preset or the relayout button has to move the
// graph before the event returns, not 250ms later. (The old cose sliders
// waited on a timer; there is no timer left to wait on, which is why this
// section no longer sleeps.)
document.getElementById('reset-params-btn').fire('click');
document.getElementById('relayout-btn').fire('click');
ok(S.engine === 'hierarchy', 'reset left the tree engine in place', S.engine);

const gapBefore = extent();
const rowgap = document.getElementById('hier-rowgap-range');
rowgap.value = String(parseFloat(rowgap.value) * 2);
ok(rowgap.fire('input') >= 1, 'tree gap slider has a handler');
ok(extent() !== gapBefore, 'a tree-geometry slider re-packs synchronously (no debounce)',
    gapBefore + ' -> ' + extent());

const sizeBefore = extent();
const nodeSize = document.getElementById('node-size-range');
nodeSize.value = String(parseFloat(nodeSize.value) + 20);
nodeSize.fire('input');
ok(extent() !== sizeBefore, 'changing the symbol size re-packs the tree (boxes are predicted from it)',
    sizeBefore + ' -> ' + extent());

// ...and so must a preset: no engine switch, no wait.
const presetBefore = extent();
const roomy = presetEls.filter(function (b) { return b.dataset.preset === 'tree (roomy)'; })[0];
roomy.fire('click');
ok(S.engine === 'hierarchy', 'a preset keeps the tree engine', S.engine);
ok(extent() !== presetBefore, 'a preset re-packs synchronously (no debounce)',
    presetBefore + ' -> ' + extent());
// the label-mode checkbox path
const nl = document.getElementById('native-labels');
nl.checked = true;
nl.fire('change');
ok(S.nativeLabels === true, 'native-labels checkbox reached state');
nl.checked = false;
nl.fire('change');
ok(S.nativeLabels === false, 'native-labels checkbox toggles back');

// ── 7. the DOM labels are glued to the graph ────────────────────────
// Label spans live in screen space, so they only track the graph if
// *something* re-reads the viewport after every pan, zoom, drag and layout
// pass. Nothing did, which is why a label used to stay where it was born.
// overlay.js binds 'render position pan zoom viewport resize drag' and
// re-glues on the next frame, so a harness can drive that without a browser.
const { createLabelOverlays } = await import('../web/refactor/app/overlay.js');
S.nativeLabels = false;
S.labelOverlay = createLabelOverlays();
S.labelOverlay.render();

// Presets re-run the layout, and both main.js and layout.js fit the viewport on
// a 100 ms timer once a layout stops. Those fits only move the camera, but they
// would move it *during* the assertions below and look like a stale label, so
// let every queued timer land first.
const settle = function () { return new Promise(function (r) { setTimeout(r, 150); }); };
await settle();

const graphEl = document.getElementById('graph-container');
const overlayEl = graphEl.children.filter(function (c) { return c.id === 'label-overlay'; })[0];
ok(!!overlayEl, 'the label overlay div is appended to #graph-container');
const spans = overlayEl ? overlayEl.querySelectorAll('span') : [];
const visibleNodes = S.cy.nodes().filter(function (n) { return n.style('display') !== 'none'; });
// A symbol's label is its `label`; a box's is the basename of its `_filePath`.
// The root box has neither (it is the whole graph), so it gets no span.
const labelledIds = visibleNodes.filter(function (n) {
    return n.data('_isContainer')
        ? String(n.data('_filePath') || '').replace(/^.*[/\\]/, '') !== ''
        : !!n.data('label');
}).map(function (n) { return n.id(); });
ok(spans.length > 0, 'the overlay has a span per labelled node', spans.length);
ok(spans.length === labelledIds.length,
    '...exactly one per visible node that has a label (the unlabelled root box gets none)',
    spans.length + ' spans / ' + labelledIds.length + ' labelled nodes');

// Track a *symbol*: its label is placed from its own rendered position on both
// the build path (cssText) and the sync path, so this exercises the exact
// arithmetic the user sees while dragging one around.
const symbolIds = visibleNodes.filter(function (n) { return !n.data('_isContainer'); })
    .map(function (n) { return n.id(); });
const spanA = spans.filter(function (s) { return symbolIds.indexOf(s.dataset.nodeId) >= 0; })[0];
const nodeA = spanA ? S.cy.getElementById(spanA.dataset.nodeId) : null;
ok(!!nodeA && nodeA.length > 0, 'a label knows which symbol node it belongs to', spanA && spanA.dataset.nodeId);
const leftA = spanA ? spanA.style.left : null;
ok(/^-?[0-9.]+px$/.test(String(leftA)), 'the span is positioned in px by build() (the shim parses cssText)', leftA);

// Drop the symbol somewhere unmistakable at an identity camera, so the label's
// numbers are reproducible: renderedPosition() === model position at zoom 1.
S.cy.pan({ x: 0, y: 0 });
S.cy.zoom(1);
nodeA.position({ x: 1234, y: 567 });
await settle();   // let the overlay's rAF (and any late fit) land
// A symbol label sits 6px below the node centre: top = y + 6.
ok(spanA.style.left === '1234px' && spanA.style.top === '573px',
    'moving a node re-glues its label (this is what a drag looks like)',
    leftA + ' -> ' + spanA.style.left + '/' + spanA.style.top);

const afterMove = spanA.style.left;
S.cy.pan({ x: 130, y: 70 });
S.cy.zoom(1.6);
await settle();
// 1234 * 1.6 + 130 = 2104.4 and (567 * 1.6 + 70) + 6 = 983.2
ok(spanA.style.left === '2104.4px' && spanA.style.top === '983.2px',
    'moving the camera re-glues the label (pan/zoom, no stale offset)',
    afterMove + ' -> ' + spanA.style.left + '/' + spanA.style.top +
    '  rp=' + JSON.stringify(nodeA.renderedPosition()));
ok(Number(spanA.style.opacity) >= 0 && Number(spanA.style.opacity) <= 1,
    'the label carries the node opacity, so a dimmed node reads dimmed', spanA.style.opacity);

// A collapsed box must not leave its children's labels floating over it:
// cytoscape keeps a child's own display at `element` when a parent is hidden,
// so the visibility pass sets it explicitly and the overlay then hides that
// child's span. (toggleContainer is imported here and reused in section 9.)
const { toggleContainer } = await import('../web/refactor/app/visibility.js');
const boxA = nodeA.parent();
ok(!!boxA && boxA.length > 0 && boxA.data('_isContainer'), 'the tracked symbol lives in a box', boxA && boxA.id());
toggleContainer(boxA);
ok(nodeA.style('display') === 'none', 'collapsing the box hides the symbol itself', nodeA.style('display'));
ok(spanA.style.display === 'none', '...and its label leaves the screen with it', spanA.style.display);
toggleContainer(boxA);
ok(nodeA.style.display !== 'none' && spanA.style.display !== 'none',
    'expanding the box brings the symbol and its label back', nodeA.style.display + '/' + spanA.style.display);
ok(S.cy.edges('[_agg]').length === 0, 'expanding drops the aggregate edges again', S.cy.edges('[_agg]').length);
S.cy.pan({ x: 0, y: 0 });
S.cy.zoom(1);

// ── 8. focus lights the connected part and dims the rest ────────────
// Focus answers "what is connected to this node", built from the edges — not
// from a depth heuristic. So the node, its neighbours and the one box each of
// them lives in stay lit; everything else drops to DIM.
const { focusNode, unfocusAll } = await import('../web/refactor/app/focus.js');

const symbolsNow = S.cy.nodes('[!_isContainer]').filter(function (n) { return n.style('display') !== 'none'; });
function neighbourIds(node) {
    const out = new Set();
    node.connectedEdges().forEach(function (e) {
        const o = e.source().id() === node.id() ? e.target() : e.source();
        out.add(o.id());
    });
    return out;
}
const op = function (id) { return Number(S.cy.getElementById(id).style('opacity')); };
/// What cytoscape actually paints a node with: its own opacity times every
/// ancestor's (effectiveOpacity). This is the strength the *circle* is drawn
/// at, and it is what silently drifted away from the DOM label.
const effOp = function (id) { return Number(S.cy.getElementById(id).effectiveOpacity()); };
/// How strongly a *box* is painted. A box must never be dimmed through
/// `opacity`: cytoscape multiplies a parent's opacity into every descendant, so
/// dimming a folder that way took the lit symbols inside it down with it. Boxes
/// carry the dim in their own drawing alphas instead (DIM_BOX_PROPS, focus.js).
const boxAlpha = function (id) {
    const n = S.cy.getElementById(id);
    return Math.max(Number(n.style('background-opacity')), Number(n.style('border-opacity')),
        Number(n.style('text-opacity')));
};
/// The DOM label §7's overlay built for a node.
const spanOf = function (id) {
    return spans.filter(function (s) { return s.dataset.nodeId === id; })[0];
};

let cast = null;
for (const a of symbolsNow) {
    const near = neighbourIds(a);
    if (near.size === 0) continue;
    const stranger = symbolsNow.filter(function (n) {
        return n.id() !== a.id() && !near.has(n.id()) &&
            n.parent().id() !== a.parent().id() && !near.has(n.parent().id());
    })[0];
    if (stranger) { cast = { a: a, stranger: stranger }; break; }
}
ok(!!cast, 'the snapshot has a connected symbol and an unrelated one to focus between');
if (cast) {
    const parentA = cast.a.parent().id();
    focusNode(cast.a.id());
    ok(S.focusedNodeId === cast.a.id(), 'focusNode recorded the focused id', S.focusedNodeId);
    ok(op(cast.a.id()) === 1, 'the focused symbol is lit', op(cast.a.id()));
    ok(effOp(cast.a.id()) === 1, '...and drawn at full strength (no dimmed ancestor above it)',
        effOp(cast.a.id()));
    ok(boxAlpha(parentA) > 0.5, 'the box the focused symbol lives in keeps its full paint', boxAlpha(parentA));
    ok(op(cast.stranger.id()) < 0.1, 'an unconnected symbol is dimmed hard', op(cast.stranger.id()));
    ok(boxAlpha(cast.stranger.parent().id()) < 0.1,
        '...and so is its box, through its own alphas (never opacity)',
        boxAlpha(cast.stranger.parent().id()));
    ok(String(cast.a.style('border-color')).indexOf('224') >= 0,
        'the focused node is ringed in the highlight colour', cast.a.style('border-color'));

    // The "lowest container only" rule: the folder above a lit file stays dim,
    // because the user asked for "the file or folder they are contained in",
    // not for the whole branch.
    const grand = S.cy.getElementById(parentA).parent();
    if (grand && grand.length > 0) {
        ok(boxAlpha(grand.id()) < 0.1, 'the folder above a lit file is not lit itself', boxAlpha(grand.id()));
        // The bug this guards: dimming that folder through `opacity` also
        // dimmed the lit symbol inside it (cytoscape multiplies a parent's
        // opacity into every descendant), so the circle faded while the label
        // overlay — which reads the node's own opacity — stayed bright.
        ok(effOp(cast.a.id()) === 1, '...but it cannot drag the lit symbol inside it down with it',
            effOp(cast.a.id()));
        const litSpan = spanOf(cast.a.id());
        ok(!!litSpan && Number(litSpan.style.opacity) === 1, '...and the symbol\'s label agrees with its circle',
            litSpan && litSpan.style.opacity);
    }

    // Re-focusing (a collapse re-runs focus) must not compound the
    // multiplication: the reset at the top of focusNode is what makes the pass
    // idempotent, and the harness's mirror stylesheet leaves every base alpha
    // at cytoscape's default of 1, so the dimmed value is exactly DIM.
    focusNode(cast.a.id());
    focusNode(cast.a.id());
    ok(boxAlpha(cast.stranger.parent().id()) === 0.06,
        'focusing twice dims a box to DIM, not DIM squared', boxAlpha(cast.stranger.parent().id()));

    console.log('   focus ' + cast.a.id() + '  eff=' + effOp(cast.a.id()) +
        '  stranger ' + cast.stranger.id() + ' op=' + op(cast.stranger.id()) +
        '  its box alpha=' + boxAlpha(cast.stranger.parent().id()) +
        '  box above the lit one alpha=' + (grand && grand.length > 0 ? boxAlpha(grand.id()) : 'n/a'));

    // Edges: incident = fully lit, between two lit nodes = secondary, the rest
    // ghosted. Derived from the edges, so no depth heuristic can leak in.
    const lit = new Set([cast.a.id()]);
    neighbourIds(cast.a).forEach(function (id) { lit.add(id); });
    lit.forEach(function (id) {
        const n = S.cy.getElementById(id);
        if (n && n.length > 0 && !n.data('_isContainer') && n.parent().length > 0) lit.add(n.parent().id());
    });
    let incidentEdge = null, betweenEdge = null, unrelatedEdge = null;
    S.cy.edges().forEach(function (e) {
        const s = e.source().id(), t = e.target().id();
        if (s === cast.a.id() || t === cast.a.id()) { if (!incidentEdge) incidentEdge = e; return; }
        if (lit.has(s) && lit.has(t)) { if (!betweenEdge) betweenEdge = e; }
        else if (!lit.has(s) && !lit.has(t)) { if (!unrelatedEdge) unrelatedEdge = e; }
    });
    ok(!!incidentEdge && Number(incidentEdge.style('opacity')) === 1,
        'an edge onto the focused node stays fully lit', incidentEdge && incidentEdge.style('opacity'));
    if (betweenEdge) {
        ok(Number(betweenEdge.style('opacity')) > 0.1,
            'an edge between two connected nodes is visible but secondary', betweenEdge.style('opacity'));
    }
    if (unrelatedEdge) {
        ok(Number(unrelatedEdge.style('opacity')) < 0.1, 'an edge between two strangers is ghosted',
            unrelatedEdge.style('opacity'));
    }
    ok(S.cy.edges().filter(function (e) { return Number(e.style('opacity')) < 0.1; }).length > 0,
        'focus ghosted some edges (the dim pass really ran)');
    ok(String(document.getElementById('focus-label').textContent).length > 0,
        'the focus indicator names the focused node', document.getElementById('focus-label').textContent);

    unfocusAll();
    ok(S.focusedNodeId === null, 'unfocus cleared the focused id');
    ok(op(cast.stranger.id()) === 1, 'unfocus restores full opacity on the strangers', op(cast.stranger.id()));
    ok(boxAlpha(cast.stranger.parent().id()) > 0.5, 'unfocus restores the boxes\' paint too',
        boxAlpha(cast.stranger.parent().id()));
    ok(S.cy.nodes().filter(function (n) { return n.data('_isContainer') && boxAlpha(n.id()) <= 0.5; }).length === 0,
        'no box is left dimmed after unfocus');
    ok(String(cast.a.style('border-color')).indexOf('224') < 0,
        'unfocus removes the highlight ring', cast.a.style('border-color'));
}

// ── 9. collapsing a box keeps its edges (as aggregates) ─────────────
// The complaint was that collapsing a file lost the arrows into it. Every
// edge whose endpoint gets hidden is re-projected onto the outermost visible
// ancestor of that endpoint, so the arrows survive the collapse.
// (toggleContainer was imported in section 7 — the label overlay calls it too.)
ok(S.cy.edges('[_agg]').length === 0, 'no aggregate edges while everything is expanded');

/// Pick a *file* box that sits in a folder and that owns a symbol with an edge
/// leaving the folder. Both collapse cases need that edge: collapsing the file
/// must re-project it onto the file, and collapsing the folder must then
/// re-project it onto the folder — while the hidden file inside never becomes
/// an endpoint.
function findCollapsibleBox() {
    const boxes = S.cy.nodes('[_collapsible]').filter(function (n) { return n.style('display') !== 'none'; });
    for (const box of boxes) {
        const outer = box.parent();
        if (!outer || outer.length === 0 || !outer.data('_collapsible')) continue;
        const inside = new Set(box.descendants().map(function (n) { return n.id(); }));
        inside.add(box.id());
        const inFolder = new Set(outer.descendants().map(function (n) { return n.id(); }));
        inFolder.add(outer.id());
        const kids = box.descendants().filter(function (n) { return !n.data('_isContainer'); });
        for (const kid of kids) {
            const outs = kid.connectedEdges().filter(function (e) {
                const o = e.source().id() === kid.id() ? e.target() : e.source();
                return !inside.has(o.id()) && !inFolder.has(o.id());
            });
            if (outs.length > 0) {
                const e = outs[0];
                const o = e.source().id() === kid.id() ? e.target() : e.source();
                return { box: box, outer: outer, kid: kid, edge: e, far: o };
            }
        }
    }
    return null;
}
const cc = findCollapsibleBox();
ok(!!cc, 'the snapshot has a file box in a folder with an edge leaving that folder');

if (cc) {
    const boxId = cc.box.id();
    const farId = cc.far.id();
    toggleContainer(cc.box);
    ok(cc.box.data('_collapsed') === true, 'the box is collapsed');
    ok(cc.kid.style('display') === 'none', 'its symbols are hidden by the visibility pass');

    const aggs = S.cy.edges('[_agg]');
    ok(aggs.length > 0, 'collapsing re-projected the swallowed edges instead of dropping them', aggs.length);
    const onto = aggs.filter(function (e) {
        return e.source().id() === boxId || e.target().id() === boxId;
    });
    ok(onto.length > 0, 'an aggregate edge lands on the collapsed box',
        'agg=' + aggs.length + ' [' + aggs.map(function (e) {
            return e.source().id() + '->' + e.target().id();
        }).slice(0, 6).join(', ') + '] box=' + boxId + ' kid=' + cc.kid.id() +
        ' parent=' + cc.kid.parent().id() + ' far=' + farId);
    const exact = onto.filter(function (e) {
        const o = e.source().id() === boxId ? e.target() : e.source();
        return o.id() === farId;
    });
    ok(exact.length === 1, 'the aggregate joins the box to the far end of the swallowed edge', exact.length);
    if (exact.length === 1) {
        ok(Number(exact[0].data('weight')) >= 1, 'the aggregate carries the summed weight', exact[0].data('weight'));
        ok(exact[0].data('_agg') === true, 'the aggregate is flagged [_agg] so the stylesheet can dash it');
        ok(String(exact[0].data('id')).indexOf('agg:') === 0, 'the aggregate id cannot collide with a real edge',
            exact[0].data('id'));
    }

    // Collapsing the *parent* of that box must hand the edge to the folder:
    // the representative is the outermost visible ancestor, so a hidden file
    // inside a hidden folder is never used as an endpoint.
    toggleContainer(cc.outer);
    const outerId = cc.outer.id();
    ok(cc.outer.data('_collapsed') === true, 'the folder above that box is collapsed');
    ok(cc.box.style('display') === 'none', 'the file box inside it goes off screen too', cc.box.style('display'));
    const onOuter = S.cy.edges('[_agg]').filter(function (e) {
        return e.source().id() === outerId || e.target().id() === outerId;
    });
    ok(onOuter.length > 0, 'an aggregate edge lands on the collapsed folder instead',
        'agg=' + S.cy.edges('[_agg]').length + ' [' + S.cy.edges('[_agg]').map(function (e) {
            return e.source().id() + '->' + e.target().id();
        }).slice(0, 6).join(', ') + '] outer=' + outerId + ' box=' + boxId + ' far=' + farId);
    const ontoHiddenFile = onOuter.filter(function (e) {
        const o = e.source().id() === outerId ? e.target() : e.source();
        return o.id() === boxId;
    });
    ok(ontoHiddenFile.length === 0, 'the hidden file inside it is not used as an endpoint', ontoHiddenFile.length);
    toggleContainer(cc.outer);
    ok(cc.outer.data('_collapsed') === false, 'the folder expands again');

    toggleContainer(cc.box);
    ok(cc.box.data('_collapsed') === false, 'the box expands again');
    ok(cc.kid.style('display') !== 'none', 'the symbols come back', cc.kid.style('display'));
    ok(S.cy.edges('[_agg]').length === 0, 'expanding drops every aggregate edge', S.cy.edges('[_agg]').length);
}

// ── 10. a search must keep the circles, not only the names ──────────
// cytoscape will not draw a node whose *ancestor* is hidden: `visible()` walks
// the parents even though the child's own `display` stays `element`. So a box
// that hid itself because *its* path missed the query also erased the circles
// of the matched symbols inside it — and since the label overlay only looks at
// the node's own display, the user was left with names floating over nothing.
// A box therefore stays whenever anything inside it is still on screen.
// (main.js owns #search's input handler; this harness drives the pass itself.)
const { refreshVisibility } = await import('../web/refactor/app/visibility.js');
const searchEl = document.getElementById('search');
const boxOf = function (n) { return n.parent().length > 0 ? n.parent() : null; };
/// Would cytoscape draw it? True only when the node and every box above it is
/// on screen — the same walk `ele.visible()` does.
const drawn = function (n) {
    if (n.style('display') === 'none') return false;
    let p = n.parent();
    let guard = 0;
    while (p && p.length > 0 && guard++ < 64) {
        if (p.style('display') === 'none') return false;
        p = p.parent();
    }
    return true;
};
const shownCount = function () { return S.cy.nodes().filter(function (n) { return drawn(n); }).length; };

const beforeSearch = shownCount();
// The most distinctive name available: the longest label on a symbol that sits
// two boxes deep, so the ancestor chain the search must keep is nested.
const candidate = S.cy.nodes('[!_isContainer]').filter(function (n) {
    return drawn(n) && !!boxOf(n) && boxOf(n).parent().length > 0 && String(n.data('label') || '').length > 4;
}).map(function (n) { return n; })
    .sort(function (a, b) { return String(b.data('label')).length - String(a.data('label')).length; })[0];
ok(!!candidate, 'the snapshot has a nested symbol to search for', candidate && candidate.id());

if (candidate) {
    const outerBox = boxOf(candidate).parent();
    searchEl.value = String(candidate.data('label')).toLowerCase();
    searchEl.fire('input');   // nothing is bound here — see the note above
    refreshVisibility();

    ok(candidate.style('display') === 'element', 'the symbol whose name matches stays on screen',
        candidate.style('display'));
    ok(drawn(candidate), '...with every box above it kept visible, so its circle is drawn',
        'box ' + boxOf(candidate).id() + '=' + boxOf(candidate).style('display') +
        ' outer=' + outerBox.id() + '=' + outerBox.style('display'));
    ok(candidate.visible() === true, 'cytoscape itself agrees the matched node is drawable');
    ok(effOp(candidate.id()) === 1, 'a search does not dim what it found', effOp(candidate.id()));
    const matchSpan = spanOf(candidate.id());
    ok(!!matchSpan && matchSpan.style.display !== 'none', '...and the label overlay still paints its name',
        matchSpan && matchSpan.style.display);
    ok(shownCount() < beforeSearch, 'the search really did filter the graph',
        shownCount() + ' of ' + beforeSearch + ' nodes left');
    const hiddenSym = S.cy.nodes('[!_isContainer]').filter(function (n) { return !drawn(n); })
        .map(function (n) { return n; })[0];
    ok(!!hiddenSym, 'symbols that do not match are off screen');
    if (hiddenSym) {
        const hs = spanOf(hiddenSym.id());
        ok(!hs || hs.style.display === 'none', 'a filtered-out symbol takes its label with it',
            hs && hs.style.display);
    }

    const boxPath = String(boxOf(candidate).data('_filePath') || '').toLowerCase();
    console.log('   search "' + searchEl.value + '"  ' + shownCount() + '/' + beforeSearch +
        ' nodes still drawn  ' + boxOf(candidate).id() + ' kept by ' +
        (boxPath.indexOf(String(searchEl.value)) >= 0 ? 'its own path' : 'the match inside it'));

    // A box matching the query by its own path is still shown for its own sake
    // — that rule was already there and must not have been lost.
    const byPath = S.cy.nodes('[_isContainer]').filter(function (n) {
        return drawn(n) && String(n.data('_filePath') || '').split(/[/\\]/).length > 2;
    }).map(function (n) { return n; })[0];
    if (byPath) {
        const segs = String(byPath.data('_filePath')).split(/[/\\]/);
        searchEl.value = String(segs[segs.length - 1]).toLowerCase();
        refreshVisibility();
        ok(byPath.style('display') === 'element', 'a box whose own path matches the query stays visible',
            byPath.id() + ' via "' + searchEl.value + '"');
    }

    searchEl.value = '';
    refreshVisibility();
    ok(shownCount() === beforeSearch, 'clearing the search brings the whole graph back',
        shownCount() + ' vs ' + beforeSearch);
    ok(S.cy.edges('[_agg]').length === 0, 'searching never invented aggregate edges',
        S.cy.edges('[_agg]').length);
}

// ── 11. the extracted metadata is back: lines, signatures, docs ─────
// The extractor has always emitted a span, a signature and (often) a doc
// comment per definition, and the original single-file view showed them. The
// refactor dropped all three on the floor — builder.js kept the label and the
// doc string and nothing else. These checks hold the whole round trip
// (snapshot -> element data -> label -> tooltip -> details panel) against the
// raw JSON, so a field silently dropped again fails here instead of only
// being noticed in a browser.
const { nodeId, addressOf, esc } = await import('../web/refactor/app/utils.js');
const { showDetails } = await import('../web/refactor/app/details.js');

/// A property the app just rendered. The overlay rebuilds its spans, so a
/// span captured earlier in the file may already be detached.
const overlayOf = function (id) {
    const ov = graphEl.children.filter(function (c) { return c.id === 'label-overlay'; })[0];
    const all = ov ? ov.querySelectorAll('span') : [];
    return all.filter(function (s) { return s.dataset.nodeId === id; })[0];
};
const panelHtml = function () { return String(document.getElementById('node-details').innerHTML); };

const rawById = new Map();
for (const n of snapshot.nodes) {
    // First occurrence wins, exactly like builder.js (`if (added.has(id))
    // continue`): a name can be declared twice (a field and a method), and the
    // scene keeps the first one, so the raw lookup has to agree or the span
    // comparison compares two different declarations.
    if (n.key && n.key.key === 'symbol' && !rawById.has(nodeId(n.key))) rawById.set(nodeId(n.key), n);
}
const symbolsInScene = S.cy.nodes('[!_isContainer]');

// Every symbol in the scene knows its line, and its line is the span's row
// turned into the number an editor shows.
const noLine = symbolsInScene.filter(function (n) { return !n.data('line') || !n.data('labelLine'); });
ok(noLine.length === 0, 'every symbol carries a 1-based line and a label with it',
    noLine.length + ' without  ' + noLine.map(function (n) { return n.id(); }).slice(0, 2).join(' '));
const mismatched = symbolsInScene.filter(function (n) {
    const raw = rawById.get(n.id());
    return !raw || raw.span.start.row + 1 !== n.data('line') || raw.span.start.col !== n.data('col');
});
ok(mismatched.length === 0, '...and it is the snapshot\'s own span (row + 1, same column)',
    mismatched.length + ' mismatched  ' + mismatched.map(function (n) { return n.id(); }).slice(0, 2).join(' '));

const sample = rawById.size ? symbolsInScene.filter(function (n) { return rawById.has(n.id()) && !!n.data('signature'); })[0] : null;
ok(!!sample, 'a symbol carries the signature the extractor built', sample && sample.data('signature'));
if (sample) {
    const raw = rawById.get(sample.id());
    ok(sample.data('signature') === raw.attrs.signature, '...verbatim from `attrs.signature`', sample.data('signature'));
    ok(sample.data('visibility') === (raw.attrs.visibility || null), '...with its visibility', sample.data('visibility'));
    ok(sample.data('astKind') === (raw.ast_kind || null), '...and the syntax node it came from', sample.data('astKind'));
    ok(sample.data('labelLine') === sample.data('label') + ':' + sample.data('line'),
        'the label and its line number are both on the node (native labels pick between them)',
        sample.data('labelLine'));
}

// A box answers "which lines am I?" — its range has to cover everything
// inside it, or the range is worse than useless.
const badBox = S.cy.nodes('[_isContainer]').filter(function (b) {
    const kids = b.descendants().filter(function (k) { return !k.data('_isContainer') && k.data('line'); });
    if (kids.length === 0) return false;
    const lo = Math.min.apply(null, kids.map(function (k) { return k.data('line'); }));
    const hi = Math.max.apply(null, kids.map(function (k) { return k.data('endLine') || k.data('line'); }));
    return !(b.data('line') <= lo && b.data('endLine') >= hi);
});
ok(badBox.length === 0, 'every box\'s line range covers the symbols inside it',
    badBox.length + ' bad  ' + badBox.map(function (b) { return b.id(); }).slice(0, 2).join(' '));

// The DOM label: name plus `:line`, and the number in its own span so it can
// be set smaller and dimmer than the name.
ok(S.showLineNumbers === true, 'line numbers are on by default (the information is the point)',
    S.showLineNumbers);
const linesChk = document.getElementById('show-lines');
ok(!!linesChk, 'index.html declares the line-number checkbox');
if (linesChk) {
    linesChk.checked = true;
    linesChk.fire('change');
    ok(S.showLineNumbers === true, 'the line-number checkbox reached state', S.showLineNumbers);
    linesChk.checked = false;
    linesChk.fire('change');
    ok(S.showLineNumbers === false, '...and toggles back', S.showLineNumbers);
    linesChk.checked = true;
    linesChk.fire('change');
    S.showLineNumbers = true;
    S.labelOverlay.render();
    await settle();
}
if (sample) {
    const onSpan = overlayOf(sample.id());
    ok(!!onSpan && onSpan.innerHTML.indexOf(':' + sample.data('line')) > 0,
        'the label shows the line number when the toggle is on', onSpan && onSpan.innerHTML);
    ok(!!onSpan && /class="ln"/.test(onSpan.innerHTML),
        '...in its own span, so the number can read as an index beside the name', onSpan && onSpan.innerHTML);
    ok(!!onSpan && String(onSpan.title).indexOf(sample.data('signature')) >= 0,
        'hovering the label names the signature (no click needed)', onSpan && String(onSpan.title).split('\n')[1]);
    ok(!!onSpan && String(onSpan.title).indexOf(':' + sample.data('line')) >= 0,
        '...and the address with its line', onSpan && String(onSpan.title));

    S.showLineNumbers = false;
    S.labelOverlay.render();
    await settle();
    const offSpan = overlayOf(sample.id());
    ok(!!offSpan && offSpan.innerHTML === sample.data('label'),
        'turning line numbers off leaves exactly the name', offSpan && offSpan.innerHTML);
    S.showLineNumbers = true;
    S.labelOverlay.render();
    await settle();

    // The native-label path has to make the same choice — it picks between two
    // data fields instead of rebuilding a span (controls.js).
    const nlBox = document.getElementById('native-labels');
    nlBox.checked = true;
    nlBox.fire('change');
    ok(String(sample.style('label')) === sample.data('labelLine'),
        'native labels draw the name with its line too', sample.style('label'));
    linesChk.checked = false;
    linesChk.fire('change');
    ok(String(sample.style('label')) === sample.data('label'),
        '...and drop the line with the same toggle', sample.style('label'));
    linesChk.checked = true;
    linesChk.fire('change');
    nlBox.checked = false;
    nlBox.fire('change');

    // A box's label stays a name: its `line` is where its contents begin, and
    // the range belongs in the tooltip, not in the title over the box.
    const anyBox = S.cy.nodes('[_isFileContainer]').filter(function (b) { return !!b.data('label'); })[0];
    if (anyBox) {
        const boxSpan = overlayOf(anyBox.id());
        ok(!!boxSpan && boxSpan.innerHTML.indexOf('class="ln"') < 0,
            'a box label stays a bare name even with line numbers on', boxSpan && boxSpan.innerHTML);
        ok(!!boxSpan && /:\d+/.test(String(boxSpan.title)),
            '...while its tooltip carries the range it covers', boxSpan && String(boxSpan.title).split('\n')[1]);
    }
}
// ── 12. the details panel shows what was recovered ──────────────────
// Same metadata as §11, but where a reader actually meets it: the panel is the
// only surface with room for a signature, an address, a doc comment and the
// members of a definition all at once.

// A definition whose *members* are on the graph: struct fields, enum variants,
// the methods an impl block defines. Those are the "class arguments".
const withMembers = symbolsInScene.filter(function (n) {
    return n.connectedEdges().filter(function (e) {
        const k = e.data('kind');
        return (k === 'contains' || k === 'defines') && e.source().id() === n.id() && e.target().id() !== n.id();
    }).length > 0;
})[0];
ok(!!withMembers, 'the snapshot has a definition with members to list', withMembers && withMembers.id());

if (sample) {
    showDetails(sample.data());
    const html = panelHtml();
    ok(html.indexOf(esc(sample.data('signature'))) >= 0,
        'the panel prints the signature', sample.data('signature'));
    ok(html.indexOf(addressOf(sample.data())) >= 0,
        '...and the address with its line', addressOf(sample.data()));
    ok(/lines? \d+/.test(html), '...and the line range it spans');
    if (sample.data('visibility') && sample.data('visibility') !== 'private') {
        ok(html.indexOf('visibility: ' + sample.data('visibility')) >= 0,
            '...and the visibility, when it is not private', sample.data('visibility'));
    }
    if (sample.data('astKind')) {
        ok(html.indexOf('ast: ' + sample.data('astKind')) >= 0,
            '...and the syntax node it was parsed as', sample.data('astKind'));
    }
}

// A documented node shows its doc; an undocumented one does not grow an empty
// pair of quotes.
const docNode = symbolsInScene.filter(function (n) { return !!n.data('doc'); })[0];
if (docNode) {
    showDetails(docNode.data());
    ok(panelHtml().indexOf(esc(docNode.data('doc'))) >= 0,
        'a documented node shows its doc comment', docNode.data('doc').slice(0, 40));
}
const undoc = symbolsInScene.filter(function (n) { return !n.data('doc'); })[0];
if (undoc) {
    showDetails(undoc.data());
    ok(panelHtml().indexOf('node-doc') < 0, 'an undocumented node shows no doc block', undoc.id());
}

if (withMembers) {
    showDetails(withMembers.data());
    const html = panelHtml();
    // Same filter the panel uses: the `contains`/`defines` edges that *leave*
    // the definition (a struct's fields, an impl block's methods).
    const members = withMembers.connectedEdges().filter(function (e) {
        const k = e.data('kind');
        return (k === 'contains' || k === 'defines') &&
            e.source().id() === withMembers.id() && e.source().id() !== e.target().id();
    }).map(function (e) { return e.target(); })
        // The panel sorts members by line and lists the earliest 40, so the one
        // to check is the first declared, not whatever the edge list put first.
        .sort(function (a, b) { return (a.data('line') || 0) - (b.data('line') || 0); });
    ok(html.indexOf('Members (' + members.length + ')') >= 0,
        'the panel lists the members of a definition (fields, variants, impl methods)',
        withMembers.id() + ' -> ' + members.length);
    const member = members[0];
    if (member) {
        ok(html.indexOf(esc(member.data('label'))) >= 0, '...by name', member.data('label'));
        ok(html.indexOf(':' + member.data('line')) >= 0, '...with the line each one starts on', ':' + member.data('line'));
        if (member.data('signature')) {
            ok(html.indexOf(esc(member.data('signature'))) >= 0,
                '...and its own signature (the "class arguments")', member.data('signature'));
        }
    }
    console.log('   members of ' + withMembers.data('label') + ': ' +
        members.slice(0, 3).map(function (m) { return m.data('label') + ':' + m.data('line'); }).join(', '));
}

// A file box lists its symbols with their lines, and knows its own range.
const fileBox = S.cy.nodes('[_isFileContainer]').filter(function (b) { return b.children().length > 0; })[0];
if (fileBox) {
    showDetails(fileBox.data());
    const html = panelHtml();
    ok(html.indexOf('Symbols (') >= 0, 'a file box lists its symbols');
    const kid = fileBox.children()[0];
    ok(!!kid && html.indexOf(':' + kid.data('line')) >= 0, '...with the line each one starts on',
        kid && kid.data('label') + ':' + kid.data('line'));
    ok(/lines? \d+/.test(html), '...and the box reports the line range it covers', fileBox.data('line'));
}


// ── 13. incoming and outgoing edges are two colours, not one ────────
// The complaint: two `calls` edges on the same node were indistinguishable
// apart from an 8px arrow head, so "what does this call?" and "who calls this?"
// could not be read off the picture. Focus now re-colours the edges touching
// the focused node by direction, and the panel names the same two groups in
// the same two colours with the tag printed beside them.
const { DIRECTION_COLORS, DIRECTION_NAMES } = await import('../web/refactor/app/constants.js');

// An edge has to join two different things to have a direction at all. The
// scene used to carry ~100 self-loops, all of them the projection of a
// `contains` edge onto an anchored key (`emit_def -> emit_def`, i.e. "this
// function is inside itself").
const selfLoops = S.cy.edges().filter(function (e) { return e.source().id() === e.target().id(); });
ok(selfLoops.length === 0, 'no edge loops onto its own node (nothing to point at)',
    selfLoops.map(function (e) { return e.data('kind'); }).join(','));

/// cytoscape reports a computed colour as `rgb(r, g, b)`; the constants are
/// hex. Normalise before comparing, or the check passes/fails on formatting.
function hexOf(c) {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(c));
    if (!m) return String(c).toLowerCase();
    return '#' + [1, 2, 3].map(function (i) { return ('0' + Number(m[i]).toString(16)).slice(-2); }).join('');
}

/// The one case a colour can *not* have been read from before: a node joined to
/// the same tag both ways. Its outgoing and incoming edges must now differ.
function dirPair(id) {
    const node = S.cy.getElementById(id);
    const out = [], inc = [];
    node.connectedEdges().forEach(function (e) {
        const s = e.source().id(), t = e.target().id();
        if (s === t) return;
        if (s === id) out.push(e); else if (t === id) inc.push(e);
    });
    for (const o of out) {
        const same = inc.filter(function (e) { return e.data('kind') === o.data('kind'); })[0];
        if (same) return { node: node, out: o, in: same, kind: o.data('kind') };
    }
    return null;
}

let dp = null;
symbolsInScene.forEach(function (n) { if (!dp && dirPair(n.id())) dp = dirPair(n.id()); });
ok(!!dp, 'a symbol is joined by the same tag both ways (the case a colour had to fix)', dp && dp.kind);

/// Every edge's painted colour right now. A *tag* colour can legitimately equal
/// a direction colour (`implements` is the incoming hue — see constants.js), so
/// "the direction paint is gone" is checked by comparing against what the edges
/// looked like before the focus, not by hunting for the two hexes.
const edgePaint = function () {
    const m = {};
    S.cy.edges().forEach(function (e) { m[e.id()] = hexOf(e.style('line-color')); });
    return m;
};

if (dp) {
    const before = edgePaint();
    focusNode(dp.node.id());
    const outColor = hexOf(dp.out.style('line-color'));
    const inColor = hexOf(dp.in.style('line-color'));
    ok(outColor !== inColor, 'the same tag reads differently in and out', dp.kind + ': ' + outColor + ' vs ' + inColor);
    ok(outColor === DIRECTION_COLORS.out.toLowerCase(), 'outgoing is the outgoing colour', outColor);
    ok(inColor === DIRECTION_COLORS.in.toLowerCase(), 'incoming is the incoming colour', inColor);
    ok(Number(dp.out.style('opacity')) === 1 && Number(dp.in.style('opacity')) === 1,
        'both are fully lit (the direction pass is not the dim pass)');

    const during = edgePaint();
    const repainted = Object.keys(before).filter(function (id) { return during[id] !== before[id]; });
    ok(repainted.length >= 2, 'focus repainted the edges around the node by direction', repainted.length);
    ok(repainted.length < Object.keys(before).length,
        '...and only those: an edge that does not touch the focused node keeps its tag colour',
        repainted.length + ' of ' + Object.keys(before).length);

    // The panel: the same two colours, in words, with the tag still named.
    const html = panelHtml();
    ok(html.indexOf(DIRECTION_NAMES.out) >= 0, 'the panel has an ' + DIRECTION_NAMES.out + ' group');
    ok(html.indexOf(DIRECTION_NAMES.in) >= 0, '...and an ' + DIRECTION_NAMES.in + ' group');
    ok(html.indexOf(DIRECTION_COLORS.out) >= 0 && html.indexOf(DIRECTION_COLORS.in) >= 0,
        '...in the same two colours the canvas just painted the edges with');
    ok(html.indexOf('>' + dp.kind + '<') >= 0 || html.indexOf(dp.kind) >= 0,
        'the tag is still named next to the arrow (the colour did not replace it)', dp.kind);

    // A callsite line on an edge is the other half of "where is this written".
    const edged = S.cy.edges().filter(function (e) { return !!e.data('line') && !e.data('_agg'); })[0];
    ok(!!edged, 'some edges carry the line they were written on', edged && edged.data('kind') + ':' + edged.data('line'));
    if (edged) {
        focusNode(edged.source().id());
        ok(panelHtml().indexOf(':' + edged.data('line')) >= 0, 'a callsite line shows up in the panel',
            ':' + edged.data('line'));
    }

    unfocusAll();
    const after = edgePaint();
    const drifted = Object.keys(before).filter(function (id) { return after[id] !== before[id]; });
    ok(drifted.length === 0, 'unfocus gives every edge back the colour it had before the focus', drifted.length);
    ok(hexOf(dp.out.style('line-color')) === hexOf(dp.out.data('color')),
        '...including the ones that were just lit', dp.out.style('line-color'));
    ok(panelHtml().indexOf('empty') >= 0, 'unfocus empties the panel again');
}

// ── 14. the text on the graph comes from one palette ────────────────
// Label text used to be five literals spread over four files — overlay.js
// painted one pair on build() and a brighter pair on every later sync, main.js
// and controls.js carried their own, details.js a third — which is exactly the
// kind of thing that quietly drifts. They now share LABEL_COLORS
// (constants.js), and this pins that both label paths paint the *same* value,
// whatever that value is: retuning the palette must never fail this, only
// letting the paths disagree again should.
const { LABEL_COLORS, LABEL_HALO } = await import('../web/refactor/app/constants.js');

/// Drawn nodes of a selector that the overlay really has a span for.
function labelledSpans(sel) {
    return S.cy.nodes(sel).filter(function (n) {
        return n.style('display') !== 'none' && !!overlayOf(n.id());
    });
}

S.nativeLabels = false;
S.showLineNumbers = true;
S.labelOverlay.render();
await settle();

const palFolder = labelledSpans('[_isFolder]')[0];
const palFile = labelledSpans('[_isFileContainer]')[0];
const palSymbol = labelledSpans('[_isSymbol]')[0];
ok(!!palFolder && !!palFile && !!palSymbol, 'the scene has a drawn folder, file and symbol to label',
    [palFolder, palFile, palSymbol].map(function (n) { return !!n; }).join(','));

if (palFolder && palFile && palSymbol) {
    const fSpan = overlayOf(palFolder.id()), xSpan = overlayOf(palFile.id()), sSpan = overlayOf(palSymbol.id());
    ok(fSpan.style.color === LABEL_COLORS.folder, 'a folder name is painted in LABEL_COLORS.folder', fSpan.style.color);
    ok(xSpan.style.color === LABEL_COLORS.file, 'a file name is painted in LABEL_COLORS.file', xSpan.style.color);
    ok(sSpan.style.color === LABEL_COLORS.symbol, 'a symbol name is painted in LABEL_COLORS.symbol', sSpan.style.color);
    ok(String(sSpan.style['text-shadow']).indexOf(LABEL_HALO) >= 0,
        '...over the halo that keeps it legible when an edge runs through it', sSpan.style['text-shadow']);
    ok(String(sSpan.innerHTML).indexOf(LABEL_COLORS.line) >= 0,
        'and the `:line` beside a name is LABEL_COLORS.line', sSpan.innerHTML);

    // The other path: the *Native labels* checkbox hands the drawing to
    // cytoscape, which must land on the same three colours.
    const nativeBox = document.getElementById('native-labels');
    nativeBox.checked = true;
    nativeBox.fire('change');
    ok(hexOf(palFolder.style('color')) === LABEL_COLORS.folder,
        'native labels paint a folder in the same colour', palFolder.style('color'));
    ok(hexOf(palFile.style('color')) === LABEL_COLORS.file,
        '...and a file in the same colour', palFile.style('color'));
    ok(hexOf(palSymbol.style('color')) === LABEL_COLORS.symbol,
        '...and a symbol in the same colour', palSymbol.style('color'));
    nativeBox.checked = false;
    nativeBox.fire('change');
}


console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED') + '   (' + checks + ' assertions)');



process.exit(failures === 0 ? 0 : 1);


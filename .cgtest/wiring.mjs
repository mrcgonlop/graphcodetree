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

class El {
    constructor(tag, id) {
        this.tagName = (tag || 'div').toUpperCase();
        this.id = id || '';
        this.value = '';
        this.checked = false;
        this.textContent = '';
        this.innerHTML = '';
        this.dataset = {};
        this.style = {};
        this.classList = { add() {}, remove() {}, contains() { return false; }, toggle() {} };
        this._h = {};
    }
    addEventListener(type, fn) { (this._h[type] = this._h[type] || []).push(fn); }
    removeEventListener() {}
    appendChild() {}
    querySelectorAll() { return []; }
    /// Fire a listener list the way a browser would (so `this` is the element).
    fire(type) {
        const list = this._h[type] || [];
        for (const fn of list) fn.call(this, { type: type, target: this });
        return list.length;
    }
    setAttribute() {}
    getAttribute() { return null; }
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

// ── 4. the selects cover the engines/detail levels the code can use ──
for (const e of ['hierarchy', 'cose', 'grid', 'breadthfirst']) {
    ok((optionValues['engine-select'] || []).indexOf(e) >= 0, 'engine-select offers "' + e + '"');
}
for (const d of ['full', 'files', 'flat']) {
    ok((optionValues['detail-select'] || []).indexOf(d) >= 0, 'detail-select offers "' + d + '"');
}
for (const name of Object.keys(PRESETS)) {
    ok((optionValues['engine-select'] || []).indexOf(PRESETS[name].engine) >= 0,
        'preset "' + name + '" engine is selectable', PRESETS[name].engine);
}
ok(String(document.getElementById('engine-select').value) === String(S.engine),
    'engine-select starts on S.engine', S.engine);

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

// The tree layout is deterministic: leaving and returning to the engine with
// these (now extreme) slider values must reproduce the exact same extent.
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

// engine select
const engineSel = document.getElementById('engine-select');
for (const name of ['cose', 'grid', 'breadthfirst', 'hierarchy']) {
    engineSel.value = name;
    engineSel.fire('change');
    ok(S.engine === name, 'engine-select switched to ' + name, S.engine);
    ok(!!buildLayoutOptions(), 'layout options build for ' + name);
}
ok(S.engine === 'hierarchy' && extent() === packed,
    'returning to the tree engine reproduces the same extent (deterministic)', extent() + ' vs ' + packed);

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
    ok(S.engine === PRESETS[name].engine, 'preset "' + name + '" set the engine', S.engine);
    if (PRESETS[name].detail && PRESETS[name].detail !== detailBefore) {
        ok(String(detailSel.value) === String(S.detail), 'detail-select followed preset "' + name + '"');
    }
    ok(String(engineSel.value) === String(S.engine), 'engine-select followed preset "' + name + '"', engineSel.value);
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
ok(String(engineSel.value) === String(S.engine), 'reset-params refreshed the select', engineSel.value);

// ── 6. instant tree feedback vs the debounced legacy path ───────────
// The tree engine is one deterministic sweep, so the tree sliders re-pack on
// the spot. The cose sliders keep their 250ms debounce (they are expensive),
// so they must not move anything synchronously.
document.getElementById('reset-params-btn').fire('click');
document.getElementById('relayout-btn').fire('click');
ok(S.engine === 'hierarchy', 'reset left the tree engine selected', S.engine);

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

// The legacy debounced path, exercised on cose where the knob actually bites.
// It only exists while the user has auto re-layout switched on, so turn that
// on first — otherwise scheduleRelayout() returns without scheduling anything.
const autoChk = document.getElementById('auto-relayout');
autoChk.checked = true;
autoChk.fire('change');
ok(S.autoRelayout === true, 'auto-relayout checkbox reached state');

engineSel.value = 'cose';
engineSel.fire('change');
const coseBefore = extent();
const rep = document.getElementById('repulsion-range');
rep.value = '200000';
rep.fire('input');
ok(extent() === coseBefore, 'a cose slider does not re-layout synchronously (it is debounced)');
await new Promise(function (r) { setTimeout(r, 400); });
ok(extent() !== coseBefore, '...and it does re-layout after the 250ms debounce', coseBefore + ' -> ' + extent());

autoChk.checked = false;
autoChk.fire('change');
ok(S.autoRelayout === false, 'auto-relayout checkbox toggles back');

engineSel.value = 'hierarchy';
engineSel.fire('change');

// the label-mode checkbox path
const nl = document.getElementById('native-labels');
nl.checked = true;
nl.fire('change');
ok(S.nativeLabels === true, 'native-labels checkbox reached state');
nl.checked = false;
nl.fire('change');
ok(S.nativeLabels === false, 'native-labels checkbox toggles back');

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED') + '   (' + checks + ' assertions)');
process.exit(failures === 0 ? 0 : 1);

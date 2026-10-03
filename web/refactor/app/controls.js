// ── Live UI parameter controls ──────────────────────────────────────
// One place that wires every control to state, applies what can be
// applied instantly, and reports the *derived* numbers (zoom, extent,
// node px vs label px, cose spacing) so the presentation can be reasoned
// about instead of guessed.

import { S, resetParams, applyPreset } from './state.js';
import { LABEL_COLORS } from './constants.js';
import { runLayout, estimateSpacing } from './layout.js';

// ── Number formatting ───────────────────────────────────────────────

function fmtInt(v) { return '' + Math.round(v); }
function fmtFloat(v) { return '' + (Math.round(v * 100) / 100); }
function fmt3(v) { return '' + (Math.round(v * 1000) / 1000); }

// ── Control registry (lets "Reset params" refresh every slider) ──────

const _controls = [];

/// Bind a range input to a state field. The matching readout element is
/// `#<id with trailing "-range" replaced by "-val">`.
function bindRange(spec) {
    const input = document.getElementById(spec.id);
    if (!input) return;
    const out = document.getElementById(spec.id.replace(/-range$/, '-val'));
    const parse = spec.parse || function (str) { return parseFloat(str); };
    const display = spec.display || fmtFloat;

    function read() { return spec.get(S); }
    function show(v) { if (out) out.textContent = display(v); }

    input.value = read();
    show(read());

    input.addEventListener('input', function () {
        const v = parse(this.value);
        spec.set(S, v);
        show(v);
        if (spec.live) spec.live(v);
        updateMetrics();
    });

    _controls.push({ input: input, out: out, display: display, get: spec.get });
}

function refreshControlValues() {
    _controls.forEach(function (c) {
        const v = c.get(S);
        c.input.value = v;
        if (c.out) c.out.textContent = c.display(v);
    });
}

// ── Live metrics HUD ────────────────────────────────────────────────
// The whole point: show the numbers that make the disproportion obvious.
// cose settles nodes at d ≈ sqrt(repulsion / gravity); with N nodes the
// layout spans roughly sqrt(N)·d, which fixes the zoom, which fixes how
// many pixels a node occupies next to a fixed-px label.

export function updateMetrics() {
    const out = document.getElementById('metrics');
    if (!out || !S.cy) return;
    let zoom = 1;
    try { zoom = S.cy.zoom(); } catch (e) { /* noop */ }

    let ext = { w: 0, h: 0 };
    try {
        const bb = S.cy.elements().boundingBox();
        if (bb && isFinite(bb.w) && isFinite(bb.h)) ext = { w: bb.w, h: bb.h };
    } catch (e) { /* noop */ }

    let nNodes = 0;
    try { nNodes = S.cy.nodes().length; } catch (e) { /* noop */ }

    const nodePx = S.nodeSize * zoom;
    const labelPx = S.currentFontSize;
    const ratio = nodePx > 0 ? labelPx / nodePx : 0;
    const spacing = estimateSpacing();
    const estExtent = Math.sqrt(Math.max(nNodes, 1)) * spacing;
    const c = document.getElementById('graph-container');
    const vw = (c && c.clientWidth) || 1000;
    const estZoom = estExtent > 0 ? vw / estExtent : 0;

    // For the tree engine the meaningful numbers are the tree's own
    // geometry — a measured summary of the last hierarchy layout.
    const hier = S.engine === 'hierarchy' ? S.hierarchyStats : null;
    const treeLine = hier
        ? 'tree ' + hier.levels + ' lvls \u00B7 ' + hier.boxes + ' boxes \u00B7 ' +
          hier.symbols + ' symbols \u00B7 cell \u2248' + hier.cell + 'u'
        : 'spacing d\u2248' + Math.round(spacing) + 'u \u00B7 est extent\u2248' + Math.round(estExtent) +
          'u \u00B7 est zoom\u2248' + fmt3(estZoom);

    out.innerHTML =
        'zoom ' + fmt3(zoom) + ' · extent ' + Math.round(ext.w) + '\u00D7' + Math.round(ext.h) + ' u<br>' +
        'node ' + S.nodeSize + 'u \u2192 <b>' + nodePx.toFixed(2) + 'px</b> · label <b>' + labelPx + 'px</b> ' +
        '<span style="color:' + (ratio > 2 ? '#f7768e' : '#9ece6a') + '">(label/node ' + ratio.toFixed(1) + '\u00D7)</span><br>' +
        treeLine + '<br>' +
        'nodes ' + nNodes + ' · ' + S.engine + ' · ' + S.detail + ' · ' +
        (S.nativeLabels ? 'native labels' : 'DOM labels') +
        (S.showLineNumbers ? ' \u00B7 lines shown' : '');
}

// ── Public entry point ──────────────────────────────────────────────

export function initControls() {
    if (!S.cy) return;

    /// Re-apply every style-driven presentation parameter from state: the
    /// sizes the layout engine predicts from (see BORDERS) and the label
    /// colours, which both label paths have to agree on (LABEL_COLORS in
    /// constants.js). The containers are the two roles that are only declared
    /// in main.js's initial stylesheet, so re-asserting them here is what
    /// keeps the native-label path on the same palette as the DOM overlay.
    function applyGraphStyles() {
        S.cy.style()
            .selector('node[_isSymbol]')
            .style('width', S.nodeSize)
            .style('height', S.nodeSize)
            .selector('node[_isFileContainer]')
            .style('padding', S.containerPadding)
            .style('font-size', Math.max(S.currentFontSize, 11) + 'px')
            .style('color', LABEL_COLORS.file)
            .selector('node[_isFolder]')
            .style('padding', S.folderPadding)
            .style('font-size', Math.max(S.currentFontSize + 2, 12) + 'px')
            .style('color', LABEL_COLORS.folder)
            .update();
        if (S.labelOverlay) S.labelOverlay.updatePositions();
    }

    /// Switch symbol labels between native (zoom-scaled) and DOM overlay
    /// (fixed px). Native labels also get accounted for by the layout.
    /// Line numbers are a *data* choice, not a drawing one: the native path
    /// picks `data(labelLine)` (built in builder.js), so toggling them never
    /// has to rebuild the scene.
    ///
    /// Boxes follow the same switch. The DOM overlay paints a box name from
    /// `_filePath`; main.js starts each container at `label: ''` so cytoscape
    /// does not paint a second, dimmer copy of it underneath. Native mode
    /// (overlay hidden) is where cytoscape has to draw the box name itself,
    /// so that is the only branch that hands `data(label)` back.
    function applyLabelMode() {
        S.cy.style()
            .selector('node[_isSymbol]')
            .style('label', S.nativeLabels ? (S.showLineNumbers ? 'data(labelLine)' : 'data(label)') : '')
            .style('font-size', S.currentFontSize + 'px')
            .style('color', LABEL_COLORS.symbol)
            .style('text-valign', 'bottom')
            .style('text-halign', 'center')
            .style('text-margin-y', 4)
            .selector('node[_isFileContainer]')
            .style('label', S.nativeLabels ? 'data(label)' : '')
            .selector('node[_isFolder]')
            .style('label', S.nativeLabels ? 'data(label)' : '')
            .update();
        const ov = document.getElementById('label-overlay');
        if (ov) ov.style.display = S.nativeLabels ? 'none' : '';
        if (S.labelOverlay) S.labelOverlay.positionUpdate();
    }

    // Throttled metrics refresh, shared by the pan/zoom handler.
    let metricsPending = false;
    function throttledMetrics() {
        if (metricsPending) return;
        metricsPending = true;
        requestAnimationFrame(function () { metricsPending = false; updateMetrics(); });
    }

    // render() calls initControls(), and a detail change calls render()
    // again — so re-entering here must NOT re-bind DOM listeners (that
    // would stack duplicate handlers on every slider). Only re-apply the
    // presentation to the fresh Cytoscape instance.
    if (S._controlsReady) {
        applyGraphStyles();
        applyLabelMode();
        S.cy.on('zoom pan', throttledMetrics);
        updateMetrics();
        return;
    }
    S._controlsReady = true;

    // ── Sizing ──
    /// The tree engine *predicts* every box from the symbol size and the two
    /// paddings (see the `nodeSize`/`filePad`/`folderPad` options in
    /// layout.js), so changing them has to re-pack: applying the styles alone
    /// would leave symbols hanging outside boxes that were sized for the old
    /// value. The tree pass is a single deterministic sweep, so it can just
    /// run again immediately.
    function sizingLive() {
        return function () {
            applyGraphStyles();
            if (S.engine === 'hierarchy') runLayout();
        };
    }

    bindRange({
        id: 'font-range', parse: function (s) { return parseInt(s, 10); }, display: fmtInt,
        get: function (s) { return s.currentFontSize; },
        set: function (s, v) { s.currentFontSize = v; },
        live: function () { applyGraphStyles(); applyLabelMode(); },
    });
    bindRange({
        id: 'node-size-range', parse: function (s) { return parseInt(s, 10); }, display: fmtInt,
        get: function (s) { return s.nodeSize; },
        set: function (s, v) { s.nodeSize = v; },
        live: sizingLive(),
    });
    bindRange({
        id: 'pad-range', parse: function (s) { return parseInt(s, 10); }, display: fmtInt,
        get: function (s) { return s.containerPadding; },
        set: function (s, v) { s.containerPadding = v; },
        live: sizingLive(),
    });
    bindRange({
        id: 'folder-pad-range', parse: function (s) { return parseInt(s, 10); }, display: fmtInt,
        get: function (s) { return s.folderPadding; },
        set: function (s, v) { s.folderPadding = v; },
        live: sizingLive(),
    });

    // ── Tree geometry (read by the 'hierarchy' engine) ──
    // The tree engine is a single deterministic pass, so these can simply
    // re-layout — no debounce, no force iterations, instant feedback.
    bindRange({ id: 'hier-nodegapx-range', parse: function (s) { return parseInt(s, 10); }, display: fmtInt,
        get: function (s) { return s.hierNodeGapX; },
        set: function (s, v) { s.hierNodeGapX = v; },
        live: function () { runLayout(); } });
    bindRange({ id: 'hier-nodegapy-range', parse: function (s) { return parseInt(s, 10); }, display: fmtInt,
        get: function (s) { return s.hierNodeGapY; },
        set: function (s, v) { s.hierNodeGapY = v; },
        live: function () { runLayout(); } });
    bindRange({ id: 'hier-colgap-range', parse: function (s) { return parseInt(s, 10); }, display: fmtInt,
        get: function (s) { return s.hierColGap; },
        set: function (s, v) { s.hierColGap = v; },
        live: function () { runLayout(); } });
    bindRange({ id: 'hier-rowgap-range', parse: function (s) { return parseInt(s, 10); }, display: fmtInt,
        get: function (s) { return s.hierRowGap; },
        set: function (s, v) { s.hierRowGap = v; },
        live: function () { runLayout(); } });
    bindRange({ id: 'hier-aspect-range', display: fmtFloat,
        get: function (s) { return s.hierAspect; },
        set: function (s, v) { s.hierAspect = v; },
        live: function () { runLayout(); } });

    // ── Outer pad (applied by every engine as the layout padding) ──
    bindRange({ id: 'layoutpad-range', parse: function (s) { return parseInt(s, 10); }, display: fmtInt,
        get: function (s) { return s.layout.layoutPadding; },
        set: function (s, v) { s.layout.layoutPadding = v; },
        live: function () { runLayout(); } });

    // ── Selects ──
    // The engine is the containment tree, full stop: a select for cose/grid/
    // breadthfirst used to sit here and picking one scattered the boxes the
    // hierarchy exists to keep. Only the detail level is still a choice.
    const detailSel = document.getElementById('detail-select');

    /// Push the live state back into the selects. Needed after a preset or
    /// a reset, both of which can change the detail level.
    function syncSelects() {
        if (detailSel) detailSel.value = S.detail;
    }

    if (detailSel) {
        detailSel.value = S.detail;
        detailSel.addEventListener('change', function () {
            S.detail = this.value;
            if (S.rebuild) S.rebuild(); else runLayout();
            updateMetrics();
        });
    }

    // ── Checkboxes ──
    const nlChk = document.getElementById('native-labels');
    if (nlChk) {
        nlChk.checked = S.nativeLabels;
        nlChk.addEventListener('change', function () {
            S.nativeLabels = this.checked;
            applyLabelMode();
            runLayout();
            updateMetrics();
        });
    }

    // Line numbers. The DOM overlay is the only surface that needs a *rebuild*
    // (each span's text changes); the native path just re-picks its label data.
    const lnChk = document.getElementById('show-lines');
    if (lnChk) {
        lnChk.checked = S.showLineNumbers;
        lnChk.addEventListener('change', function () {
            S.showLineNumbers = this.checked;
            applyLabelMode();
            if (!S.nativeLabels && S.labelOverlay) S.labelOverlay.render();
            updateMetrics();
        });
    }

    // ── Buttons ──
    const resetView = document.getElementById('reset-view-btn');
    if (resetView) resetView.addEventListener('click', function () { S.cy.fit(S.cy.elements(), 50); updateMetrics(); });

    const relayout = document.getElementById('relayout-btn');
    if (relayout) relayout.addEventListener('click', function () { runLayout(); updateMetrics(); });

    const resetParamsBtn = document.getElementById('reset-params-btn');
    if (resetParamsBtn) resetParamsBtn.addEventListener('click', function () {
        resetParams();
        refreshControlValues();
        syncSelects();
        if (nlChk) nlChk.checked = S.nativeLabels;
        if (lnChk) lnChk.checked = S.showLineNumbers;
        applyGraphStyles();
        applyLabelMode();
        if (S.rebuild) S.rebuild(); else runLayout();
        updateMetrics();
    });

    // A preset can change the engine / detail level too, so sync the selects
    // and rebuild when the scene itself has to change, not just its geometry.
    document.querySelectorAll('.preset-btn').forEach(function (b) {
        b.addEventListener('click', function () {
            const prevDetail = S.detail;
            applyPreset(this.dataset.preset);
            refreshControlValues();
            syncSelects();
            if (S.rebuild && S.detail !== prevDetail) S.rebuild(); else runLayout();
            updateMetrics();
        });
    });

    S.cy.on('zoom pan', throttledMetrics);
    updateMetrics();
}



// ── Label overlay DOM management ────────────────────────────────────
// Creates and updates HTML <span> labels positioned over Cytoscape nodes.
// All label spans are in a single overlay div for performance.

import { S } from './state.js';
import { LABEL_COLORS, LABEL_HALO } from './constants.js';
import { addressOf, esc } from './utils.js';
import { toggleContainer } from './visibility.js';

// The cytoscape instance the sync listeners are attached to. The overlay is
// rebuilt (with a fresh cy) whenever the scene is, so this is a one-shot
// binding per instance rather than a per-call one.
let _boundCy = null;

/// How strongly a label is painted.
///
/// A symbol carries the focus dim in its own `opacity`; a container carries it
/// in `text-opacity` instead, because cytoscape multiplies a parent's `opacity`
/// into every descendant (effectiveOpacity) and dimming a box that way would
/// also dim the lit symbols inside it. Multiplying the two is right either way:
/// one of them is always 1.
function spanOpacity(n) {
    const o = Number(n.style('opacity'));
    const t = Number(n.style('text-opacity'));
    return (isFinite(o) ? o : 1) * (isFinite(t) ? t : 1);
}

/// What a label *says*: the name, plus the line the definition starts on when
/// the line-number toggle is on. The name and the number are separate spans so
/// the number can be smaller and dimmer than the name, which is what makes a
/// column of `:412` read as an index rather than as part of the name.
/// Line numbers are the extractor's spans, which every node has carried since
/// the beginning — the refactor is what stopped drawing them.
/// Boxes are left alone: the line a folder "starts" on is just the first line
/// of whatever is inside it, and its range belongs in the tooltip instead.
function labelHtml(n, lbl) {
    const name = esc(String(lbl || ''));
    const d = n.data();
    if (!S.showLineNumbers || d._isContainer) return name;
    const line = d.line;
    if (line === null || line === undefined) return name;
    // The number takes its colour from the palette (inline) rather than the
    // `#label-overlay .ln` rule, so every piece of label text has exactly one
    // source: LABEL_COLORS in constants.js.
    return name + '<span class="ln" style="color:' + LABEL_COLORS.line + '">:' + line + '</span>';
}

/// What hovering a label says. All of it is already in the snapshot (the
/// signature, the doc comment, the address) and this is the cheapest place to
/// show it without spending a click: a tooltip on the label the mouse is over.
function tooltipOf(n) {
    const d = n.data();
    const bits = [];
    if (d._isContainer) {
        bits.push(d.label || d._filePath || '');
        const addr = addressOf(d);
        if (addr) bits.push(addr + ((d.endLine && d.endLine !== d.line) ? '\u2013' + d.endLine : ''));
        if (d._collapsible) bits.push(d._collapsed ? 'Click to expand' : 'Click to collapse');
    } else {
        bits.push((d.label || d.id) + (d.kind ? ' \u00B7 ' + d.kind : ''));
        if (d.signature) bits.push(d.signature);
        bits.push(addressOf(d) + ((d.endLine && d.endLine !== d.line) ? '\u2013' + d.endLine : ''));
        if (d.visibility && d.visibility !== 'private') bits.push(d.visibility);
        if (d.doc) bits.push('\u201C' + d.doc + '\u201D');
    }
    return bits.filter(Boolean).join('\n');
}

export function createLabelOverlays() {
    const container = document.getElementById('graph-container');
    let overlay = document.getElementById('label-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'label-overlay';
        overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:hidden;';
        container.appendChild(overlay);
    }

    // ── Keep the labels glued to the graph ──
    // The spans are absolutely positioned in *screen* space, so they have to
    // be re-read whenever the viewport or the model moves. Nothing used to do
    // that, which is why a label stayed at the coordinate it was born at
    // while panning, zooming or dragging.
    //   render           → any redraw cytoscape does (browser)
    //   position         → a node was moved (drag, layout, box pass)
    //   pan/zoom/viewport→ the camera moved. Headless cytoscape emits these
    //                      but no 'render', so they are what a harness can
    //                      drive without a browser.
    let _pending = false;
    function scheduleSync() {
        if (_pending) return;
        _pending = true;
        const raf = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame
            : function (fn) { return setTimeout(fn, 0); };
        raf(function () { _pending = false; updatePositions(); });
    }

    function bindSync(cy) {
        if (!cy || _boundCy === cy) return;
        _boundCy = cy;
        cy.on('render position pan zoom viewport resize drag', scheduleSync);
    }

    /// Full rebuild: destroy and recreate all label spans.
    function build() {
        if (!S.cy) { overlay.innerHTML = ''; return; }
        bindSync(S.cy);
        if (S.nativeLabels) { overlay.innerHTML = ''; return; }   // cytoscape draws the labels itself
        overlay.innerHTML = '';
        try {
            S.cy.nodes().forEach(function (n) {
                if (n.style('display') === 'none') return;
                var pos = n.renderedPosition();
                if (!pos || typeof pos.x !== 'number' || !isFinite(pos.x) || !isFinite(pos.y)) return;

                var isContainer = n.data('_isContainer');
                var lbl = isContainer
                    ? (n.data('_filePath') || '').replace(/^.*[/\\\\]/, '')
                    : n.data('label');
                if (!lbl) return;

                var span = document.createElement('span');
                span.innerHTML = labelHtml(n, lbl);
                span.dataset.nodeId = n.id();
                span.title = tooltipOf(n);

                var topOffset, fontSize, color;
                if (isContainer) {
                    var bb = n.renderedBoundingBox();
                    if (!bb || !isFinite(bb.x1) || !isFinite(bb.y1) || !isFinite(bb.x2) || !isFinite(bb.y2)) return;
                    topOffset = bb.y1 - 8;
                    fontSize = n.data('_isFolder')
                        ? Math.max(S.currentFontSize + 2, 12)
                        : Math.max(S.currentFontSize, 11);
                    color = n.data('_isFolder') ? LABEL_COLORS.folder : LABEL_COLORS.file;
                } else {
                    topOffset = pos.y + 6;
                    fontSize = S.currentFontSize;
                    color = LABEL_COLORS.symbol;
                }
                var baseSize = typeof fontSize === 'number' ? fontSize : parseInt(fontSize);
                span.style.cssText =
                    'position:absolute;left:' + pos.x + 'px;top:' + topOffset + 'px;' +
                    'transform:translate(-50%,0);font-size:' + baseSize + 'px;' +
                    'color:' + color + ';text-shadow:0 0 3px ' + LABEL_HALO + ',0 0 6px ' + LABEL_HALO + ';' +
                    'white-space:nowrap;user-select:text;' +
                    'opacity:' + spanOpacity(n) + ';' +
                    'transition:opacity 0.15s';
                if (isContainer && n.data('_collapsible')) {
                    span.style.pointerEvents = 'auto';
                    span.style.cursor = 'pointer';
                    span.title = tooltipOf(n);
                    span.addEventListener('click', function (e) {
                        e.stopPropagation();
                        toggleContainer(S.cy.getElementById(n.id()));
                    });
                }
                overlay.appendChild(span);
            });
        } catch (e) {
            console.warn('label overlay build error:', e);
        }
    }

    /// Lightweight position + opacity sync (no DOM rebuild).
    function updatePositions() {
        if (!S.cy) return;
        bindSync(S.cy);
        if (S.nativeLabels) return;   // cytoscape draws the labels itself
        try {
            var map = {};
            overlay.querySelectorAll('span').forEach(function (s) { map[s.dataset.nodeId] = s; });
            S.cy.nodes().forEach(function (n) {
                var span = map[n.id()];
                if (!span) return;
                if (n.style('display') === 'none') { span.style.display = 'none'; return; }
                span.style.display = '';
                var pos = n.renderedPosition();
                if (!pos || !isFinite(pos.x) || !isFinite(pos.y)) { span.style.display = 'none'; return; }

                var isContainer = n.data('_isContainer');
                var lbl = isContainer
                    ? (n.data('_filePath') || '').replace(/^.*[/\\\\]/, '')
                    : n.data('label');
                span.innerHTML = labelHtml(n, lbl);
                span.title = tooltipOf(n);

                if (isContainer) {
                    var bb = n.renderedBoundingBox();
                    if (bb && isFinite(bb.x1) && isFinite(bb.y1) && isFinite(bb.x2) && isFinite(bb.y2)) {
                        span.style.left = pos.x + 'px';
                        span.style.top = (bb.y1 - 8) + 'px';
                    }
                    var fs = n.data('_isFolder')
                        ? Math.max(S.currentFontSize + 2, 12)
                        : Math.max(S.currentFontSize, 11);
                    span.style.fontSize = fs + 'px';
                    span.style.color = n.data('_isFolder') ? LABEL_COLORS.folder : LABEL_COLORS.file;
                    span.style.pointerEvents = 'auto';
                    span.style.cursor = 'pointer';
                    span.title = tooltipOf(n);
                } else {
                    span.style.left = pos.x + 'px';
                    span.style.top = (pos.y + 6) + 'px';
                    span.style.fontSize = S.currentFontSize + 'px';
                    span.style.color = LABEL_COLORS.symbol;
                    span.style.pointerEvents = 'none';
                    span.style.cursor = 'default';
                }
                span.style.opacity = spanOpacity(n);
            });
        } catch (e) {
            console.warn('label overlay updatePositions error:', e);
        }
    }

    return { build, render: build, updatePositions, positionUpdate: updatePositions, sync: scheduleSync };
}

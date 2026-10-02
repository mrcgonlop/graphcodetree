// ── Label overlay DOM management ────────────────────────────────────
// Creates and updates HTML <span> labels positioned over Cytoscape nodes.
// All label spans are in a single overlay div for performance.

import { S } from './state.js';
import { toggleContainer } from './visibility.js';

export function createLabelOverlays() {
    const container = document.getElementById('graph-container');
    let overlay = document.getElementById('label-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'label-overlay';
        overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:hidden;';
        container.appendChild(overlay);
    }

    /// Full rebuild: destroy and recreate all label spans.
    function build() {
        if (!S.cy) { overlay.innerHTML = ''; return; }
        overlay.innerHTML = '';
        if (S.nativeLabels) return;   // cytoscape draws the labels itself
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
                span.textContent = lbl;
                span.dataset.nodeId = n.id();

                var topOffset, fontSize, color;
                if (isContainer) {
                    var bb = n.renderedBoundingBox();
                    if (!bb || !isFinite(bb.x1) || !isFinite(bb.y1) || !isFinite(bb.x2) || !isFinite(bb.y2)) return;
                    topOffset = bb.y1 - 8;
                    fontSize = n.data('_isFolder')
                        ? Math.max(S.currentFontSize + 2, 12)
                        : Math.max(S.currentFontSize, 11);
                    color = n.data('_isFolder') ? '#737aa2' : '#565f89';
                } else {
                    topOffset = pos.y + 6;
                    fontSize = S.currentFontSize;
                    color = '#a9b1d6';
                }
                var baseSize = typeof fontSize === 'number' ? fontSize : parseInt(fontSize);
                span.style.cssText =
                    'position:absolute;left:' + pos.x + 'px;top:' + topOffset + 'px;' +
                    'transform:translate(-50%,0);font-size:' + baseSize + 'px;' +
                    'color:' + color + ';text-shadow:0 0 3px #0f0f1a,0 0 6px #0f0f1a;' +
                    'white-space:nowrap;user-select:text;' +
                    'opacity:' + (n.style('opacity') || 1) + ';' +
                    'transition:opacity 0.15s';
                if (isContainer && n.data('_collapsible')) {
                    span.style.pointerEvents = 'auto';
                    span.style.cursor = 'pointer';
                    span.title = n.data('_collapsed') ? 'Click to expand' : 'Click to collapse';
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
                span.textContent = lbl || '';

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
                    span.style.color = n.data('_isFolder') ? '#737aa2' : '#565f89';
                    span.style.pointerEvents = 'auto';
                    span.style.cursor = 'pointer';
                    span.title = n.data('_collapsed') ? 'Click to expand' : 'Click to collapse';
                } else {
                    span.style.left = pos.x + 'px';
                    span.style.top = (pos.y + 6) + 'px';
                    span.style.fontSize = S.currentFontSize + 'px';
                    span.style.color = '#a9b1d6';
                    span.style.pointerEvents = 'none';
                    span.style.cursor = 'default';
                }
                span.style.opacity = n.style('opacity') || 1;
            });
        } catch (e) {
            console.warn('label overlay updatePositions error:', e);
        }
    }

    return { build, render: build, updatePositions, positionUpdate: updatePositions };
}

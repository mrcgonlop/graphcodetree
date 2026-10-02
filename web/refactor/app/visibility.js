// ── Visibility (single-pass filter) + container toggle ──────────────
// Consolidates name-search, path-search, kind-filter, depth-filter,
// and parent-collapse into one pass per node.

import { S } from './state.js';

/// Single pass: reads ALL filter states and sets `display` once per node.
/// Called by every filter/search/toggle.
export function refreshVisibility() {
    if (!S.cy) return;
    try {
        var searchQ = document.getElementById('search').value.toLowerCase();
        var pathQ = document.getElementById('search-path').value.toLowerCase();
    } catch (e) {
        console.warn('refreshVisibility: DOM not ready', e);
        return;
    }

    var checked = {};
    try {
        document.querySelectorAll('#filters input[type="checkbox"]').forEach(function (cb) { checked[cb.value] = cb.checked; });
    } catch (e) { /* no filters yet */ }

    var anyKindUnchecked = Object.values(checked).some(function (v) { return !v; });
    var depthActive = S.selectedMaxDepth !== null;

    S.cy.nodes().forEach(function (n) {
        // ── Container nodes: only name-search + path-search apply ──
        if (n.data('_isContainer')) {
            var fp = (n.data('_filePath') || '').toLowerCase();
            var shortName = fp.replace(/^.*[/\\\\]/, '');
            var nameMatch = searchQ === '' || shortName.includes(searchQ) || fp.includes(searchQ);
            var pathMatch = pathQ === '' || fp.includes(pathQ);
            n.style('display', nameMatch && pathMatch ? 'element' : 'none');
            return;
        }

        // ── Symbol nodes: check ALL filters in order ──

        // 1. Any parent container collapsed?
        var p = n.parent();
        while (p && p.length > 0) {
            if (p.data('_collapsed')) { n.style('display', 'none'); return; }
            p = p.parent();
        }

        // 2. Name search
        if (searchQ !== '') {
            var label = (n.data('label') || '').toLowerCase();
            var qn = (n.data('qualifiedName') || '').toLowerCase();
            if (label.indexOf(searchQ) < 0 && qn.indexOf(searchQ) < 0) {
                n.style('display', 'none'); return;
            }
        }

        // 3. Path search
        if (pathQ !== '') {
            var nfp = (n.data('file') || '').toLowerCase();
            if (nfp.indexOf(pathQ) < 0) { n.style('display', 'none'); return; }
        }

        // 4. Kind filter
        if (anyKindUnchecked && checked[n.data('kind')] === false) {
            n.style('display', 'none'); return;
        }

        // 5. Depth filter
        if (depthActive && (n.data('depth') || 0) > S.selectedMaxDepth) {
            n.style('display', 'none'); return;
        }

        n.style('display', 'element');
    });

    // Sync label overlays (lightweight — no DOM rebuild)
    if (S.labelOverlay) S.labelOverlay.updatePositions();
}

/// Collapse or expand a container node.
export function toggleContainer(cyNode) {
    if (!cyNode || cyNode.length === 0) return;
    try {
        if (cyNode.data('_collapsed')) {
            cyNode.data('_collapsed', false);
            cyNode.removeStyle('border-color');
        } else {
            cyNode.data('_collapsed', true);
            cyNode.style('border-color', '#e0af68');
        }
    } catch (e) {
        console.warn('toggleContainer: error', e);
        return;
    }
    refreshVisibility();
}

// ── Box layout (non-overlapping containers) ─────────────────────────

let _boxLayoutPending = false;

/// Schedule a non-overlapping box layout pass via rAF.
export function scheduleBoxLayout() {
    if (!S.cy || _boxLayoutPending) return;
    _boxLayoutPending = true;
    requestAnimationFrame(function () {
        _boxLayoutPending = false;
        layoutBoxes();
    });
}

/// Push sibling containers apart so they don't overlap.
function layoutBoxes() {
    if (!S.cy) return;
    try {
        var containers = [];
        S.cy.nodes().forEach(function (n) {
            if (!n.data('_isContainer')) return;
            if (n.style('display') === 'none') return;
            containers.push(n);
        });
        if (containers.length < 2) return;

        // Skip box layout if zoom is too small (would produce unstable adjustments)
        var zoom = S.cy.zoom();
        if (zoom < 0.1) return;

        var boxes = [], pad = 30;
        containers.forEach(function (n) {
            var bb = n.renderedBoundingBox({ includeLabels: false, includeNodes: true });
            if (!bb) return;
            // Validate bounding box is finite
            if (!isFinite(bb.x1) || !isFinite(bb.y1) || !isFinite(bb.x2) || !isFinite(bb.y2)) return;
            boxes.push({ node: n, x1: bb.x1 - pad, y1: bb.y1 - pad, x2: bb.x2 + pad, y2: bb.y2 + pad });
        });
        if (boxes.length < 2) return;

        var moved = false;
        for (var iter = 0; iter < 20; iter++) {
            moved = false;
            for (var i = 0; i < boxes.length; i++) {
                for (var j = i + 1; j < boxes.length; j++) {
                    var a = boxes[i], b = boxes[j];
                    var ox = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
                    var oy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
                    if (ox > 0 && oy > 0) {
                        var dx = 0, dy = 0;
                        if (ox < oy) {
                            var ca = (a.x1 + a.x2) / 2, cb = (b.x1 + b.x2) / 2;
                            dx = ca < cb ? -ox / 2 : ox / 2;
                        } else {
                            var cay = (a.y1 + a.y2) / 2, cby = (b.y1 + b.y2) / 2;
                            dy = cay < cby ? -oy / 2 : oy / 2;
                        }
                        // Clamp displacement to prevent runaway movement
                        var maxDisp = 200 / zoom;
                        dx = Math.max(-maxDisp, Math.min(maxDisp, dx / zoom));
                        dy = Math.max(-maxDisp, Math.min(maxDisp, dy / zoom));
                        a.node.position({ x: a.node.position('x') + dx, y: a.node.position('y') + dy });
                        var nb = a.node.renderedBoundingBox({ includeLabels: false, includeNodes: true });
                        if (nb && isFinite(nb.x1) && isFinite(nb.y1) && isFinite(nb.x2) && isFinite(nb.y2)) {
                            a.x1 = nb.x1 - pad; a.y1 = nb.y1 - pad;
                            a.x2 = nb.x2 + pad; a.y2 = nb.y2 + pad;
                        }
                        moved = true;
                    }
                }
            }
            if (!moved) break;
        }
        if (moved && S.labelOverlay) S.labelOverlay.positionUpdate();
    } catch (e) {
        console.warn('layoutBoxes error:', e);
    }
}


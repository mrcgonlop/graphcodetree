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

/// True when `a` is an ancestor of `b` in the compound tree.
function isAncestorOf(a, b) {
    var p = b.parent();
    var guard = 0;
    while (p && p.length > 0 && guard++ < 64) {
        if (p.id() === a.id()) return true;
        p = p.parent();
    }
    return false;
}

/// Push *sibling* containers apart so they don't overlap.
///
/// Gated behind S.boxLayoutEnabled and OFF by default. Two things were
/// wrong before and made this pass actively destructive:
///   1. it compared every container pair, including a child against its
///      own ancestors — a child box is *always* inside its parent's box,
///      so those pairs always "overlapped" and the loop could never
///      converge (it always ran the full iteration budget);
///   2. it mixed coordinate spaces — `renderedBoundingBox()` is rendered
///      (screen) space but `position()` is model space, and it applied a
///      displacement clamped at 200/zoom model units *per iteration*, so
///      at typical zoom it could fling a container ~20 000 units — many
///      times the size of the whole graph.
///
/// Now it works purely in model space (`boundingBox()`), moves both
/// nodes of a pair, skips nested pairs, and stops as soon as no pair
/// overlaps.
function layoutBoxes() {
    if (!S.cy || !S.boxLayoutEnabled) return;
    try {
        var containers = [];
        S.cy.nodes().forEach(function (n) {
            if (!n.data('_isContainer')) return;
            if (n.style('display') === 'none') return;
            containers.push(n);
        });
        if (containers.length < 2) return;

        var pad = S.boxLayoutPad;
        var maxIter = S.boxLayoutIter;

        function boxOf(n) {
            var bb = n.boundingBox({ includeLabels: false, includeNodes: true });
            if (!bb || !isFinite(bb.x1) || !isFinite(bb.y1) || !isFinite(bb.x2) || !isFinite(bb.y2)) return null;
            return { node: n, x1: bb.x1 - pad, y1: bb.y1 - pad, x2: bb.x2 + pad, y2: bb.y2 + pad };
        }

        for (var iter = 0; iter < maxIter; iter++) {
            var boxes = [];
            for (var c = 0; c < containers.length; c++) {
                var b0 = boxOf(containers[c]);
                if (b0) boxes.push(b0);
            }
            var moved = false;
            for (var i = 0; i < boxes.length; i++) {
                for (var j = i + 1; j < boxes.length; j++) {
                    var a = boxes[i], b = boxes[j];
                    // Nested containers are not overlaps: skip them.
                    if (isAncestorOf(a.node, b.node) || isAncestorOf(b.node, a.node)) continue;
                    var ox = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
                    var oy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
                    if (ox <= 0 || oy <= 0) continue;
                    var ax = a.node.position('x'), ay = a.node.position('y');
                    var bx = b.node.position('x'), by = b.node.position('y');
                    if (ox <= oy) {
                        var dx = ((a.x1 + a.x2) / 2 <= (b.x1 + b.x2) / 2) ? -(ox / 2) : (ox / 2);
                        a.node.position({ x: ax + dx, y: ay });
                        b.node.position({ x: bx - dx, y: by });
                    } else {
                        var dy = ((a.y1 + a.y2) / 2 <= (b.y1 + b.y2) / 2) ? -(oy / 2) : (oy / 2);
                        a.node.position({ x: ax, y: ay + dy });
                        b.node.position({ x: bx, y: by - dy });
                    }
                    moved = true;
                }
            }
            if (!moved) break;
        }
        if (S.labelOverlay) S.labelOverlay.positionUpdate();
    } catch (e) {
        console.warn('layoutBoxes error:', e);
    }
}


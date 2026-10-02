// ── Visibility (single-pass filter) + container toggle ──────────────
// Consolidates name-search, path-search, kind-filter, depth-filter and
// parent-collapse into one decision per node, then re-projects the edges of
// the hidden children onto their collapsed boxes (aggregate.js) and re-applies
// focus, which depends on the edges that actually exist.
//
// The symbols are settled first and the boxes after them, deepest-first: a box
// has to know whether anything inside it is still on screen, because cytoscape
// will not draw a node whose ancestor is hidden (see the note in
// refreshVisibility).

import { S } from './state.js';
import { syncAggregatedEdges } from './aggregate.js';
import { refreshFocus } from './focus.js';

/// True when any container above `n` is collapsed.
///
/// cytoscape keeps a child's own `display` value at `element` when a parent
/// is hidden, so "is this on screen?" cannot be answered from the element's
/// own style — and both the label overlay and the aggregate edges need a
/// truthful answer. Hiding such nodes here makes `display` mean exactly that.
function hasCollapsedAncestor(n) {
    var p = n.parent();
    var guard = 0;
    while (p && p.length > 0 && guard++ < 64) {
        if (p.data('_collapsed')) return true;
        p = p.parent();
    }
    return false;
}

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

    // Symbols first, then containers deepest-first: a box's own rule needs to
    // know whether anything inside it survived the filters. cytoscape refuses
    // to draw a node whose *ancestor* is hidden (`visible()` walks the parents
    // even though the child's own `display` stays `element`), so a box hidden
    // because its own path missed the query erased the circles of the matched
    // symbols inside it — the user saw their names on an empty canvas.
    const ordered = S.cy.nodes('[!_isContainer]').map(function (n) { return n; })
        .concat(S.cy.nodes('[_isContainer]').map(function (n) { return n; })
            .sort(function (a, b) { return b.ancestors().length - a.ancestors().length; }));

    ordered.forEach(function (n) {
        // ── Container nodes: collapsed ancestors + name/path search ──
        if (n.data('_isContainer')) {
            if (hasCollapsedAncestor(n)) { n.style('display', 'none'); return; }
            var fp = (n.data('_filePath') || '').toLowerCase();
            var shortName = fp.replace(/^.*[/\\]/, '');
            var nameMatch = searchQ === '' || shortName.includes(searchQ) || fp.includes(searchQ);
            var pathMatch = pathQ === '' || fp.includes(pathQ);
            // ...but a box also stays when something inside it is still on
            // screen, or the match would lose the box it is drawn in.
            var shownKid = n.children().filter(function (c) {
                return c.style('display') !== 'none';
            }).length > 0;
            n.style('display', nameMatch && pathMatch || shownKid ? 'element' : 'none');
            return;
        }

        // ── Symbol nodes: check ALL filters in order ──

        // 1. Any parent container collapsed?
        if (hasCollapsedAncestor(n)) { n.style('display', 'none'); return; }

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

    // A collapse changes which edges exist: hand the hidden children's edges
    // to their box, then re-apply focus (only when that actually changed —
    // a search keystroke must not rebuild the details panel).
    if (syncAggregatedEdges()) refreshFocus();

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

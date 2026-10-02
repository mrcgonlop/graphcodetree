// ── Focus / unfocus logic ───────────────────────────────────────────
// Focusing answers one question: *what is connected to this node?* So the
// highlight is built from the edges themselves and not from a depth
// heuristic (depth says nothing about connectivity — a same-depth stranger
// used to be lit up while the neighbour in the next file stayed a ghost).
//
// Three sets, in the user's words:
//   • the focused node and everything joined to it by an edge — lit;
//   • the file/folder each of those lives in ("the file or folder they are
//     contained in", lowest container level only — deliberately not
//     propagated up the folder tree);
//   • everything else — dimmed *hard*, so the connected part reads as the
//     subject of the picture. Boxes are dimmed through their own drawing
//     alphas, never through `opacity`, which cytoscape multiplies into every
//     descendant and would take the lit symbols down with them (DIM_BOX_PROPS).
// Collapsed containers take part as themselves: an edge onto a collapsed box
// is an edge onto that box (see aggregate.js).
//
// The edges around the focused node are also re-coloured by direction —
// outgoing against incoming — because an arrow head is not something the eye
// can read when twenty of them meet the same node (DIRECTION_COLORS).

import { S } from './state.js';
import { DIRECTION_COLORS } from './constants.js';
import { representativeOf } from './aggregate.js';
import { showDetails } from './details.js';

/// Unrelated nodes/edges. Well below the old depth-based 0.12/0.3/0.55 — the
/// point of focus is that the connected part pops.
const DIM = 0.06;
const DIM_EDGE = 0.04;
/// An edge between two connected nodes that is not itself incident on the
/// focused node (the neighbour's other relationships: visible, but secondary).
const EDGE_NEAR = 0.45;
/// How a dimmed *box* is dimmed: through its own drawing alphas, never through
/// `opacity`. cytoscape's effectiveOpacity() multiplies every ancestor's
/// opacity into the element's, so dimming a folder that way also dimmed the
/// lit symbols inside it — their circles faded while their DOM labels (which
/// read the node's own opacity) stayed bright. `text-opacity` carries the dim
/// of the box's own label to the overlay (see overlay.js).
const DIM_BOX_PROPS = ['background-opacity', 'border-opacity', 'text-opacity'];
/// Neighbour ring colour, shared with the `:selected` highlight.
const HIGHLIGHT = '#e0af68';

/// Ids of the containers to light along with `nearby` (one level only).
function containersOf(nearby) {
    const out = new Set();
    nearby.forEach(function (nid) {
        const n = S.cy.getElementById(nid);
        if (!n || n.length === 0) return;
        if (n.data('_isContainer')) { out.add(n.id()); return; }
        const p = n.parent();
        if (p && p.length > 0 && !nearby.has(p.id())) out.add(p.id());
    });
    return out;
}

export function focusNode(id) {
    if (!S.cy) return;
    const node = S.cy.getElementById(id);
    if (!node || node.length === 0) return;
    S.focusedNodeId = id;

    try {
        // A focused node that is hidden inside a collapsed box is stood in for
        // by the box: that is all the user can see of it.
        const anchor = representativeOf(node);
        const anchorId = anchor.id();
        const allNodes = S.cy.nodes();
        const allEdges = S.cy.edges();

        // ── 1. the focused node + everything joined to it by an edge ──
        const nearby = new Set([anchorId]);
        allEdges.forEach(function (e) {
            const s = e.source().id(), t = e.target().id();
            if (s === anchorId || t === anchorId) { nearby.add(s); nearby.add(t); }
        });

        // ── 2. the lowest container of each of those ──
        const containers = containersOf(nearby);
        const lit = new Set([...nearby, ...containers]);

        // ── 3. dim everything else ──
        // Back to the stylesheet first: the dim below *multiplies* the base
        // alphas, so a re-focus (a collapse can change the edges) must not
        // compound them. Same for the direction colours: an edge that stops
        // touching the focused node has to get its tag colour back.
        allNodes.forEach(function (n) {
            n.removeStyle('opacity');
            if (n.data('_isContainer')) n.removeStyle(DIM_BOX_PROPS.join(' '));
        });
        allEdges.forEach(function (e) {
            e.removeStyle('line-color');
        });

        allNodes.forEach(function (n) {
            if (lit.has(n.id())) {
                // Ring the connected nodes (the boxes keep their own border)
                // so "connected" is unmistakable.
                if (!n.data('_isContainer')) n.style('border-color', HIGHLIGHT);
                return;   // the reset above left it at full strength
            }
            if (n.data('_isContainer')) {
                // Its own alphas only — `opacity` here would cascade into
                // every symbol inside the box (see DIM_BOX_PROPS).
                DIM_BOX_PROPS.forEach(function (p) {
                    n.style(p, (Number(n.style(p)) || 0) * DIM);
                });
            } else {
                n.style('opacity', DIM);
            }
        });

        allEdges.forEach(function (e) {
            const s = e.source().id(), t = e.target().id();
            const incident = s === anchorId || t === anchorId;
            const between = nearby.has(s) && nearby.has(t);
            e.style('opacity', incident ? 1 : (between ? EDGE_NEAR : DIM_EDGE));
            // Direction is what an arrow head is too small to say, so the
            // focused node's own edges are re-coloured by it: everything
            // leaving the node against everything arriving at it. The tag is
            // not lost — it is still the line style and the width, and the
            // details panel spells both out.
            if (incident) e.style('line-color', s === anchorId ? DIRECTION_COLORS.out : DIRECTION_COLORS.in);
        });

        document.getElementById('focus-indicator').classList.add('visible');
        const shown = anchorId === id ? node : anchor;
        document.getElementById('focus-label').textContent = shown.data('label') || id;
        showDetails(shown.data());
    } catch (e) {
        console.warn('focusNode error:', e);
        return;
    }

    if (S.labelOverlay) S.labelOverlay.positionUpdate();
}

export function unfocusAll() {
    if (!S.cy) return;
    S.focusedNodeId = null;
    try {
        S.cy.nodes().forEach(function (n) {
            // Back to the stylesheet values: containers keep whatever their
            // own state says (a collapsed box's own border colour included).
            n.removeStyle('opacity');
            if (n.data('_isContainer')) n.removeStyle(DIM_BOX_PROPS.join(' '));
            if (!n.data('_isContainer')) n.removeStyle('border-color');
        });
        S.cy.edges().forEach(function (e) {
            e.style('opacity', 1);
            e.removeStyle('line-color');
        });
        document.getElementById('focus-indicator').classList.remove('visible');
        document.getElementById('node-details').innerHTML = '<div class="empty">Click a node to see details</div>';
    } catch (e) {
        console.warn('unfocusAll error:', e);
    }
    if (S.labelOverlay) S.labelOverlay.positionUpdate();
}

/// Re-apply the current focus — after a collapse changed which edges exist.
export function refreshFocus() {
    if (S.focusedNodeId) focusNode(S.focusedNodeId);
}

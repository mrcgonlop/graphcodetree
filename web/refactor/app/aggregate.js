// ── Aggregated edges for collapsed containers ────────────────────────
// Collapsing a file/folder hides the symbols inside it, and cytoscape never
// draws an edge whose endpoint is hidden — so a collapsed box used to swallow
// every edge its contents had. This module re-projects those edges onto
// whatever is still visible: an edge from a symbol inside a collapsed box to
// a symbol outside it is drawn from the *box* to that symbol, and an edge
// between two collapsed boxes is drawn box-to-box.
//
// Nothing is invented: every aggregate edge is a many-to-one summary of the
// base edges it stands for (it sums their weights, keeps the arrow flag and
// the first edge's colour) and it disappears as soon as the container is
// expanded again. The set of aggregate edges is a pure function of which
// containers are collapsed, so it is only recomputed when that changes;
// filters and search then only toggle each one's `display`.

import { S } from './state.js';

/// Id prefix, so aggregate edges can never collide with a real edge.
const AGG_PREFIX = 'agg:';
/// Separator between the two endpoint ids inside an aggregate edge id.
const SEP = '\u0001';

// The aggregate edges currently in the graph, and the collapsed set they
// were built for. `_cy` guards against a scene rebuild (render() destroys the
// whole cytoscape instance, so a stale cache would otherwise claim the new
// graph already has its aggregate edges).
let _cy = null;
let _collapsedKey = null;
let _edges = null;

/// The element that stands in for `node` on screen: its *outermost* collapsed
/// ancestor, or the node itself when nothing above it is collapsed.
///
/// Outermost (not nearest) is what makes the result stable: if a file is
/// collapsed inside a collapsed folder, the folder is what is drawn, and the
/// file must not become an endpoint of an edge that is not on screen.
export function representativeOf(node) {
    if (!node || node.length === 0) return node;
    let rep = node;
    let p = node.parent();
    let guard = 0;
    while (p && p.length > 0 && guard++ < 64) {
        if (p.data('_collapsed')) rep = p;
        p = p.parent();
    }
    return rep;
}

/// True when the element is actually drawn: neither it nor any ancestor is
/// hidden. `style('display')` alone is not enough — cytoscape leaves a child's
/// own display value at `element` when a parent is hidden.
export function isShown(ele) {
    if (!ele || ele.length === 0) return false;
    if (ele.style('display') === 'none') return false;
    let p = ele.parent();
    let guard = 0;
    while (p && p.length > 0 && guard++ < 64) {
        if (p.style('display') === 'none') return false;
        p = p.parent();
    }
    return true;
}

/// Signature of the current collapsed set (order-independent).
function collapsedKey() {
    const ids = [];
    S.cy.nodes().forEach(function (n) {
        if (n.data('_isContainer') && n.data('_collapsed')) ids.push(n.id());
    });
    ids.sort();
    return ids.join('|');
}

/// Drop every aggregate edge and forget what set it was built for.
function clearEdges() {
    if (_edges && _edges.length) {
        try { S.cy.remove(_edges); } catch (e) { /* already gone */ }
    }
    _edges = null;
    _collapsedKey = null;
}

/// Rebuild the aggregate set for the collapsed containers in `key`.
function buildEdges(key) {
    clearEdges();
    _collapsedKey = key;
    if (!key) return;   // nothing collapsed: every base edge is drawn directly

    const repCache = new Map();
    function rep(node) {
        const id = node.id();
        let r = repCache.get(id);
        if (!r) { r = representativeOf(node); repCache.set(id, r); }
        return r;
    }

    // Fold the base edges onto their visible representatives.
    const groups = new Map();
    S.cy.edges().forEach(function (e) {
        if (e.data('_agg')) return;
        const s = rep(e.source());
        const t = rep(e.target());
        if (!s || !t) return;
        if (s.id() === t.id()) return;   // entirely inside one collapsed box
        const key2 = s.id() + SEP + t.id();
        let g = groups.get(key2);
        if (!g) {
            g = { source: s.id(), target: t.id(), weight: 0, count: 0, arrow: false, kinds: [], color: e.data('color') };
            groups.set(key2, g);
        }
        g.weight += e.data('weight') || 1;
        g.count++;
        g.arrow = g.arrow || !!e.data('arrow');
        const kind = e.data('kind');
        if (g.kinds.indexOf(kind) < 0) g.kinds.push(kind);
    });

    const specs = [];
    groups.forEach(function (g, k) {
        specs.push({
            group: 'edges',
            data: {
                id: AGG_PREFIX + k.replace(SEP, '->'),
                source: g.source,
                target: g.target,
                kind: g.kinds.length === 1 ? g.kinds[0] : 'aggregate',
                weight: g.weight,
                color: g.color,
                edgeWidth: Math.min(6, 1.5 + g.weight * 0.3),
                arrow: g.arrow,
                _agg: true,
                _aggCount: g.count,
                _aggKinds: g.kinds.join(','),
            },
        });
    });
    if (specs.length) _edges = S.cy.add(specs);
}

/// Bring the aggregate edges in line with the current collapse + filter state.
/// Called by refreshVisibility() after the node pass, so it sees final
/// `display` values. Returns true when the collapsed set changed (i.e. the
/// graph's edge set changed, so focus may need re-applying).
export function syncAggregatedEdges() {
    if (!S.cy) return;
    if (_cy !== S.cy) { _cy = S.cy; clearEdges(); }

    const key = collapsedKey();
    let rebuilt = false;
    if (key !== _collapsedKey) { buildEdges(key); rebuilt = true; }

    if (_edges && _edges.length) {
        _edges.forEach(function (e) {
            e.style('display', isShown(e.source()) && isShown(e.target()) ? 'element' : 'none');
        });
    }
    return rebuilt;
}

/// Forget the cache (used when the scene is about to be rebuilt).
export function resetAggregatedEdges() {
    _cy = null;
    _edges = null;
    _collapsedKey = null;
}

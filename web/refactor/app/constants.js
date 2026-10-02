// ── Color maps and ordering ──────────────────────────────────────────

export const KIND_COLORS = {
    function: '#7aa2f7',
    method: '#7aa2f7',
    struct: '#9ece6a',
    enum: '#bb9af7',
    enum_variant: '#bb9af7',
    trait: '#f7768e',
    impl_block: '#e0af68',
    module: '#2ac3de',
    constant: '#ff9e64',
    static: '#ff9e64',
    type_alias: '#73daca',
    macro: '#f7768e',
    field: '#565f89',
    file: '#414868',
};

export const EDGE_COLORS = {
    calls: { color: '#7aa2f7', width: 2, style: 'solid', arrow: true },
    defines: { color: '#565f89', width: 1, style: 'dotted', arrow: false },
    contains: { color: '#414868', width: 1.5, style: 'solid', arrow: false },
    imports: { color: '#73daca', width: 1.5, style: 'dashed', arrow: false },
    implements: { color: '#f7768e', width: 2, style: 'dashed', arrow: true },
    data_flow: { color: '#ff9e64', width: 2, style: 'solid', arrow: true },
    references: { color: '#bb9af7', width: 1, style: 'dashed', arrow: false },
    inherits: { color: '#e0af68', width: 1.5, style: 'dotted', arrow: false },
    extends: { color: '#9ece6a', width: 1, style: 'dotted', arrow: false },
};

// ── Edge direction ──────────────────────────────────────────────────
// A tag says *what kind of relation* an edge is; direction says which way it
// runs. Two `calls` edges on the same picture used to be indistinguishable
// apart from an 8px arrow head, which is useless when the question is "what
// does this call?" against "who calls this?".
//
// So while a node is focused, the edges touching it are recoloured by
// direction — outgoing in light cyan, incoming in pink — and the tag stays
// readable from the line style/width (see focus.js) and from the details
// panel, which labels the two groups with the same colours (details.js).
//
// The incoming hue is deliberately the same pink `implements` edges use: every
// warm hue in the palette is already some tag, and `#f7768e` is the one whose
// tag (`implements`, 10 edges in this snapshot) is rare enough not to compete.
// A pink *tag* edge sitting next to a pink *incoming* edge is the one case the
// colour alone cannot separate — the arrow head and the legend still do, and
// the harness pins that a focus/unfocus round trip restores every edge's own
// colour exactly.
export const DIRECTION_COLORS = {
    out: '#7dcfff',
    in: '#f7768e',
};

/// How a direction is worded and drawn in the details panel.
export const DIRECTION_NAMES = { out: 'Outgoing', in: 'Incoming' };
export const DIRECTION_ARROWS = { out: '\u2192', in: '\u2190' };

// ── Node geometry shared with the layout engine ─────────────────────
// cytoscape draws a node's border *outside* the width it is given, and a
// compound node's border outside its padding, so these widths are part of
// the geometry: hierarchy.js predicts a box's size from them (symbol =
// nodeSize + symbol border, box = children + 2*(padding + border)). Kept
// here so the stylesheet (main.js) and the engine (layout.js) can never
// disagree about what a node measures.
export const BORDERS = {
    symbol: 2,
    file: 1.5,
    folder: 2,
    // Selection highlight. cytoscape draws this outside the border, so a
    // selected node is 2u wider than the engine's model for it — positions
    // do not depend on it (nothing re-measures), but it is why a selected
    // node can look 1u snugger against its neighbours.
    select: 3,
};

export const KIND_ORDER = [
    'function', 'method', 'struct', 'enum', 'enum_variant',
    'trait', 'impl_block', 'module', 'type_alias',
    'constant', 'static', 'macro', 'field',
];

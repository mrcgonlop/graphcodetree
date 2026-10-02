// ── Shared mutable state ─────────────────────────────────────────────
// All modules import this to read/write runtime state.

/// Factory for the tunable sizing/layout parameters, so "Reset params"
/// can restore a pristine copy without sharing object references.
///
/// IMPORTANT: `layout` only contains options the core `cose` layout
/// actually reads (verified against cytoscape
/// src/extensions/layout/cose.mjs). cose has NO `gravityRange`,
/// `gravityCompound` or `gravityRangeCompound` — those belong to
/// cose-bilkent and were silently ignored here.
function defaultParams() {
    return {
        // Node / container sizing — applied to styles instantly.
        nodeSize: 40,
        containerPadding: 15,
        folderPadding: 20,

        // Which layout engine to run (see layout.js):
        //   'hierarchy'    → deterministic containment tree (default). It is
        //                    the only engine that keeps a box around its own
        //                    children, which is what makes a nested snapshot
        //                    readable at all.
        //   'cose'         → force-directed (core cose)
        //   'grid'         → cytoscape built-in grid
        //   'breadthfirst' → cytoscape built-in tree layout
        engine: 'hierarchy',

        // Geometry of the 'hierarchy' engine, in model units.
        //   node gaps  → breathing room between symbols inside a file box
        //   col/row gap→ breathing room between sibling boxes (the row gap
        //                must also leave room for a box's title above it)
        //   aspect     → target width/height of any packed block
        hierNodeGapX: 24,
        hierNodeGapY: 28,
        hierColGap: 36,
        hierRowGap: 64,
        hierAspect: 1.7,

        // Detail level of the compound tree (see builder.js):
        //   'full'  -> folder → file → symbol   (deepest, hardest to read)
        //   'files' -> file → symbol
        //   'flat'  -> symbols only             (no compound forces at all)
        detail: 'full',

        // Draw symbol labels as native Cytoscape labels (scale with zoom)
        // instead of fixed-px DOM overlays. Fixes the node:text proportion
        // mismatch when the layout is zoomed out.
        nativeLabels: false,

        // cose layout parameters. Defaults = cose's own, where a sane
        // layout lives. The equilibrium distance between nodes is
        //   d ≈ sqrt(nodeRepulsion / gravity)
        // so repulsion 400000 with gravity 0.2 (the previous values)
        // spread the graph ≈31× wider than the library default.
        layout: {
            repulsion: 2048,      // nodeRepulsion (cose default 2048)
            containerRatio: 4,    // container repulsion = repulsion × ratio
            gravity: 1,           // gravity (cose default 1)
            idealEdgeLength: 60,  // cose default 32
            edgeElasticity: 32,   // cose default 32
            nestingFactor: 1.2,   // cose default 1.2
            componentSpacing: 40, // cose default 40
            nodeOverlap: 4,       // cose default 4
            numIter: 1000,        // cose default 1000
            layoutPadding: 30,    // cose default 30
            initialTemp: 1000,
            coolingFactor: 0.99,
            minTemp: 1,
            randomize: false,
        },

        // Post-layout "push overlapping containers apart" pass.
        // OFF by default: it treats every nested container as an overlap
        // (a child box is always inside its parent's box) so it can never
        // converge and instead yanks containers around.
        boxLayoutEnabled: false,
        boxLayoutPad: 20,
        boxLayoutIter: 8,
    };
}

export const S = Object.assign({
    snapshot: null,         // raw snapshot data from graph.json
    cy: null,               // Cytoscape instance
    focusedNodeId: null,    // currently focused node id or null
    currentFontSize: 10,    // current label font size (px)
    selectedMaxDepth: null, // depth filter: null = "All", else integer
    labelOverlay: null,     // { build, render, updatePositions, positionUpdate }
    autoRelayout: false,    // re-run cose (debounced) while dragging layout sliders
    rebuild: null,          // set by main.js: rebuild the scene (detail change)
    hierarchyStats: null,   // last 'hierarchy' engine summary (for the HUD)
}, defaultParams());

/// Restore every tunable parameter to its factory default.
export function resetParams() {
    Object.assign(S, defaultParams());
}

/// Named parameter sets, so a whole regime can be jumped to at once.
/// A preset may set layout params *and* higher-level state (`engine`,
/// `detail`, tree geometry) — `applyPreset` routes each key to wherever it
/// already lives. The first two are the two usable regimes; the last one
/// reproduces the original shipping configuration for comparison.
export const PRESETS = {
    // Deterministic containment tree, packed tight.
    'tree (compact)': {
        engine: 'hierarchy', detail: 'full',
        hierNodeGapX: 16, hierNodeGapY: 20, hierColGap: 28, hierRowGap: 48, hierAspect: 1.7,
    },
    // Same tree, with room for long labels and titles.
    'tree (roomy)': {
        engine: 'hierarchy', detail: 'full',
        hierNodeGapX: 44, hierNodeGapY: 52, hierColGap: 64, hierRowGap: 120, hierAspect: 1.45,
    },
    'cose defaults': { engine: 'cose', repulsion: 2048, containerRatio: 1, gravity: 1, idealEdgeLength: 32, edgeElasticity: 32, nestingFactor: 1.2, componentSpacing: 40, nodeOverlap: 4, numIter: 1000 },
    'tight': { engine: 'cose', repulsion: 2048, containerRatio: 2, gravity: 2, idealEdgeLength: 40, edgeElasticity: 64, nestingFactor: 1.2, componentSpacing: 30, nodeOverlap: 8, numIter: 1000 },
    'loose / legacy bug': { engine: 'cose', repulsion: 400000, containerRatio: 20, gravity: 0.2, idealEdgeLength: 150, edgeElasticity: 32, nestingFactor: 1.2, componentSpacing: 40, nodeOverlap: 4, numIter: 800 },
};

/// Apply a named preset to the live state. Keys that belong to the layout
/// parameter block go there; the rest (`engine`, `detail`, tree geometry)
/// are top-level state.
export function applyPreset(name) {
    const p = PRESETS[name];
    if (!p) return false;
    for (const k in p) {
        if (Object.prototype.hasOwnProperty.call(S.layout, k)) S.layout[k] = p[k];
        else S[k] = p[k];
    }
    return true;
}


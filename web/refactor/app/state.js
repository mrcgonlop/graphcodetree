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
        //   'hierarchy'    → deterministic containment tree. It is the only
        //                    engine that keeps a box around its own children,
        //                    which is what makes a nested snapshot readable at
        //                    all, so it is the one the app ships with.
        //   'cose'         → force-directed (core cose)
        //   'grid'         → cytoscape built-in grid
        //   'breadthfirst' → cytoscape built-in tree layout
        // The three alternatives are reachable from the test harnesses only:
        // the sidebar no longer offers them (they scatter the boxes, which
        // undoes the hierarchy the whole view is built on).
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

        // Show the line each definition starts on next to its label
        // (`emit_def:412`). The extractor has always emitted a span per node —
        // the view just stopped showing it, so this brings it back in both
        // label modes: the DOM overlay appends it, and native labels switch to
        // `data(labelLine)` (builder.js builds it, controls.js picks it).
        showLineNumbers: true,

        // Parameters of the alternative engines, kept because layout.js's
        // cose branch still reads them and the harnesses still drive them —
        // but no longer exposed in the sidebar: the graph is sorted by the
        // containment tree, and cose forces only made a mess of that.
        // Defaults = cose's own, where a sane
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
    };
}

export const S = Object.assign({
    snapshot: null,         // raw snapshot data from graph.json
    cy: null,               // Cytoscape instance
    focusedNodeId: null,    // currently focused node id or null
    currentFontSize: 10,    // current label font size (px)
    selectedMaxDepth: null, // depth filter: null = "All", else integer
    labelOverlay: null,     // { build, render, updatePositions, positionUpdate, sync }
    rebuild: null,          // set by main.js: rebuild the scene (detail change)
    hierarchyStats: null,   // last 'hierarchy' engine summary (for the HUD)
}, defaultParams());

/// Restore every tunable parameter to its factory default.
export function resetParams() {
    Object.assign(S, defaultParams());
}

/// Named parameter sets, so a whole regime can be jumped to at once.
/// A preset may set layout params *and* higher-level state (`detail`, tree
/// geometry) — `applyPreset` routes each key to wherever it already lives.
///
/// Only regimes that keep the containment hierarchy are offered: the old
/// `cose`/`tight`/`loose` presets pinned the boxes to force-directed
/// positions, which is exactly the arrangement this view exists to replace.
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


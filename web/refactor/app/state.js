// ── Shared mutable state ─────────────────────────────────────────────
// All modules import this to read/write runtime state.

export const S = {
    snapshot: null,         // raw snapshot data from graph.json
    cy: null,               // Cytoscape instance
    focusedNodeId: null,    // currently focused node id or null
    currentFontSize: 10,    // current label font size (px)
    selectedMaxDepth: null, // depth filter: null = "All", else integer
    labelOverlay: null,     // { build, render, updatePositions, positionUpdate }
};

// ── Layout construction / execution ─────────────────────────────────
// Builds layout options from the live `S.layout` state, and exposes the
// derived numbers (equilibrium spacing) that actually predict the visual
// scale — so a slider change can be reasoned about instead of guessed.
//
// Engines: 'cose' | 'grid' | 'breadthfirst' come from cytoscape itself;
// 'hierarchy' is our own deterministic containment engine, implemented in
// hierarchy.js and registered (in main.js) as a normal cytoscape layout.

import { S } from './state.js';
import { BORDERS } from './constants.js';
import { scheduleBoxLayout } from './visibility.js';

/// Effective node repulsion for leaf symbols.
export function nodeRepulsionValue() { return S.layout.repulsion; }

/// Effective node repulsion for compound containers (folders/files).
export function containerRepulsionValue() {
    return S.layout.repulsion * S.layout.containerRatio;
}

/// cose's force balance: repulsion falls off as R/d², gravity is a
/// constant g toward the centre, so nodes settle at d ≈ sqrt(R/g).
/// This single number explains the scale of the rendered graph.
export function estimateSpacing() {
    const g = Math.max(S.layout.gravity, 0.001);
    return Math.sqrt(S.layout.repulsion / g);
}

/// Translate the current state into layout options.
/// Only real cose options are emitted (see state.js note); the 'hierarchy'
/// engine gets its own geometry options, read by hierarchy.js.
export function buildLayoutOptions() {
    const L = S.layout;

    if (S.engine === 'hierarchy') {
        return {
            name: 'hierarchy',
            animate: false,
            fit: true,
            padding: L.layoutPadding,
            // Sizing/padding must match what the stylesheet applies, since
            // the engine predicts each box from its children's size. The
            // border widths are style values too: cytoscape draws a node's
            // border outside its width and a box's border around its padding,
            // so both are part of the geometry (see the sizing probe in
            // validate.mjs). They come from constants.BORDERS, which is the
            // same object main.js's stylesheet reads.
            nodeSize: S.nodeSize,
            filePad: S.containerPadding,
            folderPad: S.folderPadding,
            symbolBorder: BORDERS.symbol,
            fileBorder: BORDERS.file,
            folderBorder: BORDERS.folder,
            nodeGapX: S.hierNodeGapX,
            nodeGapY: S.hierNodeGapY,
            colGap: S.hierColGap,
            rowGap: S.hierRowGap,
            aspect: S.hierAspect,
        };
    }

    if (S.engine === 'grid') {
        return { name: 'grid', animate: false, avoidOverlap: true, condense: false, padding: L.layoutPadding, fit: true };
    }
    if (S.engine === 'breadthfirst') {
        return { name: 'breadthfirst', animate: false, directed: true, spacingFactor: 1.2, padding: L.layoutPadding, fit: true };
    }

    return {
        name: 'cose',
        animate: false,
        gravity: L.gravity,
        numIter: L.numIter,
        idealEdgeLength: L.idealEdgeLength,
        edgeElasticity: L.edgeElasticity,
        nestingFactor: L.nestingFactor,
        componentSpacing: L.componentSpacing,
        nodeOverlap: L.nodeOverlap,
        initialTemp: L.initialTemp,
        coolingFactor: L.coolingFactor,
        minTemp: L.minTemp,
        nodeRepulsion: function (node) {
            return node.data('_isContainer') ? containerRepulsionValue() : nodeRepulsionValue();
        },
        padding: L.layoutPadding,
        randomize: L.randomize,
        // Cover the label extent so text doesn't overlap in native mode.
        nodeDimensionsIncludeLabels: !!S.nativeLabels,
    };
}

/// Re-run the current layout, then refresh overlays + the box pass.
/// Every engine goes through the same path — `hierarchy` is registered as a
/// normal cytoscape layout (see hierarchy.js), so nothing here is special
/// cased and `.one('layoutstop', …)` behaves identically for all of them.
export function runLayout() {
    if (!S.cy) return null;
    const layout = S.cy.layout(buildLayoutOptions());
    layout.one('layoutstop', onLayoutStop);
    layout.run();
    return layout;
}

function onLayoutStop() {
    try {
        if (S.labelOverlay) S.labelOverlay.updatePositions();
    } catch (e) {
        console.warn('layoutstop overlay refresh error:', e);
    }
    scheduleBoxLayout();
    setTimeout(function () {
        scheduleBoxLayout();
        if (S.cy) S.cy.fit(S.cy.elements(), 50);
    }, 100);
}


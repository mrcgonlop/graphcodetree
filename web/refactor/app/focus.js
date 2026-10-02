// ── Focus / unfocus logic ───────────────────────────────────────────

import { S } from './state.js';
import { showDetails } from './details.js';

export function focusNode(id) {
    if (!S.cy) return;
    const node = S.cy.getElementById(id);
    if (!node || node.length === 0) return;
    S.focusedNodeId = id;

    try {
        const allNodes = S.cy.nodes();
        const allEdges = S.cy.edges();
        const focusDepth = node.data('depth') || 0;

        allNodes.forEach(function (n) {
            if (n.data('_isContainer')) return;
            const nDepth = n.data('depth') || 0;
            const depthDiff = Math.abs(nDepth - focusDepth);
            let opacity;
            if (n.id() === id) {
                opacity = 1.0;
            } else if (depthDiff === 0) {
                opacity = 0.55;
            } else if (depthDiff === 1) {
                opacity = 0.3;
            } else {
                opacity = 0.12;
            }
            n.style({ opacity: opacity, 'border-opacity': opacity * 0.8 });
        });

        allEdges.forEach(function (e) {
            const src = e.source(), tgt = e.target();
            const connected = src.id() === id || tgt.id() === id;
            const sameCluster = !connected && (Math.abs((src.data('depth') || 0) - focusDepth) <= 1) &&
                (Math.abs((tgt.data('depth') || 0) - focusDepth) <= 1);
            const opacity = connected ? 0.7 : (sameCluster ? 0.3 : 0.06);
            e.style({ opacity: opacity, 'target-arrow-opacity': opacity });
        });

        document.getElementById('focus-indicator').classList.add('visible');
        document.getElementById('focus-label').textContent = node.data('label') || id;
    } catch (e) {
        console.warn('focusNode error:', e);
        return;
    }

    showDetails(node.data());
    if (S.labelOverlay) S.labelOverlay.positionUpdate();
}

export function unfocusAll() {
    if (!S.cy) return;
    S.focusedNodeId = null;
    try {
        S.cy.nodes().forEach(function (n) {
            if (n.data('_isContainer')) return;
            n.style({ opacity: 1.0, 'border-opacity': 0.8 });
        });
        S.cy.edges().forEach(function (e) {
            e.style({ opacity: 1.0, 'target-arrow-opacity': 1.0 });
        });
        document.getElementById('focus-indicator').classList.remove('visible');
        document.getElementById('node-details').innerHTML = '<div class="empty">Click a node to see details</div>';
    } catch (e) {
        console.warn('unfocusAll error:', e);
    }
    if (S.labelOverlay) S.labelOverlay.positionUpdate();
}

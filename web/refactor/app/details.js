// ── Details panel rendering ─────────────────────────────────────────

import { esc } from './utils.js';
import { KIND_COLORS, EDGE_COLORS } from './constants.js';
import { S } from './state.js';

// Focus callback — set by main.js to break circular dep with focus.js
let _onFocus = null;
export function setFocusHandler(fn) { _onFocus = fn; }

export function showDetails(data) {
    const el = document.getElementById('node-details');
    if (!data) { el.innerHTML = '<div class="empty">Click a node to see details</div>'; return; }

    let html = '';

    // ── File-group parent ──
    if (data._isContainer) {
        html += '<div><span class="node-kind kind-' + (data._isFolder ? 'module' : 'file') + '">' + esc(data._filePath.replace(/^.*[\\\\/]/, '')) + '</span></div>';
        html += '<div class="node-file">' + esc(data._filePath) + '</div>';
        html += '<div class="node-attrs">' + data._nodeCount + ' items' + (data._collapsible ? ' \u00B7 click to collapse' : '') + '</div>';

        if (S.cy) {
            var isFolder = data._isFolder;
            var memberNodes;
            if (isFolder) {
                var folderId = data.id;
                memberNodes = S.cy.nodes().filter(function (n) {
                    return n.data('parent') === folderId;
                });
                html += '<div class="edge-list"><h4>Contents (' + memberNodes.length + ')</h4>';
            } else {
                memberNodes = S.cy.nodes().filter(function (n) {
                    return !n.data('_isContainer') && n.data('file') === data._filePath;
                });
                html += '<div class="edge-list"><h4>Symbols (' + memberNodes.length + ')</h4>';
            }
            memberNodes.forEach(function (mn) {
                var mnKind = mn.data('kind') || (mn.data('_isFolder') ? 'folder' : (mn.data('_isFileContainer') ? 'file' : '?'));
                var mnLabel = mn.data('label') || mn.data('_filePath') || '';
                var mnColor = mn.data('_isFolder') ? '#737aa2' : (mn.data('_isFileContainer') ? '#565f89' : (KIND_COLORS[mn.data('kind')] || '#565f89'));
                var hint = mn.data('_collapsible') ? (mn.data('_collapsed') ? ' [+' : ' [\u2212') : '';
                html += '<div class="clickable-edge" data-id="' + esc(mn.id()) + '" style="padding:2px 0;color:#a9b1d6;font-size:11px;cursor:pointer" title="Click to focus">';
                html += '<span style="color:' + mnColor + '">' + esc(mnKind) + '</span>  ';
                html += esc(mnLabel) + hint;
                html += '</div>';
            });
            html += '</div>';
        }

        el.innerHTML = html;
        wireClickableEdges(el);
        return;
    }

    // ── Regular symbol node ──
    html += '<div><span class="node-kind' + (data.kind ? ' kind-' + data.kind : '') + '">' + esc(data.kind || 'symbol') + '</span></div>';
    html += '<div class="node-label">' + esc(data.label || data.qualifiedName || data.id) + '</div>';
    html += '<div class="node-signature">' + esc(data.qualifiedName || '') + '</div>';
    html += '<div class="node-file">' + esc(data.file || '') + '</div>';
    if (data.doc) html += '<div class="node-doc"> \u201C' + esc(data.doc) + '\u201D</div>';

    if (S.cy) {
        const nodeRef = S.cy.getElementById(data.id);
        if (nodeRef && nodeRef.length > 0) {
            const connected = nodeRef.connectedEdges();
            if (connected.length > 0) {
                html += '<div class="edge-list"><h4>Edges (' + connected.length + ')</h4>';
                connected.forEach(function (e) {
                    const other = e.source().id() === data.id ? e.target() : e.source();
                    const dir = e.source().id() === data.id ? '\u2192' : '\u2190';
                    const edgeColor = EDGE_COLORS[e.data('kind')] ? EDGE_COLORS[e.data('kind')].color : '#bb9af7';
                    html += '<div class="clickable-edge" data-id="' + esc(other.id()) + '" style="padding:3px 0;color:#a9b1d6;font-size:11px;cursor:pointer;border-radius:3px;transition:background 0.15s" title="Click to focus">';
                    html += '<span style="color:' + edgeColor + ';font-weight:600">' + esc(e.data('kind')) + '</span> ' + dir + ' <span style="color:#7aa2f7">' + esc(other.data('label')) + '</span>';
                    html += '</div>';
                });
                html += '</div>';
            }
        }
    }

    el.innerHTML = html;
    wireClickableEdges(el);
}

/// Wire up clickable `.clickable-edge` items to focus the referenced node.
export function wireClickableEdges(parentEl) {
    if (!parentEl) return;
    try {
        parentEl.querySelectorAll('.clickable-edge').forEach(function (el) {
            el.addEventListener('click', function () {
                var targetId = this.dataset.id;
                if (targetId && _onFocus) _onFocus(targetId);
            });
            el.addEventListener('mouseenter', function () { this.style.background = '#292e42'; });
            el.addEventListener('mouseleave', function () { this.style.background = 'transparent'; });
        });
    } catch (e) {
        console.warn('wireClickableEdges error:', e);
    }
}

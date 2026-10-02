// ── Details panel rendering ─────────────────────────────────────────

import { esc, addressOf, relPath } from './utils.js';
import { KIND_COLORS, EDGE_COLORS, DIRECTION_COLORS, DIRECTION_NAMES, DIRECTION_ARROWS } from './constants.js';
import { S } from './state.js';

// Focus callback — set by main.js to break circular dep with focus.js
let _onFocus = null;
export function setFocusHandler(fn) { _onFocus = fn; }

// ── Reading a node's extracted metadata ─────────────────────────────
// Everything below comes straight off the snapshot: the span the extractor
// recorded (line/col/bytes), the signature it rebuilt from the syntax tree,
// the doc comment, the visibility. The panel is where all of it is worth
// showing at full size, which is why a node is described here in more detail
// than a label or a tooltip could afford.

/// `lines 103–105`, `line 103`, or '' when the node carries no span.
function lineRange(data) {
    if (data.line === null || data.line === undefined) return '';
    const hi = (data.endLine && data.endLine !== data.line) ? '\u2013' + data.endLine : '';
    return (hi ? 'lines ' : 'line ') + data.line + hi;
}

/// `  [4271–4284]` — the byte range, the locator that cannot be off by one.
function byteRange(data) {
    if (data.startByte === null || data.startByte === undefined) return '';
    if (data.endByte === null || data.endByte === undefined) return '';
    return '  [' + data.startByte + '\u2013' + data.endByte + ']';
}

/// The edges touching `data`, split by the way they run *relative to it*.
/// This is the same split the canvas draws — outgoing in light cyan, incoming
/// in pink (DIRECTION_COLORS) — so a colour just seen on the graph is named in
/// words here, and the tag, which the colour had to give up, is printed beside
/// it. An edge between two *other* nodes is not a connection of this one and
/// does not appear.
function edgeGroups(data) {
    const groups = { out: [], in: [] };
    if (!S.cy) return groups;
    const nodeRef = S.cy.getElementById(data.id);
    if (!nodeRef || nodeRef.length === 0) return groups;
    nodeRef.connectedEdges().forEach(function (e) {
        const s = e.source().id(), t = e.target().id();
        if (s === t) return;                                    // self-loop: no direction
        if (s === data.id) groups.out.push({ edge: e, other: e.target() });
        else if (t === data.id) groups.in.push({ edge: e, other: e.source() });
    });
    return groups;
}

/// One `tag → other :line` row, clickable to focus the other end. An aggregate
/// edge — a collapsed box's stand-in for many edges — says how many it stands
/// for and keeps the tags it folded together.
function edgeRow(row, dir) {
    const e = row.edge, other = row.other;
    const agg = !!e.data('_agg');
    const kind = agg ? (e.data('_aggKinds') || e.data('kind')) : e.data('kind');
    const kindColor = agg ? '#565f89' : ((EDGE_COLORS[e.data('kind')] || {}).color || '#bb9af7');
    const locus = (e.data('line') ? ':' + e.data('line') : '') + (agg ? ' \u00B7 \u00D7' + (e.data('_aggCount') || 1) : '');
    let html = '<div class="clickable-edge" data-id="' + esc(other.id()) + '" title="Click to focus">';
    html += '<span class="edge-kind" style="color:' + kindColor + '">' + esc(kind) + '</span>';
    html += '<span class="edge-arrow" style="color:' + DIRECTION_COLORS[dir] + '">' + DIRECTION_ARROWS[dir] + '</span>';
    html += '<span class="edge-other">' + esc(other.data('label') || other.id()) + '</span>';
    html += '<span class="edge-locus">' + esc(locus) + '</span>';
    return html + '</div>';
}

/// `→ Outgoing (7)` and its rows. The heading carries the direction colour, so
/// the two groups are told apart before a single row is read.
function edgeGroupHtml(groups, dir) {
    const rows = groups[dir];
    if (!rows.length) return '';
    let html = '<div class="edge-list"><h4 style="color:' + DIRECTION_COLORS[dir] + '">' +
        DIRECTION_ARROWS[dir] + ' ' + DIRECTION_NAMES[dir] + ' (' + rows.length + ')</h4>';
    rows.forEach(function (r) { html += edgeRow(r, dir); });
    return html + '</div>';
}

/// The members of a definition: struct fields, enum variants, the methods an
/// impl block defines. The snapshot spells them as `contains`/`defines` edges,
/// which is exactly "the class arguments" — and each one carries its own
/// signature and line, so the panel can list them without inventing anything.
/// It answers "what does this struct look like?" without having to hunt for
/// the field nodes on the canvas.
function memberRows(data) {
    const rows = [];
    if (!S.cy) return rows;
    const nodeRef = S.cy.getElementById(data.id);
    if (!nodeRef || nodeRef.length === 0) return rows;
    nodeRef.connectedEdges().forEach(function (e) {
        const kind = e.data('kind');
        if (kind !== 'contains' && kind !== 'defines') return;
        if (e.source().id() !== nodeRef.id()) return;      // only things *inside* this one
        const t = e.target();
        if (t.id() === nodeRef.id()) return;               // self-loop, i.e. itself
        rows.push(t);
    });
    rows.sort(function (a, b) { return (a.data('line') || 0) - (b.data('line') || 0); });
    return rows;
}

function memberListHtml(rows) {
    if (!rows.length) return '';
    const shown = rows.slice(0, 40);
    let html = '<div class="edge-list"><h4>Members (' + rows.length + ')</h4>';
    shown.forEach(function (n) {
        const d = n.data();
        html += '<div class="clickable-edge" data-id="' + esc(n.id()) + '" title="Click to focus">';
        html += '<span class="edge-kind" style="color:' + (KIND_COLORS[d.kind] || '#565f89') + '">' + esc(d.kind || '?') + '</span>';
        html += '<span class="edge-other">' + esc(d.label || '') + '</span>';
        html += '<span class="edge-locus">' + esc(d.line ? ':' + d.line : '') + '</span>';
        if (d.signature) html += '<div class="member-sig">' + esc(d.signature) + '</div>';
        html += '</div>';
    });
    if (rows.length > shown.length) html += '<div class="node-attrs">\u2026 ' + (rows.length - shown.length) + ' more</div>';
    return html + '</div>';
}

export function showDetails(data) {
    const el = document.getElementById('node-details');
    if (!data) { el.innerHTML = '<div class="empty">Click a node to see details</div>'; return; }

    let html = '';

    // ── File-group parent ──
    if (data._isContainer) {
        html += '<div><span class="node-kind kind-' + (data._isFolder ? 'module' : 'file') + '">' + esc(String(data._filePath || '').replace(/^.*[\\/]/, '') || 'root') + '</span></div>';
        html += '<div class="node-label">' + esc(data.label || '') + '</div>';
        html += '<div class="node-file">' + esc(relPath(data._filePath)) + '</div>';
        html += '<div class="node-attrs">' + data._nodeCount + ' items' +
            (lineRange(data) ? ' \u00B7 ' + lineRange(data) : '') +
            (data._collapsible ? ' \u00B7 click to collapse' : '') + '</div>';

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
                html += '<div class="clickable-edge" data-id="' + esc(mn.id()) + '" title="Click to focus">';
                html += '<span class="edge-kind" style="color:' + mnColor + '">' + esc(mnKind) + '</span>';
                html += '<span class="edge-other">' + esc(mnLabel) + hint + '</span>';
                html += '<span class="edge-locus">' + esc(mn.data('line') ? ':' + mn.data('line') : '') + '</span>';
                html += '</div>';
            });
            html += '</div>';

            // A collapsed box's connections are the aggregate edges standing in
            // for its contents, so they are split by direction exactly like a
            // symbol's are.
            var boxGroups = edgeGroups(data);
            html += edgeGroupHtml(boxGroups, 'out');
            html += edgeGroupHtml(boxGroups, 'in');
        }

        el.innerHTML = html;
        wireClickableEdges(el);
        return;
    }

    // ── Regular symbol node ──
    // What the extractor knows, in the order a reader wants it: what it is,
    // where it is, how it is written, what it is for, what is inside it and
    // what it is connected to.
    html += '<div><span class="node-kind' + (data.kind ? ' kind-' + data.kind : '') + '">' + esc(data.kind || 'symbol') + '</span></div>';
    html += '<div class="node-label">' + esc(data.label || data.qualifiedName || data.id) + '</div>';
    if (data.signature) html += '<div class="node-signature">' + esc(data.signature) + '</div>';
    html += '<div class="node-file">\uD83D\uDCC4 ' + esc(addressOf(data)) + byteRange(data) + '</div>';

    const facts = [];
    if (lineRange(data)) facts.push(lineRange(data));
    if (data.astKind) facts.push('ast: ' + data.astKind);
    if (facts.length) html += '<div class="node-attrs">' + esc(facts.join(' \u00B7 ')) + '</div>';
    const depth = data.depth || 0;
    html += '<div class="node-attrs">depth: ' + depth +
        (depth > 0 ? ' <span style="color:#565f89">' + '\u25B8'.repeat(depth) + '</span>' : ' (top-level)') + '</div>';
    if (data.visibility && data.visibility !== 'private') html += '<div class="node-attrs">visibility: ' + esc(data.visibility) + '</div>';
    if (data.qualifiedName && data.qualifiedName !== data.label) html += '<div class="node-attrs">qualified: ' + esc(data.qualifiedName) + '</div>';
    if (data.doc) html += '<div class="node-doc">\u201C' + esc(data.doc) + '\u201D</div>';

    if (S.cy) {
        html += memberListHtml(memberRows(data));
        const groups = edgeGroups(data);
        html += edgeGroupHtml(groups, 'out');
        html += edgeGroupHtml(groups, 'in');
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

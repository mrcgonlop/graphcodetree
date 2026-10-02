// ── Utility functions ────────────────────────────────────────────────

export function esc(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function nodeId(key) {
    if (!key || !key.key) return '?';
    var qn = key.qualified_name || key.qualifiedName || key.name || '';
    return (key.key === 'symbol' ? 'sym:' : 'def:') + (qn || '?') + (key.file ? '@' + key.file : '');
}

export function resolveToSymbol(keyRef) {
    if (!keyRef) return null;
    var cur = keyRef;
    while (cur.key !== 'symbol') {
        if (cur.key === 'anchored' && cur.ancestor) {
            cur = cur.ancestor;
        } else {
            break;
        }
    }
    return cur;
}

export function shortLabel(key) {
    var qn = key.qualified_name || key.qualifiedName || key.name || key.label || '';
    var parts = qn.split('::');
    return parts[parts.length - 1] || qn;
}

/// `crates/ir/src/node.rs` — the path as a reader would type it (the
/// extractor emits `.\\crates\\...`).
export function relPath(p) {
    return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

/// The address of a node: `crates/ir/src/node.rs:42:8`. The line is the one a
/// text editor shows (tree-sitter rows are 0-based; builder.js already turned
/// them into 1-based `line`/`col`), so the readers of this string — the details
/// panel, the label overlay's tooltip — never have to remember the off-by-one.
/// Falls back to the bare path for a node the snapshot gave no span for.
export function addressOf(data) {
    var p = relPath(data.file || data._filePath);
    if (data.line === null || data.line === undefined) return p;
    var col = (data.col === null || data.col === undefined) ? '' : ':' + data.col;
    return p + ':' + data.line + col;
}

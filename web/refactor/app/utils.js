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

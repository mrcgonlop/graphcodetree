// ── Hierarchical element builder ─────────────────────────────────────
// Reads the snapshot and produces { nodes, edges } for Cytoscape.
// Honors S.detail so the compound nesting can be peeled back one layer
// at a time:
//   'full'  → folder containers → file containers → symbols
//   'files' → file containers → symbols
//   'flat'  → symbols only (no compound nodes, pure graph)

import { nodeId, resolveToSymbol, shortLabel, relPath } from './utils.js';
import { KIND_COLORS, EDGE_COLORS } from './constants.js';
import { S } from './state.js';

/// Normalize `.\crates\x.rs` and `./crates/x.rs` to `crates/x.rs`.
/// The extractor emits Windows-style paths, and the leading `.` used to
/// become a phantom top-level folder in the tree.
function normPath(p) {
    return relPath(p || 'unknown');
}

// ── Spans ───────────────────────────────────────────────────────────
// Every node — and some edges — carries the byte/row/col span it was extracted
// from. `row` is 0-based (tree-sitter's Point), so a row only becomes the line
// an editor shows after +1, and that has to happen exactly once: here.
function lineOf(span) {
    return (span && span.start && isFinite(span.start.row)) ? span.start.row + 1 : null;
}
function endLineOf(span) {
    return (span && span.end && isFinite(span.end.row)) ? span.end.row + 1 : null;
}
function colOf(span) {
    return (span && span.start && isFinite(span.start.col)) ? span.start.col : null;
}
function byteOf(v) {
    return (v === null || v === undefined || !isFinite(v)) ? null : v;
}

/// Fold two line ranges into the range that covers both.
function widen(range, other) {
    if (!other) return range;
    if (!range) return { lo: other.lo, hi: other.hi };
    return { lo: Math.min(range.lo, other.lo), hi: Math.max(range.hi, other.hi) };
}

export function buildElements() {
    const snapshot = S.snapshot;
    if (!snapshot) return { nodes: [], edges: [] };

    const detail = S.detail || 'full';
    const useFolders = detail === 'full';
    const useFiles = detail !== 'flat';

    const nodes = [], edges = [], added = new Set();
    const fileSymbols = new Map();

    for (const n of snapshot.nodes) {
        if (!n.key || n.key.key !== 'symbol') continue;
        const id = nodeId(n.key);
        if (added.has(id)) continue;
        added.add(id);
        const file = normPath(n.file);
        if (!fileSymbols.has(file)) fileSymbols.set(file, []);
        const attrs = n.attrs || {};
        fileSymbols.get(file).push({
            id, key: n.key, kind: n.kind, depth: n.depth || 0,
            // Everything the extractor knows about the definition: how it is
            // written (`signature`), how it is described (`doc`), how visible it
            // is (`visibility`) and where it starts and ends (`line`/`col` plus
            // the byte range). All of it used to be dropped right here.
            doc: attrs.doc || null,
            signature: attrs.signature || null,
            visibility: attrs.visibility || null,
            astKind: n.ast_kind || null,
            line: lineOf(n.span), endLine: endLineOf(n.span), col: colOf(n.span),
            startByte: byteOf(n.span && n.span.start_byte),
            endByte: byteOf(n.span && n.span.end_byte),
        });
    }

    // The line range of each file, so a file box can answer "which lines am I?"
    // the same way a symbol can.
    const fileRange = new Map();
    fileSymbols.forEach(function (symbols, fp) {
        let r = null;
        for (const s of symbols) {
            if (s.line === null) continue;
            r = widen(r, { lo: s.line, hi: s.endLine === null ? s.line : s.endLine });
        }
        if (r) fileRange.set(fp, r);
    });

    function folderPart(fp) { const i = fp.lastIndexOf('/'); return i >= 0 ? fp.substring(0, i) : ''; }
    function fileName(fp) { return fp.replace(/^.*\//, ''); }

    // ── Folder tree (only for detail 'full') ──
    if (useFolders) {
        const folderMap = new Map();
        folderMap.set('', { parent: null, children: [], files: [] });
        for (const fp of fileSymbols.keys()) {
            const parts = fp.split('/');
            let acc = '';
            for (let i = 0; i < parts.length - 1; i++) {
                const parent = acc;
                acc = acc ? acc + '/' + parts[i] : parts[i];
                if (!folderMap.has(acc)) {
                    folderMap.set(acc, { parent, children: [], files: [] });
                    folderMap.get(parent).children.push(acc);
                }
            }
            folderMap.get(acc).files.push(fp);
        }
        // The line range of a folder, folded bottom-up over its files and its
        // sub-folders: a folder spans everything under it.
        const folderRange = new Map();
        function rangeOfFolder(p) {
            if (folderRange.has(p)) return folderRange.get(p);
            const info = folderMap.get(p);
            let r = null;
            if (info) {
                for (const fp of info.files) r = widen(r, fileRange.get(fp));
                for (const cp of info.children) r = widen(r, rangeOfFolder(cp));
            }
            folderRange.set(p, r);
            return r;
        }
        for (const p of folderMap.keys()) {
            const info = folderMap.get(p);
            const fid = 'folder:' + (p || '__root__');
            const pfid = (info.parent !== null && folderMap.has(info.parent)) ? 'folder:' + (info.parent || '__root__') : null;
            const r = rangeOfFolder(p);
            nodes.push({
                data: {
                    id: fid, parent: pfid, label: p ? fileName(p) : 'root',
                    kind: 'folder', color: '#1a1b2e', depth: 0, file: p, _filePath: p,
                    _nodeCount: info.files.length + info.children.length,
                    line: r ? r.lo : null, endLine: r ? r.hi : null,
                    _isContainer: true, _isFolder: true, _collapsible: true,
                },
            });
        }
    }

    // ── File containers + symbol children ──
    const fileNodeIds = new Set();
    for (const [fp, symbols] of fileSymbols) {
        var fid = null;
        var fr = fileRange.get(fp) || null;
        if (useFiles) {
            fid = 'file:' + fp;
            fileNodeIds.add(fid);
            var fpath = folderPart(fp);
            var pfid2 = (useFolders && fpath !== fp) ? 'folder:' + (fpath || '__root__') : null;
            nodes.push({
                data: {
                    id: fid, parent: pfid2, label: fileName(fp),
                    kind: 'file', color: '#292e42', file: fp, depth: 0,
                    qualifiedName: fp, _filePath: fp, _nodeCount: symbols.length,
                    line: fr ? fr.lo : null, endLine: fr ? fr.hi : null,
                    _isContainer: true, _isFileContainer: true, _collapsible: true,
                },
            });
        }
        for (const s of symbols) {
            var qn = s.key.qualified_name || s.key.qualifiedName || s.key.name || s.id;
            var short = shortLabel(s.key);
            nodes.push({
                data: {
                    id: s.id, parent: fid, label: short,
                    // `labelLine` is the same label with its line number, so the
                    // native-label stylesheet can pick between them without the
                    // scene having to be rebuilt (see controls.js).
                    labelLine: s.line === null ? short : short + ':' + s.line,
                    qualifiedName: qn, kind: s.kind, color: KIND_COLORS[s.kind] || '#bb9af7',
                    file: fp, depth: s.depth, doc: s.doc,
                    signature: s.signature, visibility: s.visibility, astKind: s.astKind,
                    line: s.line, endLine: s.endLine, col: s.col,
                    startByte: s.startByte, endByte: s.endByte,
                    _isSymbol: true,
                },
            });
        }
    }

    // ── Edges between symbol nodes ──
    // Self-edges are dropped: a `contains` edge whose target is an anchored key
    // resolves to the anchor's own symbol, i.e. `emit_def -> emit_def`. Those
    // used to be drawn as a loop on ~100 nodes, carry no information (they say
    // "this function is inside itself") and have no direction to read.
    const edgeAdded = new Set();
    for (const e of snapshot.edges) {
        var srcKey = resolveToSymbol(e.source), tgtKey = resolveToSymbol(e.target);
        if (!srcKey || !tgtKey) continue;
        var srcId = nodeId(srcKey), tgtId = nodeId(tgtKey);
        if (srcId === tgtId) continue;
        if (fileNodeIds.has(srcId) || fileNodeIds.has(tgtId)) continue;
        if (!added.has(srcId) || !added.has(tgtId)) continue;
        var eid = srcId + '->' + tgtId;
        if (edgeAdded.has(eid)) continue;
        edgeAdded.add(eid);
        var ec = EDGE_COLORS[e.kind] || EDGE_COLORS['references'];
        edges.push({
            data: {
                id: eid, source: srcId, target: tgtId,
                kind: e.kind, weight: e.weight || 1, color: ec.color,
                edgeWidth: Math.min(5, 1 + (e.weight || 1) * 0.3), arrow: !!ec.arrow,
                // Where the relation was written, when the snapshot has a span
                // for it (calls and imports do): "calls emit_def — rust.rs:417".
                line: lineOf(e.span), endLine: endLineOf(e.span),
                file: e.span ? normPath(e.span.file) : null,
            },
        });
    }

    return { nodes, edges };
}

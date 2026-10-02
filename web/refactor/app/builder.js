// ── Hierarchical element builder ─────────────────────────────────────
// Reads the snapshot and produces { nodes, edges } for Cytoscape.
// Honors S.detail so the compound nesting can be peeled back one layer
// at a time:
//   'full'  → folder containers → file containers → symbols
//   'files' → file containers → symbols
//   'flat'  → symbols only (no compound nodes, pure graph)

import { nodeId, resolveToSymbol, shortLabel } from './utils.js';
import { KIND_COLORS, EDGE_COLORS } from './constants.js';
import { S } from './state.js';

/// Normalize `.\crates\x.rs` and `./crates/x.rs` to `crates/x.rs`.
/// The extractor emits Windows-style paths, and the leading `.` used to
/// become a phantom top-level folder in the tree.
function normPath(p) {
    return (p || 'unknown').replace(/\\/g, '/').replace(/^\.\//, '');
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
        fileSymbols.get(file).push({ id, key: n.key, kind: n.kind, depth: n.depth || 0, doc: (n.attrs && n.attrs.doc) || null });
    }

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
        for (const p of folderMap.keys()) {
            const info = folderMap.get(p);
            const fid = 'folder:' + (p || '__root__');
            const pfid = (info.parent !== null && folderMap.has(info.parent)) ? 'folder:' + (info.parent || '__root__') : null;
            nodes.push({
                data: {
                    id: fid, parent: pfid, label: p ? fileName(p) : 'root',
                    kind: 'folder', color: '#1a1b2e', depth: 0, file: p, _filePath: p,
                    _nodeCount: info.files.length + info.children.length,
                    _isContainer: true, _isFolder: true, _collapsible: true,
                },
            });
        }
    }

    // ── File containers + symbol children ──
    const fileNodeIds = new Set();
    for (const [fp, symbols] of fileSymbols) {
        var fid = null;
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
                    _isContainer: true, _isFileContainer: true, _collapsible: true,
                },
            });
        }
        for (const s of symbols) {
            var qn = s.key.qualified_name || s.key.qualifiedName || s.key.name || s.id;
            nodes.push({
                data: {
                    id: s.id, parent: fid, label: shortLabel(s.key),
                    qualifiedName: qn, kind: s.kind, color: KIND_COLORS[s.kind] || '#bb9af7',
                    file: fp, depth: s.depth, doc: s.doc,
                    _isSymbol: true,
                },
            });
        }
    }

    // ── Edges between symbol nodes ──
    const edgeAdded = new Set();
    for (const e of snapshot.edges) {
        var srcKey = resolveToSymbol(e.source), tgtKey = resolveToSymbol(e.target);
        if (!srcKey || !tgtKey) continue;
        var srcId = nodeId(srcKey), tgtId = nodeId(tgtKey);
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
            },
        });
    }

    return { nodes, edges };
}

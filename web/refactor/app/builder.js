// ── Hierarchical element builder ─────────────────────────────────────
// Reads the snapshot and produces { nodes, edges } for Cytoscape.

import { nodeId, resolveToSymbol, shortLabel } from './utils.js';
import { KIND_COLORS, EDGE_COLORS } from './constants.js';
import { S } from './state.js';

export function buildElements() {
    const snapshot = S.snapshot;
    if (!snapshot) return { nodes: [], edges: [] };

    const nodes = [], edges = [], added = new Set();
    const fileSymbols = new Map();

    for (const n of snapshot.nodes) {
        if (n.key.key !== 'symbol') continue;
        const id = nodeId(n.key);
        if (added.has(id)) continue;
        added.add(id);
        const file = n.file || 'unknown';
        if (!fileSymbols.has(file)) fileSymbols.set(file, []);
        fileSymbols.get(file).push({ id, key: n.key, kind: n.kind, depth: n.depth || 0, doc: n.attrs && n.attrs.doc || null });
    }

    function folderPart(fp) { var norm = fp.replace(/\\/g, '/'), i = norm.lastIndexOf('/'); return i >= 0 ? norm.substring(0, i) : ''; }
    function fileName(fp) { return fp.replace(/^.*[/\\]/, ''); }

    // ── Build folder tree from file paths ──
    const folderMap = new Map();
    folderMap.set('', { parent: null, children: [], files: [] });

    for (const _fp of fileSymbols.keys()) {
        var parts = _fp.replace(/\\/g, '/').split('/'), acc = '';
        for (var i = 0; i < parts.length - 1; i++) {
            var parent = acc;
            acc = acc ? acc + '/' + parts[i] : parts[i];
            if (!folderMap.has(acc)) {
                folderMap.set(acc, { parent, children: [], files: [] });
                if (parent !== null) folderMap.get(parent).children.push(acc);
            }
        }
        folderMap.get(acc || '').files.push(_fp);
    }

    // ── Create folder compound nodes ──
    const folderIds = new Set();
    function emitFolder(path) {
        if (folderIds.has(path)) return;
        folderIds.add(path);
        var info = folderMap.get(path);
        if (!info) return;
        var fid = 'folder:' + (path || '__root__');
        var pfid = null;
        if (info.parent !== null) {
            emitFolder(info.parent);
            pfid = 'folder:' + (info.parent || '__root__');
        }
        nodes.push({
            data: {
                id: fid, parent: pfid, label: path ? path.replace(/^.*[/\\]/, '') : 'root',
                kind: 'folder', color: '#1a1b2e', depth: 0, file: path,
                _filePath: path, _nodeCount: info.files.length + info.children.length,
                _isContainer: true, _isFolder: true, _collapsible: true,
            },
        });
    }
    for (const _p of folderMap.keys()) emitFolder(_p);

    // ── Create file compound nodes with symbol children ──
    const fileNodeIds = new Set();
    for (const [_fp2, symbols] of fileSymbols) {
        var fid = 'file:' + _fp2;
        fileNodeIds.add(fid);
        var fpath = folderPart(_fp2);
        var pfid2 = 'folder:' + (fpath || '__root__');
        nodes.push({
            data: {
                id: fid, parent: pfid2, label: fileName(_fp2),
                kind: 'file', color: '#292e42', file: _fp2, depth: 0,
                qualifiedName: _fp2, _filePath: _fp2, _nodeCount: symbols.length,
                _isContainer: true, _isFileContainer: true, _collapsible: true,
            },
        });
        for (const s of symbols) {
            var qn = s.key.qualified_name || s.key.qualifiedName || s.key.name || s.id;
            nodes.push({
                data: {
                    id: s.id, parent: fid, label: shortLabel(s.key),
                    qualifiedName: qn, kind: s.kind, color: KIND_COLORS[s.kind] || '#bb9af7',
                    file: _fp2, depth: s.depth, doc: s.doc,
                },
            });
        }
    }

    // ── Build edges between symbol nodes ──
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

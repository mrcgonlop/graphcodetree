// ── Deterministic containment layout (the 'hierarchy' engine) ────────
//
// Why this engine exists
// ─────────────────────
// Force-directed `cose` treats every symbol, every file box and every
// folder box as a free particle competing in one shared space. On a tree
// this deep (root → crates → crate → src → file → symbol) it has no way
// of knowing that a box is *supposed* to wrap its own children, so boxes
// drift away from their contents, siblings overlap, and the picture
// inflates until each node is a pixel wide. No amount of parameter
// tuning fixes that — it is a structural mismatch.
//
// So this engine derives the picture from the tree instead, bottom-up:
//
//   1. the symbols of a file are packed into a tidy grid inside it;
//   2. the file boxes of a folder are shelf-packed inside it;
//   3. the folder boxes of a folder are shelf-packed inside it;
//   4. …recursively, so the root ends up exactly as large as everything.
//
// Every box is sized by the same arithmetic cytoscape uses to draw it:
// a symbol is `nodeSize` plus its own border, a box is its children's packed
// block plus padding and its own border. The numbers are derived from the
// tree and the options only — never from a rendered bounding box — so the
// layout is a pure function of (graph, options): the same input always gives
// the same picture, whatever engine ran before (see .cgtest/drift.mjs).
//
// Coordinate model — verified against cytoscape 3.34 (headless probe):
//   • `node.position()` is ABSOLUTE model space, for every node;
//   • moving a container translates its whole subtree by the same delta;
//   • a container box is auto-sized to (children + padding + border) and stays
//     centred on the container's own position.
// That gives exactly one primitive — "move a box, its contents come
// along" — and the containment guarantee then holds by construction.

import { S } from './state.js';

// ── Option handling ─────────────────────────────────────────────────

function num(v, fallback) {
    return (typeof v === 'number' && isFinite(v)) ? v : fallback;
}

function makeContext(options) {
    const o = options || {};
    return {
        nodeSize: num(o.nodeSize, 40),
        filePad: num(o.filePad, 15),
        folderPad: num(o.folderPad, 20),
        nodeGapX: num(o.nodeGapX, 24),
        nodeGapY: num(o.nodeGapY, 28),
        colGap: num(o.colGap, 36),
        rowGap: num(o.rowGap, 64),
        // Target width / height of a packed block of boxes.
        aspect: Math.max(0.2, num(o.aspect, 1.7)),
        // Border widths are style values, but geometry cannot ignore them:
        // cytoscape draws a node's border outside its `width`, and a box adds
        // its own border around (children + padding). Measured against
        // cytoscape 3.34 on a real render (see the sizing probe in
        // validate.mjs): symbol = nodeSize + 2*border, box inset =
        // padding + border per side. Defaults mirror main.js's stylesheet.
        symbolBorder: num(o.symbolBorder, 2),
        fileBorder: num(o.fileBorder, 1.5),
        folderBorder: num(o.folderBorder, 2),
    };
}

// ── Geometry helpers ────────────────────────────────────────────────

function posOf(node) {
    if (!node) return { x: 0, y: 0 };
    try {
        const p = node.position();
        if (p && isFinite(p.x) && isFinite(p.y)) return p;
    } catch (e) { /* fall through */ }
    return { x: 0, y: 0 };
}

/// Every symbol in this app is drawn at `nodeSize` squares, so one analytic
/// size serves for all of them (borders included, exactly as drawn).
function leafBox(ctx) {
    const s = ctx.nodeSize + 2 * ctx.symbolBorder;
    return { w: s, h: s };
}

/// Columns/rows of a grid of `count` equal cells at the target aspect.
function gridShape(count, ctx) {
    const cols = Math.max(1, Math.ceil(Math.sqrt(count * ctx.aspect)));
    const rows = Math.max(1, Math.ceil(count / cols));
    return { cols: cols, rows: rows };
}

/// Offsets from the block centre for a grid of `count` equal cells.
/// Every row is centred individually, so a ragged last row keeps the whole
/// block symmetric around its centre — which is what makes the parent box
/// land exactly on the parent's position.
function gridOffsets(count, ctx, cellW, cellH) {
    const shape = gridShape(count, ctx);
    const out = [];
    for (let i = 0; i < count; i++) {
        const r = Math.floor(i / shape.cols);
        const c = i % shape.cols;
        const inRow = Math.min(shape.cols, count - r * shape.cols);
        out.push({
            x: (c - (inRow - 1) / 2) * cellW,
            y: (r - (shape.rows - 1) / 2) * cellH,
        });
    }
    return out;
}

/// Shelf ("row") packing: items are sorted tallest-first, laid out
/// left-to-right, wrapped once a row would exceed a target width, then the
/// rows are stacked and centred. Deterministic greedy packing — it is what
/// makes a folder of 8 files look like a tidy shelf instead of a heap.
/// Returns { pos: Map<id,{x,y}>, w, h, rows } with positions relative to
/// the block centre.
function shelfPack(items, gapX, gapY, aspect) {
    const ordered = items.slice().sort(function (a, b) {
        if (b.h !== a.h) return b.h - a.h;
        return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });

    let maxW = 0, area = 0;
    for (const it of ordered) {
        maxW = Math.max(maxW, it.w);
        area += (it.w + gapX) * (it.h + gapY);
    }
    const targetW = Math.max(maxW, Math.sqrt(Math.max(area, 1)) * aspect);

    const rows = [];
    let row = { items: [], w: 0, h: 0 };
    for (const it of ordered) {
        if (row.items.length > 0 && row.w + gapX + it.w > targetW) {
            rows.push(row);
            row = { items: [], w: 0, h: 0 };
        }
        row.w = row.items.length === 0 ? it.w : row.w + gapX + it.w;
        row.h = Math.max(row.h, it.h);
        row.items.push(it);
    }
    if (row.items.length > 0) rows.push(row);

    let totalH = 0, blockW = 0;
    for (const r of rows) {
        totalH += r.h;
        blockW = Math.max(blockW, r.w);
    }
    totalH += gapY * Math.max(0, rows.length - 1);

    const pos = new Map();
    let y = -totalH / 2;
    for (const r of rows) {
        let x = -r.w / 2;
        for (const it of r.items) {
            pos.set(it.id, { x: x + it.w / 2, y: y + r.h / 2 });
            x += it.w + gapX;
        }
        y += r.h + gapY;
    }
    return { pos: pos, w: blockW, h: totalH, rows: rows.length };
}

// ── The engine ──────────────────────────────────────────────────────

/// Lay the current graph out as a containment tree.
/// Returns a summary of the result (also stored on `S.hierarchyStats` so
/// the metrics HUD can report it), or null when there is nothing to do.
export function hierarchyLayout(cy, options) {
    const ctx = makeContext(options);
    if (!cy) return null;

    const col = (options && options.eles && typeof options.eles.nodes === 'function')
        ? options.eles.nodes()
        : cy.nodes();

    const nodes = [];
    col.forEach(function (n) { nodes.push(n); });
    if (nodes.length === 0) { S.hierarchyStats = null; return null; }

    // ── Tree index. Plain maps only, so this never depends on cytoscape's
    //    compound traversal helpers (which keeps it testable headless). ──
    const kids = new Map();
    const byId = new Map();
    const roots = [];
    for (const n of nodes) { kids.set(n.id(), []); byId.set(n.id(), n); }
    for (const n of nodes) {
        const pid = n.data('parent');
        if (pid && kids.has(pid)) kids.get(pid).push(n);
        else roots.push(n);
    }

    const childCount = function (n) { const k = kids.get(n.id()); return k ? k.length : 0; };
    const padOf = function (n) { return n.data('_isFolder') ? ctx.folderPad : ctx.filePad; };
    const borderOf = function (n) { return n.data('_isFolder') ? ctx.folderBorder : ctx.fileBorder; };

    /// Size of the block the children of a box are arranged into: a grid when
    /// the group is all symbols, a shelf otherwise. Both use exactly the same
    /// numbers as the placement below, which is what makes the box that
    /// cytoscape then draws equal to the box the engine predicted.
    function blockSize(items) {
        const allLeaves = items.every(function (n) { return childCount(n) === 0; });
        if (allLeaves) {
            const lb = leafBox(ctx);
            const shape = gridShape(items.length, ctx);
            return {
                w: (shape.cols - 1) * (lb.w + ctx.nodeGapX) + lb.w,
                h: (shape.rows - 1) * (lb.h + ctx.nodeGapY) + lb.h,
            };
        }
        if (items.length === 1) return sizeOf(items[0]);
        const packed = shelfPack(sizedItems(items), ctx.colGap, ctx.rowGap, ctx.aspect);
        return { w: packed.w, h: packed.h };
    }

    /// `items` as shelf-packable entries, each sized by its own subtree.
    function sizedItems(items) {
        return items.map(function (n) {
            const s = sizeOf(n);
            return { node: n, id: n.id(), w: s.w, h: s.h };
        });
    }

    /// Size of a box, straight from the tree: a symbol is `nodeSize` plus its
    /// border, a box is its children's packed block plus padding and border —
    /// exactly what cytoscape draws, but independent of any render.
    function sizeOf(n) {
        const k = kids.get(n.id()) || [];
        if (k.length === 0) return leafBox(ctx);
        const b = blockSize(k);
        const m = padOf(n) + borderOf(n);
        return { w: b.w + 2 * m, h: b.h + 2 * m };
    }

    /// Place symbols as a centred grid around `origin`.
    function gridAround(items, origin) {
        if (items.length === 0) return;
        const lb = leafBox(ctx);
        const offs = gridOffsets(items.length, ctx, lb.w + ctx.nodeGapX, lb.h + ctx.nodeGapY);
        for (let i = 0; i < items.length; i++) {
            items[i].position({ x: origin.x + offs[i].x, y: origin.y + offs[i].y });
        }
    }

    /// Shelf-pack `items` around `origin`. Moving a container takes its
    /// subtree with it, so this is safe at any depth.
    function shelfAround(items, origin) {
        if (items.length === 0) return null;
        const list = sizedItems(items);
        const packed = shelfPack(list, ctx.colGap, ctx.rowGap, ctx.aspect);
        for (const it of list) {
            const off = packed.pos.get(it.id);
            if (!off) continue;
            it.node.position({ x: origin.x + off.x, y: origin.y + off.y });
        }
        return packed;
    }

    /// detail 'flat': there are no boxes at all, so cluster the symbols by
    /// file and shelf-pack the clusters. Same geometry, no containers.
    function packFlat(items) {
        const groups = new Map();
        for (const n of items) {
            const key = n.data('file') || '?';
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(n);
        }
        const clusters = [];
        for (const [key, list] of groups) {
            const lb = leafBox(ctx);
            const shape = gridShape(list.length, ctx);
            clusters.push({
                id: 'flat:' + key,
                list: list,
                offs: gridOffsets(list.length, ctx, lb.w + ctx.nodeGapX, lb.h + ctx.nodeGapY),
                w: (shape.cols - 1) * (lb.w + ctx.nodeGapX) + lb.w,
                h: (shape.rows - 1) * (lb.h + ctx.nodeGapY) + lb.h,
            });
        }
        const packed = shelfPack(clusters, ctx.colGap, ctx.rowGap, ctx.aspect);
        for (const cl of clusters) {
            const o = packed.pos.get(cl.id) || { x: 0, y: 0 };
            for (let i = 0; i < cl.list.length; i++) {
                cl.list[i].position({ x: o.x + cl.offs[i].x, y: o.y + cl.offs[i].y });
            }
        }
    }

    // ── Bottom-up pass. Deepest containers first, so by the time a box is
    //    packed every one of its children is in its final arrangement. ──
    function depthOf(n) {
        let d = 0, pid = n.data('parent'), guard = 0;
        while (pid && byId.has(pid) && guard++ < 64) { d++; pid = byId.get(pid).data('parent'); }
        return d;
    }

    const containers = nodes.filter(function (n) { return childCount(n) > 0; });
    containers.sort(function (a, b) { return depthOf(b) - depthOf(a); });

    for (const c of containers) {
        const k = kids.get(c.id()) || [];
        const allLeaves = k.every(function (n) { return childCount(n) === 0; });
        if (allLeaves) gridAround(k, posOf(c));
        else shelfAround(k, posOf(c));
    }

    // ── Top level ──
    if (containers.length === 0) {
        packFlat(roots);
    } else if (roots.length > 1) {
        // detail 'files': several top-level boxes but no common parent box.
        shelfAround(roots, { x: 0, y: 0 });
    }

    // ── Centre the whole picture on the origin. By construction every box
    //    is symmetric around its position, so pos ± size/2 is its extent. ──
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const n of roots) {
        const s = sizeOf(n), p = posOf(n);
        x1 = Math.min(x1, p.x - s.w / 2); x2 = Math.max(x2, p.x + s.w / 2);
        y1 = Math.min(y1, p.y - s.h / 2); y2 = Math.max(y2, p.y + s.h / 2);
    }
    if (isFinite(x1) && isFinite(x2) && isFinite(y1) && isFinite(y2)) {
        const dx = -(x1 + x2) / 2, dy = -(y1 + y2) / 2;
        if (dx !== 0 || dy !== 0) {
            for (const n of roots) {
                const p = posOf(n);
                n.position({ x: p.x + dx, y: p.y + dy });
            }
        }
    }

    let symbols = 0, maxDepth = 0;
    for (const n of nodes) if (childCount(n) === 0) symbols++;
    for (const c of containers) maxDepth = Math.max(maxDepth, depthOf(c));

    const stats = {
        engine: 'hierarchy',
        symbols: symbols,
        boxes: containers.length,
        levels: containers.length > 0 ? maxDepth + 1 : 0,
        cell: Math.round(leafBox(ctx).w + ctx.nodeGapX),
        w: isFinite(x2 - x1) ? Math.round(x2 - x1) : 0,
        h: isFinite(y2 - y1) ? Math.round(y2 - y1) : 0,
    };
    S.hierarchyStats = stats;
    return stats;
}

// ── Cytoscape registration ──────────────────────────────────────────

/// Register this engine as `{ name: 'hierarchy' }` so it is driven through
/// the exact same path as every other layout: `cy.layout(opts).run()` plus
/// the usual `layoutstop` event. Called from main.js, which is where the
/// global cytoscape from the CDN actually exists.
export function registerHierarchyLayout(cytoscapeRef) {
    if (typeof cytoscapeRef !== 'function') {
        console.warn('hierarchy layout: cytoscape not available — engine not registered');
        return false;
    }
    cytoscapeRef('layout', 'hierarchy', function (options) {
        const layout = this;
        layout.run = function () {
            try {
                hierarchyLayout(options.cy, options);
            } catch (e) {
                console.warn('hierarchy layout error:', e);
            }
            layout.emit({ type: 'layoutready' });
            layout.emit({ type: 'layoutstop' });
        };
    });
    return true;
}

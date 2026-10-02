// ── Main entry point ────────────────────────────────────────────────

import { S } from './state.js';
import { KIND_COLORS, KIND_ORDER, BORDERS } from './constants.js';
import { esc } from './utils.js';
import { buildElements } from './builder.js';
import { refreshVisibility, toggleContainer } from './visibility.js';
import { resetAggregatedEdges } from './aggregate.js';
import { createLabelOverlays } from './overlay.js';
import { focusNode, unfocusAll } from './focus.js';
import { showDetails, setFocusHandler } from './details.js';
import { buildLayoutOptions } from './layout.js';
import { registerHierarchyLayout } from './hierarchy.js';
import { initControls } from './controls.js';

// Wire the focus handler into details (breaks circular dep)
setFocusHandler(focusNode);

// Register the deterministic containment engine as a normal cytoscape
// layout, so `{ name: 'hierarchy' }` runs through the exact same path as
// cose/grid/breadthfirst. This is the only place that touches the global
// `cytoscape`, which is why registration happens here and not in the
// engine module itself.
registerHierarchyLayout(typeof cytoscape === 'function' ? cytoscape : null);

// ── Render ──────────────────────────────────────────────────────────

function render(snapshot) {
    const el = buildElements();
    const container = document.getElementById('graph-container');
    // The aggregate edges live inside the instance that is about to be
    // destroyed, so drop the cache before pulling the plug on it.
    resetAggregatedEdges();
    if (S.cy) S.cy.destroy();
    container.innerHTML = '<div class="tooltip">Scroll to zoom \u00B7 Drag to pan \u00B7 Click to focus \u00B7 Double-click canvas to show all</div>';

    // Layout options come from the live slider state (see layout.js):
    // every structural parameter is tunable via the sidebar sliders.
    const layoutOpts = buildLayoutOptions();

    S.cy = cytoscape({
        container: container,
        elements: [].concat(el.nodes, el.edges),
        style: [
            {
                selector: 'node',
                style: {
                    'background-color': 'data(color)',
                    label: '',
                    'font-size': S.currentFontSize + 'px',
                    color: '#a9b1d6',
                    'text-valign': 'bottom',
                    'text-halign': 'center',
                    'text-margin-y': 6,
                    'border-width': BORDERS.symbol,
                    'border-color': '#4a5080',
                    'border-opacity': 0.9,
                },
            },
            {
                // Only leaf symbols get an explicit size; compound
                // containers derive theirs from their children.
                selector: 'node[_isSymbol]',
                style: {
                    width: S.nodeSize,
                    height: S.nodeSize,
                },
            },
            {
                selector: 'node[_isFileContainer]',
                style: {
                    'background-color': '#292e42',
                    'background-opacity': 0.25,
                    'border-width': BORDERS.file,
                    'border-color': '#565f89',
                    'border-opacity': 0.6,
                    'border-style': 'dashed',
                    shape: 'round-rectangle',
                    padding: S.containerPadding,
                    'text-valign': 'top',
                    'text-halign': 'center',
                    'font-size': Math.max(S.currentFontSize, 11) + 'px',
                    color: '#565f89',
                    'font-weight': 'bold',
                    label: 'data(label)',
                    'z-compound-depth': 'bottom',
                    'z-index': -1,
                },
            },
            {
                selector: 'node[_isFolder]',
                style: {
                    'background-color': '#1a1b2e',
                    'background-opacity': 0.35,
                    'border-width': BORDERS.folder,
                    'border-color': '#3b4261',
                    'border-opacity': 0.7,
                    'border-style': 'solid',
                    shape: 'round-rectangle',
                    padding: S.folderPadding,
                    'text-valign': 'top',
                    'text-halign': 'center',
                    'font-size': Math.max(S.currentFontSize + 2, 12) + 'px',
                    color: '#737aa2',
                    'font-weight': 'bold',
                    label: 'data(label)',
                    'z-compound-depth': 'bottom',
                    'z-index': -2,
                },
            },
            {
                selector: 'node[_collapsed]',
                style: {
                    'background-opacity': 0.5,
                    'border-color': '#e0af68',
                    'border-opacity': 0.8,
                },
            },
            {
                selector: 'edge',
                style: {
                    'line-color': 'data(color)',
                    width: 'data(edgeWidth)',
                    'target-arrow-shape': function (ele) { return ele.data('arrow') ? 'triangle' : 'none'; },
                    'arrow-scale': 0.6,
                    'curve-style': 'bezier',
                },
            },
            {
                // Edges standing in for the ones inside a collapsed box
                // (aggregate.js): dashed, so a summary never reads as a real
                // single call, and one width step up per summed weight.
                selector: 'edge[_agg]',
                style: {
                    'line-style': 'dashed',
                    'arrow-scale': 0.5,
                },
            },
            {
                selector: ':selected',
                style: { 'border-width': BORDERS.select, 'border-color': '#e0af68' },
            },
        ],
    });

    // ── Run layout, then create overlays ──
    var layout = S.cy.layout(layoutOpts);
    layout.one('layoutstop', function () {
        try {
            S.labelOverlay = createLabelOverlays();
            S.labelOverlay.render();
            S.cy.fit(S.cy.elements(), 50);
            S.cy.minZoom(0.05);
            S.cy.maxZoom(10);
            refreshVisibility();
            setTimeout(function () { S.cy.fit(S.cy.elements(), 50); }, 100);
        } catch (e) {
            console.error('Error after layout stop:', e);
        }
    });
    layout.run();

    // ── Event handlers ──

    // Tap on a container: collapsed→expand+showDetails, expanded→collapse only
    var cy = S.cy;
    cy.on('tap', 'node[_collapsible]', function (evt) {
        const target = evt.target;
        const wasCollapsed = target.data('_collapsed');
        toggleContainer(target);
        if (wasCollapsed) {
            showDetails(target.data());
        }
    });

    // Tap on a symbol node: focus (or unfocus if already focused)
    cy.on('tap', 'node', function (evt) {
        const target = evt.target;
        if (target.data('_isContainer')) return;
        const id = target.id();
        if (S.focusedNodeId === id) {
            unfocusAll();
        } else {
            focusNode(id);
        }
    });


    // Double-tap background → unfocus all + fit view
    cy.on('dblclick', function (evt) {
        if (evt.target === cy) { unfocusAll(); cy.fit(cy.elements(), 50); }
    });

    // Hover effects (skip containers)
    cy.on('mouseover', 'node', function (evt) {
        if (evt.target.data('_isContainer')) return;
        if (!S.focusedNodeId) evt.target.style('border-color', '#e0af68');
    });
    cy.on('mouseout', 'node', function (evt) {
        if (evt.target.data('_isContainer')) return;
        // Back to the stylesheet colour rather than a hardcoded one, so the
        // hover ring and the focus ring can never disagree.
        if (!S.focusedNodeId) evt.target.removeStyle('border-color');
    });

    // Focus indicator dismiss
    var dismissBtn = document.querySelector('.focus-dismiss');
    if (dismissBtn) dismissBtn.onclick = unfocusAll;

    // ── Sidebar parameter controls (font, sizing, layout sliders) ──
    // All slider wiring lives in controls.js so every parameter is linked
    // in one place and can be reset from an authoritative default set.
    initControls();

    // ── Clear buttons for search boxes ──
    document.querySelectorAll('.clear-btn').forEach(function (btn) {
        btn.onclick = function () {
            var inp = document.getElementById(this.dataset.target);
            inp.value = '';
            inp.dispatchEvent(new Event('input'));
            inp.focus();
        };
    });

    // ── Search by name ──
    document.getElementById('search').oninput = function () {
        refreshVisibility();
    };

    // ── Search by path ──
    document.getElementById('search-path').oninput = function () {
        refreshVisibility();
    };


    // ── Kind filters ──
    function applyKindFilters() {
        refreshVisibility();
    }

    const kindsPresent = new Set();
    for (const n of snapshot.nodes) {
        if (n.key.key === 'symbol') kindsPresent.add(n.kind);
    }
    const filterDiv = document.getElementById('filters');
    filterDiv.innerHTML = '';
    for (const kind of KIND_ORDER) {
        if (!kindsPresent.has(kind)) continue;
        const label = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.value = kind; cb.checked = true;
        cb.addEventListener('change', applyKindFilters);
        label.appendChild(cb);
        const span = document.createElement('span');
        span.textContent = kind.replace('_', ' ');
        span.style.color = KIND_COLORS[kind] || '#fff';
        label.appendChild(span);
        filterDiv.appendChild(label);
    }

    // ── Depth selector ──
    S.selectedMaxDepth = null;
    var maxDepthSeen = 0;
    for (const n of snapshot.nodes) {
        const d = n.depth || 0;
        if (d > maxDepthSeen) maxDepthSeen = d;
    }
    const depthSelector = document.getElementById('depth-selector');
    depthSelector.innerHTML = '';
    const depthLabel = document.createElement('span');
    depthLabel.className = 'depth-label';
    depthLabel.textContent = 'depth \u2264';
    depthSelector.appendChild(depthLabel);

    function applyDepthFilter() {
        refreshVisibility();
    }

    const allBtn = document.createElement('span');
    allBtn.className = 'depth-btn active';
    allBtn.textContent = 'All';
    allBtn.addEventListener('click', function () {
        S.selectedMaxDepth = null;
        depthSelector.querySelectorAll('.depth-btn').forEach(function (b) { b.classList.remove('active'); });
        this.classList.add('active');
        applyDepthFilter();
    });
    depthSelector.appendChild(allBtn);
    for (let d = 0; d <= maxDepthSeen; d++) {
        const btn = document.createElement('span');
        btn.className = 'depth-btn';
        btn.textContent = '' + d;
        btn.addEventListener('click', function () {
            S.selectedMaxDepth = parseInt(this.textContent);
            depthSelector.querySelectorAll('.depth-btn').forEach(function (b) { b.classList.remove('active'); });
            this.classList.add('active');
            applyDepthFilter();
        });
        depthSelector.appendChild(btn);
    }
}


// ── Init ────────────────────────────────────────────────────────────

S.cy = null;

// Let controls.js rebuild the scene after a detail-level change
// (folder/file/flat) without a reload.
S.rebuild = function () { if (S.snapshot) render(S.snapshot); };

fetch('graph.json')
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (data) {
        S.snapshot = data;
        const s = data.stats;
        var maxDepth = 0, depthHisto = {};
        for (var i = 0; i < data.nodes.length; i++) {
            var d = data.nodes[i].depth || 0;
            if (d > maxDepth) maxDepth = d;
            depthHisto[d] = (depthHisto[d] || 0) + 1;
        }
        var depthStr = 'depth: 0\u2026' + maxDepth;
        if (maxDepth > 0) {
            depthStr += ' (' + Object.entries(depthHisto).map(function (e) { return e[0] + ':' + e[1]; }).join(' \u00B7 ') + ')';
        }
        document.getElementById('stats').innerHTML =
            data.file_count + ' files \u00B7 ' + s.total_nodes + ' defs \u00B7 ' + s.total_edges + ' edges<br>' +
            s.function_count + ' fns \u00B7 ' + s.struct_count + ' structs \u00B7 ' + s.trait_count + ' traits \u00B7 ' +
            s.calls_edge_count + ' calls \u00B7 ' + (s.impl_edge_count || 0) + ' implements \u00B7 ' +
            (s.data_flow_edge_count || 0) + ' dataflows<br><span style="color:#565f89">' + depthStr + '</span>';

        // Populate path autocomplete
        var paths = new Set();
        for (var j = 0; j < data.nodes.length; j++) {
            if (data.nodes[j].file) paths.add(data.nodes[j].file.replace(/^\.[\\/]/, ''));
        }
        var datalist = document.getElementById('path-list');
        datalist.innerHTML = '';
        var sorted = Array.from(paths).sort();
        for (var k = 0; k < sorted.length; k++) {
            var opt = document.createElement('option');
            opt.value = sorted[k];
            datalist.appendChild(opt);
        }

        render(data);
    })
    .catch(function (err) {
        document.getElementById('stats').textContent = 'Error loading graph.json';
        document.getElementById('node-details').innerHTML =
            '<div class="empty">Failed to load graph.json: ' + esc(err.message) +
            '<br><br>Run <code>codegraph snapshot . &gt; graph.json</code> then reload.</div>';
    });


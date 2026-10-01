(function () {
  'use strict';

  // ────────────────────────────── Constants ──────────────────────────────

  const KIND_COLORS = {
    function: '#7aa2f7',
    struct: '#9ece6a',
    enum: '#bb9af7',
    trait: '#f7768e',
    impl_block: '#e0af68',
    module: '#2ac3de',
    constant: '#ff9e64',
    static: '#ff9e64',
    type_alias: '#73daca',
    macro: '#f7768e',
    enum_variant: '#bb9af7',
    field: '#565f89',
    file: '#414868',
  };

  const EDGE_COLORS = {
    calls: { color: '#7aa2f7' },
    implements: { color: '#bb9af7' },
    data_flow: { color: '#73daca' },
    extends: { color: '#9ece6a' },
    references: { color: '#565f89' },
    contains: { color: '#2ac3de' },
  };

  const KIND_ORDER = ['function', 'struct', 'enum', 'trait', 'impl_block', 'module', 'type_alias', 'constant', 'static', 'macro', 'enum_variant', 'field'];

  // ────────────────────────────── State ──────────────────────────────────

  let snapshot = null;
  let cy = null;
  let focusedNodeId = null;
  let currentFontSize = 10;
  let selectedMaxDepth = null;
  let labelOverlay = null;

  // ────────────────────────────── Utilities ──────────────────────────────

  function esc(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function nodeId(key) {
    if (!key || !key.key) return '?';
    return (key.key === 'symbol' ? 'sym:' : 'def:') + (key.qualifiedName || key.name || '?') + (key.file ? '@' + key.file : '');
  }

  function resolveToSymbol(ref) {
    if (!ref) return { key: 'symbol', name: '?', qualifiedName: '?' };
    if (ref.key && ref.key.key === 'symbol') return ref.key;
    if (ref.resolvedTo && ref.resolvedTo.key) {
      return ref.resolvedTo;
    }
    return ref.key || { key: 'symbol', name: ref.name || '?', qualifiedName: ref.qualifiedName || ref.name || '?' };
  }

  // ────────────────────────── Element builders ───────────────────────────

  /// Flat graph: one node per symbol, edges between them.
  function buildElements(snapshot) {
    const nodes = [], edges = [], added = new Set();
    for (const n of snapshot.nodes) {
      if (n.key.key !== 'symbol') continue;
      const id = nodeId(n.key);
      if (added.has(id)) continue;
      added.add(id);
      const qualifiedName = n.key.qualifiedName || n.key.name || id;
      nodes.push({
        data: {
          id: id,
          label: shortLabel(n.key),
          qualifiedName: qualifiedName,
          kind: n.kind,
          color: KIND_COLORS[n.kind] || '#bb9af7',
          file: n.file || 'unknown',
          depth: n.depth || 0,
          doc: n.doc || null,
        },
      });
    }

    const edgeAdded = new Set();
    for (const e of snapshot.edges) {
      const srcKey = resolveToSymbol(e.source);
      const tgtKey = resolveToSymbol(e.target);
      const srcId = nodeId(srcKey), tgtId = nodeId(tgtKey);
      if (!added.has(srcId) || !added.has(tgtId)) continue;
      const eid = srcId + '->' + tgtId;
      if (edgeAdded.has(eid)) continue;
      edgeAdded.add(eid);
      const ec = EDGE_COLORS[e.kind] || EDGE_COLORS['references'];
      edges.push({
        data: {
          id: eid, source: srcId, target: tgtId,
          kind: e.kind, weight: e.weight || 1,
          color: ec.color,
          edgeWidth: Math.min(5, 1 + (e.weight || 1) * 0.3),
          arrow: true,
        },
      });
    }
    return { nodes, edges };
  }

  /// Compound graph (group mode): file nodes as compound parents containing symbol nodes.
  /// The cose layout naturally repels parent containers apart, preventing overlap.
  function buildCompoundElements(snapshot) {
    const nodes = [], edges = [], added = new Set();
    const fileInfo = new Map(); // file path -> { fid, count }

    // Pass 1: collect unique files and count symbols per file
    for (const n of snapshot.nodes) {
      if (n.key.key !== 'symbol') continue;
      const id = nodeId(n.key);
      if (added.has(id)) continue;
      added.add(id);
      const file = n.file || 'unknown';
      if (!fileInfo.has(file)) fileInfo.set(file, { fid: 'fgroup:' + file, count: 0 });
      fileInfo.get(file).count++;
    }

    // Build parent (file) nodes
    const parentAdded = new Set();
    for (const [file, info] of fileInfo) {
      parentAdded.add(info.fid);
      nodes.push({
        data: {
          id: info.fid,
          label: file.replace(/^.*[\\/]/, ''),
          kind: 'file',
          color: '#292e42',
          file: file,
          depth: 0,
          qualifiedName: file,
          _filePath: file,
          _nodeCount: info.count,
          _isFileGroup: true,
        },
      });
    }

    // Build child (symbol) nodes, referencing parent
    const built = new Set(); // track which IDs have been added as children
    for (const n of snapshot.nodes) {
      if (n.key.key !== 'symbol') continue;
      const id = nodeId(n.key);
      if (!added.has(id) || built.has(id)) continue;
      built.add(id);
      const file = n.file || 'unknown';
      const info = fileInfo.get(file);
      if (!info) continue;
      const qualifiedName = n.key.qualifiedName || n.key.name || id;
      nodes.push({
        data: {
          id: id,
          parent: info.fid, // compound parent
          label: shortLabel(n.key),
          qualifiedName: qualifiedName,
          kind: n.kind,
          color: KIND_COLORS[n.kind] || '#bb9af7',
          file: file,
          depth: n.depth || 0,
          doc: n.doc || null,
        },
      });
    }

    // Build edges (same logic as buildElements) — uses original `added` set
    const edgeAdded = new Set();
    for (const e of snapshot.edges) {
      const srcKey = resolveToSymbol(e.source);
      const tgtKey = resolveToSymbol(e.target);
      const srcId = nodeId(srcKey), tgtId = nodeId(tgtKey);
      if (parentAdded.has(srcId) || parentAdded.has(tgtId)) continue;
      if (!added.has(srcId) || !added.has(tgtId)) continue;
      const eid = srcId + '->' + tgtId;
      if (edgeAdded.has(eid)) continue;
      edgeAdded.add(eid);
      const ec = EDGE_COLORS[e.kind] || EDGE_COLORS['references'];
      edges.push({
        data: {
          id: eid, source: srcId, target: tgtId,
          kind: e.kind, weight: e.weight || 1,
          color: ec.color,
          edgeWidth: Math.min(5, 1 + (e.weight || 1) * 0.3),
          arrow: true,
        },
      });
    }

    return { nodes, edges };
  }


  function shortLabel(key) {
    const qn = key.qualifiedName || key.name || '';
    const parts = qn.split('::');
    return parts[parts.length - 1] || qn;
  }

  // ────────────────────────── DOM label overlays ─────────────────────────

  /// Create Ctrl+F–searchable DOM labels positioned over each visible node.
  function createLabelOverlays() {
    const container = document.getElementById('graph-container');
    let overlay = document.getElementById('label-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'label-overlay';
      overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:hidden;';
      container.appendChild(overlay);
    }

    /// Full rebuild: destroy and recreate all label spans.
    function build() {
      if (!cy) { overlay.innerHTML = ''; return; }
      overlay.innerHTML = '';
      cy.nodes().forEach(function (n) {
        if (n.data('_isFileGroup')) return;
        if (n.style('display') === 'none') return;
        const pos = n.renderedPosition();
        const lbl = n.data('label');
        if (!lbl) return;
        const span = document.createElement('span');
        span.textContent = lbl;
        span.dataset.nodeId = n.id();
        span.style.cssText =
          'position:absolute;left:' + pos.x + 'px;top:' + (pos.y + 6) + 'px;' +
          'transform:translate(-50%,0);font-size:' + currentFontSize + 'px;' +
          'color:#a9b1d6;text-shadow:0 0 3px #0f0f1a,0 0 6px #0f0f1a;' +
          'white-space:nowrap;user-select:text;' +
          'opacity:' + (n.style('opacity') || 1) + ';' +
          'transition:opacity 0.15s';
        overlay.appendChild(span);
      });
    }

    /// Lightweight position + opacity sync (doesn't destroy/recreate spans).
    function updatePositions() {
      if (!cy) return;
      var map = {};
      overlay.querySelectorAll('span').forEach(function (s) { map[s.dataset.nodeId] = s; });
      cy.nodes().forEach(function (n) {
        var span = map[n.id()];
        if (!span) return;
        if (n.data('_isFileGroup')) { if (span.parentNode) span.parentNode.removeChild(span); return; }
        if (n.style('display') === 'none') { span.style.display = 'none'; return; }
        span.style.display = '';
        var pos = n.renderedPosition();
        var lbl = n.data('label');
        span.textContent = lbl || '';
        span.style.left = pos.x + 'px';
        span.style.top = (pos.y + 6) + 'px';
        span.style.opacity = n.style('opacity') || 1;
      });
    }

    return { build: build, render: build, updatePositions: updatePositions, positionUpdate: updatePositions };
  }

  // ────────────────────────── Focus / unfocus ────────────────────────────

  function focusNode(id) {
    if (!cy) return;
    const node = cy.getElementById(id);
    if (!node || node.length === 0) return;
    focusedNodeId = id;

    const allNodes = cy.nodes();
    const allEdges = cy.edges();
    const focusDepth = node.data('depth') || 0;

    allNodes.forEach(function (n) {
      if (n.data('_isFileGroup')) return;
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
    showDetails(node.data());
    if (labelOverlay) labelOverlay.positionUpdate();
  }

  function unfocusAll() {
    if (!cy) return;
    focusedNodeId = null;
    cy.nodes().forEach(function (n) {
      if (n.data('_isFileGroup')) return;
      n.style({ opacity: 1.0, 'border-opacity': 0.8 });
    });
    cy.edges().forEach(function (e) {
      e.style({ opacity: 1.0, 'target-arrow-opacity': 1.0 });
    });
    document.getElementById('focus-indicator').classList.remove('visible');
    document.getElementById('node-details').innerHTML = '<div class="empty">Click a node to see details</div>';
    if (labelOverlay) labelOverlay.positionUpdate();
  }


  // ────────────────────────── Details panel ──────────────────────────────

  function showDetails(data) {
    const el = document.getElementById('node-details');
    if (!data) { el.innerHTML = '<div class="empty">Click a node to see details</div>'; return; }

    let html = '';

    // File-group parent
    if (data._isFileGroup) {
      html += '<div><span class="node-kind kind-file">' + esc(data._filePath.replace(/^.*[\\/]/, '')) + '</span></div>';
      html += '<div class="node-file">' + esc(data._filePath) + '</div>';
      html += '<div class="node-attrs">' + data._nodeCount + ' symbols in this file</div>';

      if (cy) {
        const memberNodes = cy.nodes().filter(function (n) {
          return !n.data('_isFileGroup') && n.data('file') === data._filePath;
        });
        html += '<div class="edge-list"><h4>Symbols (' + memberNodes.length + ')</h4>';
        memberNodes.forEach(function (mn) {
          html += '<div class="clickable-edge" data-id="' + esc(mn.id()) + '" style="padding:2px 0;color:#a9b1d6;font-size:11px;cursor:pointer" title="Click to focus">';
          html += '<span style="color:' + (KIND_COLORS[mn.data('kind')] || '#565f89') + '">' + esc(mn.data('kind')) + '</span>  ';
          html += esc(mn.data('label'));
          html += '</div>';
        });
        html += '</div>';
      }

      el.innerHTML = html;
      wireClickableEdges(el);
      return;
    }

    // Regular symbol node
    html += '<div><span class="node-kind' + (data.kind ? ' kind-' + data.kind : '') + '">' + esc(data.kind || 'symbol') + '</span></div>';
    html += '<div class="node-label">' + esc(data.label || data.qualifiedName || data.id) + '</div>';
    html += '<div class="node-signature">' + esc(data.qualifiedName || '') + '</div>';
    html += '<div class="node-file">' + esc(data.file || '') + '</div>';
    if (data.doc) html += '<div class="node-doc"> \u201C' + esc(data.doc) + '\u201D</div>';

    if (cy) {
      const nodeRef = cy.getElementById(data.id);
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
  function wireClickableEdges(parentEl) {
    if (!parentEl) return;
    parentEl.querySelectorAll('.clickable-edge').forEach(function (el) {
      el.addEventListener('click', function () {
        var targetId = this.dataset.id;
        if (targetId) focusNode(targetId);
      });
      el.addEventListener('mouseenter', function () { this.style.background = '#292e42'; });
      el.addEventListener('mouseleave', function () { this.style.background = 'transparent'; });
    });
  }


  // ────────────────────────── Main render ────────────────────────────────

  function render(snapshot, groupMode) {
    const builder = groupMode ? buildCompoundElements : buildElements;
    const el = builder(snapshot);
    const container = document.getElementById('graph-container');
    if (cy) cy.destroy();
    container.innerHTML = '<div class="tooltip">Scroll to zoom \u00B7 Drag to pan \u00B7 Click to focus \u00B7 Double-click canvas to show all</div>';

    // Layout params — compound mode uses more spread to separate file groups
    const layoutOpts = groupMode
      ? { name: 'cose', animate: true, gravity: 0.25, numIter: 1000, idealEdgeLength: 220, nodeRepulsion: 2000000, padding: 100, randomize: true }
      : { name: 'cose', animate: true, gravity: 0.6, numIter: 1200, idealEdgeLength: 160, nodeRepulsion: 800000, padding: 40, randomize: true };

    cy = cytoscape({
      container: container,
      elements: [].concat(el.nodes, el.edges),
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'data(color)',
            label: '',
            'font-size': currentFontSize + 'px',
            color: '#a9b1d6',
            'text-valign': 'bottom',
            'text-halign': 'center',
            'text-margin-y': 6,
            width: 28,
            height: 28,
            'border-width': 2,
            'border-color': '#2f3346',
            'border-opacity': 0.8,
          },
        },
        {
          selector: 'node[_isFileGroup]',
          style: {
            'background-color': '#292e42',
            'background-opacity': 0.25,
            'border-width': 1.5,
            'border-color': '#414868',
            'border-opacity': 0.5,
            'border-style': 'dashed',
            shape: 'round-rectangle',
            padding: 30,
            'text-valign': 'top',
            'text-halign': 'center',
            'font-size': '11px',
            color: '#565f89',
            'font-weight': '600',
            label: 'data(label)',
            'z-compound-depth': 'bottom',
            'z-index': -1,
            width: 40,
            height: 40,
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
          selector: ':selected',
          style: { 'border-width': 3, 'border-color': '#e0af68' },
        },
      ],
      wheelSensitivity: 1.0,
    });

    // ── Font size slider ──
    var range = document.getElementById('font-range');
    if (range) {
      range.value = currentFontSize;
      document.getElementById('font-val').textContent = currentFontSize;
      range.oninput = function () {
        currentFontSize = parseInt(this.value);
        document.getElementById('font-val').textContent = currentFontSize;
        if (labelOverlay) labelOverlay.render();
      };
    }

    // ── Clear buttons for search boxes ──
    document.querySelectorAll('.clear-btn').forEach(function (btn) {
      btn.onclick = function () {
        var inp = document.getElementById(this.dataset.target);
        inp.value = '';
        inp.dispatchEvent(new Event('input'));
        inp.focus();
      };
    });

    // ── Run layout, then create label overlays after it settles ──
    var layout = cy.layout(layoutOpts);
    layout.one('layoutstop', function () {
      labelOverlay = createLabelOverlays();
      labelOverlay.render();
    });
    layout.run();

    // ── Tap node: focus; same node again: unfocus ──
    cy.on('tap', 'node', function (evt) {
      const target = evt.target;
      if (target.data('_isFileGroup')) {
        showDetails(target.data());
        return;
      }
      const id = target.id();
      if (focusedNodeId === id) {
        unfocusAll();
      } else {
        focusNode(id);
      }
    });


    // ── Double-tap background → unfocus all ──
    cy.on('dblclick', function (evt) {
      if (evt.target === cy) unfocusAll();
    });

    // ── Hover effects (skip file-group parents) ──
    cy.on('mouseover', 'node', function (evt) {
      if (evt.target.data('_isFileGroup')) return;
      if (!focusedNodeId) evt.target.style('border-color', '#e0af68');
    });
    cy.on('mouseout', 'node', function (evt) {
      if (evt.target.data('_isFileGroup')) return;
      if (!focusedNodeId) evt.target.style('border-color', '#2f3346');
    });

    // ── Focus indicator dismiss ──
    var dismissBtn = document.querySelector('.focus-dismiss');
    if (dismissBtn) dismissBtn.onclick = unfocusAll;

    // ── Group by file toggle ──
    document.getElementById('group-cb').onchange = function () {
      const oldCy = cy;
      cy = null;
      focusedNodeId = null;
      document.getElementById('focus-indicator').classList.remove('visible');
      document.getElementById('node-details').innerHTML = '<div class="empty">Click a node to see details</div>';
      oldCy.destroy();
      render(snapshot, this.checked);
    };

    // ── Search by name ──
    document.getElementById('search').oninput = function () {
      const q = this.value.toLowerCase();
      cy.nodes().forEach(function (n) {
        if (n.data('_isFileGroup')) return;
        const match = q === '' ||
          (n.data('label') || '').toLowerCase().includes(q) ||
          (n.data('qualifiedName') || '').toLowerCase().includes(q);
        n.data('search-hidden', !match);
        const pathHidden = n.data('path-hidden');
        const depthVisible = n.data('depth-visible') !== false;
        n.style('display', match && !pathHidden && depthVisible ? 'element' : 'none');
      });
      if (labelOverlay) labelOverlay.render();
    };

    // ── Search by path ──
    document.getElementById('search-path').oninput = function () {
      const q = this.value.toLowerCase();
      cy.nodes().forEach(function (n) {
        if (n.data('_isFileGroup')) return;
        const fp = (n.data('file') || '').toLowerCase();
        const matchPath = q === '' || fp.includes(q);
        n.data('path-hidden', !matchPath);
        const searchHidden = n.data('search-hidden');
        const depthVisible = n.data('depth-visible') !== false;
        n.style('display', matchPath && !searchHidden && depthVisible ? 'element' : 'none');
      });
      if (labelOverlay) labelOverlay.render();
    };


    // ── Kind filters ──
    function applyKindFilters() {
      const checked = {};
      document.querySelectorAll('#filters input[type="checkbox"]').forEach(function (cb) { checked[cb.value] = cb.checked; });
      const anyUnchecked = Object.values(checked).some(function (v) { return !v; });
      cy.nodes().forEach(function (n) {
        if (n.data('_isFileGroup')) return;
        const kindVisible = anyUnchecked ? (checked[n.data('kind')] !== false ? 'element' : 'none') : 'element';
        if (kindVisible === 'none') {
          n.style('display', 'none');
        } else {
          const searchHidden = n.data('search-hidden');
          const pathHidden = n.data('path-hidden');
          const depthVisible = n.data('depth-visible') !== false;
          n.style('display', !searchHidden && !pathHidden && depthVisible ? 'element' : 'none');
        }
      });
      if (labelOverlay) labelOverlay.render();
    }
    // Build kind filter checkboxes from snapshot data
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
    selectedMaxDepth = null; // reset on re-render
    // compute max depth from snapshot
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
      const anyDepthActive = selectedMaxDepth !== null;
      cy.nodes().forEach(function (n) {
        if (n.data('_isFileGroup')) return;
        const nd = n.data('depth');
        const passDepth = !anyDepthActive || nd <= selectedMaxDepth;
        n.data('depth-visible', passDepth);
        if (!passDepth) {
          n.style('display', 'none');
        } else {
          const searchHidden = n.data('search-hidden');
          const pathHidden = n.data('path-hidden');
          n.style('display', !searchHidden && !pathHidden ? 'element' : 'none');
        }
      });
      if (labelOverlay) labelOverlay.render();
    }
    // Add "All" button
    const allBtn = document.createElement('span');
    allBtn.className = 'depth-btn active';
    allBtn.textContent = 'All';
    allBtn.addEventListener('click', function () {
      selectedMaxDepth = null;
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
        selectedMaxDepth = parseInt(this.textContent);
        depthSelector.querySelectorAll('.depth-btn').forEach(function (b) { b.classList.remove('active'); });
        this.classList.add('active');
        applyDepthFilter();
      });
      depthSelector.appendChild(btn);
    }
  }

  // ────────────────────────── Init ───────────────────────────────────────

  fetch('graph.json')
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (data) {
      snapshot = data;
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
      render(data, false);
    })
    .catch(function (err) {
      document.getElementById('stats').textContent = 'Error loading graph.json';
      document.getElementById('node-details').innerHTML =
        '<div class="empty">Failed to load graph.json: ' + esc(err.message) +
        '<br><br>Run <code>codegraph snapshot . &gt; graph.json</code> then reload.</div>';
    });
})();


(function () {
  'use strict';

  // ────────────────────────────── Constants ──────────────────────────────

  const KIND_COLORS = {
    function: '#7aa2f7',
    method: '#7aa2f7',
    struct: '#9ece6a',
    enum: '#bb9af7',
    enum_variant: '#bb9af7',
    trait: '#f7768e',
    impl_block: '#e0af68',
    module: '#2ac3de',
    constant: '#ff9e64',
    static: '#ff9e64',
    type_alias: '#73daca',
    macro: '#f7768e',
    field: '#565f89',
    file: '#414868',
  };

  const EDGE_COLORS = {
    calls: { color: '#7aa2f7', width: 2, style: 'solid', arrow: true },
    defines: { color: '#565f89', width: 1, style: 'dotted', arrow: false },
    contains: { color: '#414868', width: 1.5, style: 'solid', arrow: false },
    imports: { color: '#73daca', width: 1.5, style: 'dashed', arrow: false },
    implements: { color: '#f7768e', width: 2, style: 'dashed', arrow: true },
    data_flow: { color: '#ff9e64', width: 2, style: 'solid', arrow: true },
    references: { color: '#bb9af7', width: 1, style: 'dashed', arrow: false },
    inherits: { color: '#e0af68', width: 1.5, style: 'dotted', arrow: false },
    extends: { color: '#9ece6a', width: 1, style: 'dotted', arrow: false },
  };

  const KIND_ORDER = ['function', 'method', 'struct', 'enum', 'enum_variant', 'trait', 'impl_block', 'module', 'type_alias', 'constant', 'static', 'macro', 'field'];

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
    // Use snake_case fields from the JSON schema
    var qn = key.qualified_name || key.qualifiedName || key.name || '';
    return (key.key === 'symbol' ? 'sym:' : 'def:') + (qn || '?') + (key.file ? '@' + key.file : '');
  }

  function resolveToSymbol(keyRef) {
    // keyRef is a key object directly: { key: "symbol", qualified_name: "...", file: "..." }
    // or { key: "anchored", ancestor: {...}, ordinal: N }
    if (!keyRef) return null;
    var cur = keyRef;
    // Walk the ancestor chain (anchored -> symbol)
    while (cur.key !== 'symbol') {
      if (cur.key === 'anchored' && cur.ancestor) {
        cur = cur.ancestor;
      } else {
        break;
      }
    }
    return cur;
  }

  // ────────────────────────── Element builders ───────────────────────────

  /// Hierarchical graph: folders -> files -> symbols as compound ancestors.
  function buildElements(snapshot) {
    const nodes = [], edges = [], added = new Set();
    const fileSymbols = new Map(); // filePath -> [{ id, key, kind, depth, doc }]
    for (const n of snapshot.nodes) {
      if (n.key.key !== 'symbol') continue;
      const id = nodeId(n.key);
      if (added.has(id)) continue;
      added.add(id);
      const file = n.file || 'unknown';
      if (!fileSymbols.has(file)) fileSymbols.set(file, []);
      fileSymbols.get(file).push({ id: id, key: n.key, kind: n.kind, depth: n.depth || 0, doc: n.attrs && n.attrs.doc || null });
    }
    // ---- Helpers ----
    function folderPart(fp) { var norm = fp.replace(/\\/g, '/'), i = norm.lastIndexOf('/'); return i >= 0 ? norm.substring(0, i) : ''; }
    function fileName(fp) { return fp.replace(/^.*[/\\]/, ''); }
    // ---- Build folder tree from file paths ----
    const folderMap = new Map();
    folderMap.set('', { parent: null, children: [], files: [] }); // root folder
    for (const _fp of fileSymbols.keys()) {
      var parts = _fp.replace(/\\/g, '/').split('/'), acc = '';
      for (var i = 0; i < parts.length - 1; i++) {
        var parent = acc;
        acc = acc ? acc + '/' + parts[i] : parts[i];
        if (!folderMap.has(acc)) {
          folderMap.set(acc, { parent: parent, children: [], files: [] });
          if (parent !== null) folderMap.get(parent).children.push(acc);
        }
      }
      folderMap.get(acc || '').files.push(_fp);
    }
    // ---- Create folder compound nodes ----
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
    // ---- Create file compound nodes with symbol children ----
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
    // ---- Build edges between symbol nodes ----
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
    return { nodes: nodes, edges: edges };
  }

  function shortLabel(key) {
    var qn = key.qualified_name || key.qualifiedName || key.name || key.label || '';
    var parts = qn.split('::');
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
        if (n.data('_isContainer')) return;
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
        if (n.data('_isContainer')) { if (span.parentNode) span.parentNode.removeChild(span); return; }
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
      if (n.data('_isContainer')) return;
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
      if (n.data('_isContainer')) return;
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
    if (data._isContainer) {
      html += '<div><span class="node-kind kind-' + (data._isFolder ? 'module' : 'file') + '">' + esc(data._filePath.replace(/^.*[\\/]/, '')) + '</span></div>';
      html += '<div class="node-file">' + esc(data._filePath) + '</div>';
      html += '<div class="node-attrs">' + data._nodeCount + ' items' + (data._collapsible ? ' \u00B7 click to collapse' : '') + '</div>';

      if (cy) {
        var isFolder = data._isFolder;
        var memberNodes;
        if (isFolder) {
          // For folders: list immediate child nodes (sub-folders and files)
          var folderId = data.id;
          memberNodes = cy.nodes().filter(function (n) {
            return n.data('parent') === folderId;
          });
          html += '<div class="edge-list"><h4>Contents (' + memberNodes.length + ')</h4>';
        } else {
          // For file containers: list symbol nodes
          memberNodes = cy.nodes().filter(function (n) {
            return !n.data('_isContainer') && n.data('file') === data._filePath;
          });
          html += '<div class="edge-list"><h4>Symbols (' + memberNodes.length + ')</h4>';
        }
        memberNodes.forEach(function (mn) {
          var mnKind = mn.data('kind') || (mn.data('_isFolder') ? 'folder' : (mn.data('_isFileContainer') ? 'file' : '?'));
          var mnLabel = mn.data('label') || mn.data('_filePath') || '';
          var mnColor = mn.data('_isFolder') ? '#737aa2' : (mn.data('_isFileContainer') ? '#565f89' : (KIND_COLORS[mn.data('kind')] || '#565f89'));
          var hint = mn.data('_collapsible') ? (mn.data('_collapsed') ? ' [+' : ' [−') : '';
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

  function render(snapshot) {
    const el = buildElements(snapshot);
    const container = document.getElementById('graph-container');
    if (cy) cy.destroy();
    container.innerHTML = '<div class="tooltip">Scroll to zoom \u00B7 Drag to pan \u00B7 Click to focus \u00B7 Double-click canvas to show all</div>';

    // Layout: hierarchical compound mode — high repulsion on containers prevents overlap
    const layoutOpts = {
      name: 'cose',
      animate: 'end',
      animationDuration: 800,
      gravity: 0.2,
      numIter: 1200,
      idealEdgeLength: 200,
      nodeRepulsion: function (node) {
        return node.data('_isContainer') ? 30000000 : 600000;
      },
      padding: 80,
      randomize: false,
      nodeDimensionsIncludeLabels: false,
    };

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
          selector: 'node[_isFileContainer]',
          style: {
            'background-color': '#292e42',
            'background-opacity': 0.25,
            'border-width': 1.5,
            'border-color': '#414868',
            'border-opacity': 0.5,
            'border-style': 'dashed',
            shape: 'round-rectangle',
            padding: 50,
            'text-valign': 'top',
            'text-halign': 'center',
            'font-size': '11px',
            color: '#565f89',
            'font-weight': '600',
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
            'border-width': 2,
            'border-color': '#3b4261',
            'border-opacity': 0.6,
            'border-style': 'solid',
            shape: 'round-rectangle',
            padding: 60,
            'text-valign': 'top',
            'text-halign': 'center',
            'font-size': '12px',
            color: '#737aa2',
            'font-weight': '700',
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
      if (target.data('_isContainer')) {
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
      if (evt.target.data('_isContainer')) return;
      if (!focusedNodeId) evt.target.style('border-color', '#e0af68');
    });
    cy.on('mouseout', 'node', function (evt) {
      if (evt.target.data('_isContainer')) return;
      if (!focusedNodeId) evt.target.style('border-color', '#2f3346');
    });

    // ── Focus indicator dismiss ──

    var dismissBtn = document.querySelector('.focus-dismiss');
    if (dismissBtn) dismissBtn.onclick = unfocusAll;

    // ── Collapse/expand containers (folders and files) ──
    cy.on('tap', 'node[_collapsible]', function (evt) {
      var cyNode = evt.target;
      var collapsed = cyNode.data('_collapsed');
      var descendants = cyNode.descendants();
      if (collapsed) {
        // Expand: show all descendants, then re-apply filters so filtered-out nodes stay hidden
        cyNode.data('_collapsed', false);
        cyNode.removeStyle('border-color');
        descendants.forEach(function (d) {
          if (!d.data('search-hidden') && !d.data('path-hidden') && d.data('depth-visible') !== false) {
            d.style('display', 'element');
          } else {
            d.style('display', 'none');
          }
        });
        // Re-apply kind filters (which also checks search/path/depth flags)
        if (typeof applyKindFilters === 'function') applyKindFilters();
      } else {
        // Collapse: hide all descendants
        descendants.style('display', 'none');
        cyNode.data('_collapsed', true);
        cyNode.style('border-color', '#e0af68');
      }
      if (labelOverlay) labelOverlay.render();
    });



    // ── Search by name ──
    document.getElementById('search').oninput = function () {
      const q = this.value.toLowerCase();
      cy.nodes().forEach(function (n) {
        if (n.data('_isContainer')) return;
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
        if (n.data('_isContainer')) return;
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
        if (n.data('_isContainer')) return;
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
        if (n.data('_isContainer')) return;
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
      render(data);
    })
    .catch(function (err) {
      document.getElementById('stats').textContent = 'Error loading graph.json';
      document.getElementById('node-details').innerHTML =
        '<div class="empty">Failed to load graph.json: ' + esc(err.message) +
        '<br><br>Run <code>codegraph snapshot . &gt; graph.json</code> then reload.</div>';
    });
})();


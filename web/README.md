# The web view

Pages here are **plain static files**: no build step, no bundler, no
`npm install`. Cytoscape.js is loaded from a CDN and the data is a single
`graph.json` sitting next to the page. There are two viewer *implementations* —
`web/refactor/app/*.js` (the current one) and the legacy single-file
`web/demo/index.html` — and two pages that use the first one: this repo's
snapshot, and the Python demo.

| Path | What it is | State |
|------|------------|-------|
| `web/refactor/` | Modular ES-module viewer (`app/*.js`): deterministic containment layout, focus mode with direction colours, details panel. Reads `web/refactor/graph.json`. | **Current** — this is the one under development |
| `web/python-demo/` | The refactor viewer re-pointed at a **Python** snapshot — a committed extract of an `agx-emulsion` checkout (41 files walked / 273 defs / 83 cross-file calls). Its `index.html` is a copy of the refactor page whose assets point one folder up, and it fetches its own `graph.json`. | Demo — shows the extractor's Python half in the browser |
| `web/demo/index.html` | The original single-file visualizer (~35 KB, CSS + JS inline). Reads `web/demo/graph.json`. | Legacy, frozen for reference |
| `web/*.py` | One-off regex patch scripts that used to edit `web/demo/index.html` by hand (`update_frontend.py`, `fix_frontend.py`, `analyze_callsites.py`). | Historical, not part of any build |

## Quick start

```powershell
# 1. Generate the snapshot the viewer reads (repo root).
cargo run --release -p cg-cli -- enrich . --output web/refactor/graph.json

# 2. Serve it. The viewer is an ES module and reads graph.json with fetch();
#    a file:// origin permits neither, so a double-clicked index.html shows
#    the sidebar over an empty canvas. Both pages detect that and say so.
python -m http.server 8000

# 3. Open http://localhost:8000/web/refactor/
```

`web/refactor/graph.json` is committed (~1.8 MB), so the view also works with no
Rust toolchain at all — you only need the command above to refresh it.

The legacy demo viewer reads `web/demo/graph.json`, which `codegraph enrich`
writes when you pass `--demo` (the path is currently hard-coded to
`web/demo/graph.json`, so the refactor viewer has to be pointed at with
`--output`).

### The Python demo page

`web/python-demo/` is the *same* viewer on a **Python** snapshot — the
`agx-emulsion` checkout, which lives outside this repo — so the extractor's
multi-language half is visible in the browser. It has its own `graph.json`
next to its page, and that page's assets point one folder up
(`../refactor/…`), so only the data differs. Regenerate it from the
checkout's **parent** folder, which keeps the keys relative to the project
(the tree's root becomes the project folder):

```powershell
$repo = 'D:\proyects\graphcodetree'
$proj = 'C:\Users\mrcgo\Desktop\prog\python\agx-emulsion'   # parent of agx-emulsion

cargo build --release --manifest-path "$repo\Cargo.toml" -p cg-cli
Push-Location $proj
& "$repo\target\release\codegraph.exe" enrich agx-emulsion --output "$repo\web\python-demo\graph.json"
Pop-Location
```

Then http://localhost:8000/web/python-demo/ (same server as above). What that
extract looks like: 273 defs in 34 of the 41 files it walks — the other seven
define nothing (seven files are empty, `scanner.py` is commented out,
`make_profiles.py` is module-level script code), and a box only exists for a
file that contributes a def. Two labels are worth knowing before comparing
the two pages: Python qualified names use `.` (`AgXPhoto.develop`) where Rust
uses `::`, and `shortLabel()` only splits on `::`, so the dots stay visible.

The calls in it are worth a paragraph of their own. The extractor wires only
the calls it can see *inside one file*, so every edge that crosses a file
boundary — 83 `calls`, and the 26 `data_flow` edges that follow them — was
added afterwards by `cg-enrich`'s `CallGraphEnricher`, from the caller's own
import records. Hints from Python are dotted (`pkg.mod.helper`), a spelling
that resolver only learnt later on: it used to split them on Rust's `::`, so
this snapshot showed 196 calls, every one of them inside a single file. Pinning
that count is what `.cgtest/python-demo.mjs` is for — no picture distinguishes
"calls resolved across files" from "calls that never left their file".

The 100 `imports` edges are still not drawn, and that is a different gap: they
start at the importing *file*, and `to_snapshot()` exports only definitions, so
`builder.js` cannot find the source endpoint and drops the edge. Fixing it means
mapping a file-keyed endpoint onto the viewer's `file:` container.

The export is **not byte-stable** — the store's maps decide the order of
`nodes`/`edges` — so regenerating rewrites the file. Keep this snapshot a real
one, like the refactor snapshot; `.cgtest/python-demo.mjs` asserts the
contents rather than the bytes.

## Input format — `graph.json`

A `Snapshot` as serialized by `codegraph enrich` (schema in `crates/ir/src/merge.rs`):

```jsonc
{
  "nodes": [
    {
      "key": {                      // NodeKey — the stable identity
        "key": "symbol",            //   "symbol" | "anchored"
        "lang": "rust",
        "file": ".\\crates\\ir\\src\\node.rs",
        "qualified_name": "Node::ast_kind",
        "kind": "field",
        "disambiguator": 0
      },
      "kind": "field",              // NodeKind (cross-language vocabulary)
      "label": "ast_kind",          // short name shown in the graph
      "ast_kind": "field_declaration",  // original tree-sitter kind
      "span": {                     // source provenance, 0-based rows
        "file": ".\\crates\\ir\\src\\node.rs",
        "start_byte": 1234, "end_byte": 1256,
        "start": { "row": 42, "col": 4 }, "end": { "row": 42, "col": 26 }
      },
      "attrs": {                    // NodeAttrs
        "signature": "ast_kind: String",   // omitted when absent
        "visibility": "private",           // private | crate | public
        "doc": "Original tree-sitter node kind ...",  // first doc paragraph
        "extra": { "depth": 1 }            // per-language extras
      },
      "file": ".\\crates\\ir\\src\\node.rs",
      "depth": 1                    // containment nesting (0 = top level)
    }
  ],
  "edges": [
    {
      "kind": "calls",              // contains | defines | imports | references
                                    // | calls | inherits | implements | data_flow
      "source": { /* NodeKey */ },  // call site (anchored) for `calls`
      "target": { /* NodeKey */ },
      "span": { /* optional */ },
      "weight": 1
    }
  ],
  "file_count": 18,
  "stats": {
    "total_nodes": 393, "total_edges": 2252,
    "function_count": 119, "struct_count": 32, "trait_count": 2, "impl_count": 10,
    "calls_edge_count": 268, "contains_edge_count": 1711,
    "impl_edge_count": 10, "data_flow_edge_count": 37
  }
}
```

Notes that bite when you write code against this file:

- **Line numbers are `span.start.row + 1`.** Rows are zero-based (tree-sitter
  `Point`s), humans are not.
- **`file` uses the separators the extractor saw** — on Windows that is
  `.\\crates\\extract\\src\\rust.rs`. `builder.js` normalizes with `normPath()`;
  do the same for any comparison.
- **`key` is the identity, `id` is not present.** Nodes and edges are keyed by
  `NodeKey`/`EdgeKey`, which is why `web/refactor` can diff a re-generated
  snapshot without caring about interning order. `utils.js:nodeId()` mints a
  DOM-safe id from a key.
- **`edges[].source` for `calls` is a call site**, not the caller: an `Anchored`
  key hanging off its enclosing function. The viewer resolves those with
  `utils.js:resolveToSymbol()` so the arrow points function → function.
- **The `stats` block is per-kind counts of definitions and `calls`/`contains`
  edges**, not of the snapshot's full edge set (2 252 edges vs. 268 + 1 711
  counted).

## What the view does

### Scene model (`builder.js`)

`buildElements()` turns the snapshot into cytoscape elements:

- **Containers.** `contains` edges become compound parent/child nesting. The
  detail level decides how deep that goes: `full` → folder → file → symbol,
  `files` → file → symbol, `flat` → symbols only (no compound nodes at all).
  Folder nodes are synthesized from path prefixes; file nodes come from
  `NodeKind::File`.
- **Symbols.** Every non-`file` definition node becomes a circle sized
  `S.nodeSize`, coloured from `KIND_COLORS` and labelled with its short name.
  Non-definition nodes (`call_site`, keyed `anchored`) are not drawn as
  circles — they exist only as edge endpoints, which `utils.js:resolveToSymbol()`
  rewrites to the enclosing function so a `calls` edge reads caller → callee.
- **Edges.** Colour, width, dash pattern and arrowhead come from
  `EDGE_COLORS[kind]`; width is further scaled by the edge's `weight`
  (`min(5, 1 + weight × 0.3)`, one step heavier per sum), so a call reached from
  twenty sites is visibly heavier than a single one.
- **Self-loops are dropped** (a call from inside a definition to itself):
  cytoscape draws them as a tiny knot that reads as noise. `wiring.mjs` pins
  the count.
- Boxes carry `_isContainer`, `_isFileContainer`, `_isCollapsible`, `_filePath`;
  every element carries `kind`, `color`, `weight`, and containers also
  `_collapsed`. Those data fields are what the stylesheet selectors, the filters
  and the aggregate-edge pass key off.

### Layout (`hierarchy.js`, `layout.js`)

The sidebar offers one engine, `hierarchy`: a deterministic containment packing
pass that lays each box out around its own children. Force-directed layout
(`cose`) and the cytoscape built-ins (`grid`, `breadthfirst`) still exist in
`layout.js` and are still driven by the harnesses, but they scatter the boxes
the hierarchy exists to keep, so they are no longer a user choice.

The engine is registered as a **normal cytoscape layout**
(`registerHierarchyLayout`, called once from `main.js`), so `{ name: 'hierarchy' }`
travels the same path as any built-in layout and nothing downstream is
special-cased.

Its contract, asserted by `.cgtest/validate.mjs`:

1. every child box sits inside its parent box (measured, not assumed);
2. sibling boxes never overlap, at any level;
3. every box measures exactly its children plus `2 × (padding + border)` — snug
   and symmetric around its own position, which is what makes 1 and 2 hold;
4. the result is deterministic: two runs produce identical positions;
5. the two shipped presets (`tree compact`, `tree roomy`) really change the
   packing while keeping 1–3.

Because the engine predicts each box from its children, the sizing inputs are
part of the geometry: `nodeSize`, `containerPadding`, `folderPadding`, the
`BORDERS` widths (cytoscape draws a border *outside* the box it belongs to) and
the tree gaps/aspect, all read from `state.js` and `constants.js`.

### Labels and metadata (`overlay.js`, `builder.js`)

Two modes, toggled by the *Native labels* checkbox:

| Mode | How | Behaviour |
|------|-----|-----------|
| DOM overlay (default) | one absolutely-positioned `<div>` per element, repositioned on zoom/pan/layout | fixed pixel size — text stays readable when the graph is zoomed out |
| Native labels | cytoscape's own `label: data(label)`, `text-valign: bottom` | scales with zoom, so it stays proportional to the circles |

The checkbox owns the *boxes* too, and each box is named exactly once: with the
overlay on, `main.js` starts every container at `label: ''`, so cytoscape draws
no label for it and the bright overlay span is the only name; with native labels
on, `applyLabelMode()` (`controls.js`) hands `data(label)` back to the file and
folder containers (the overlay is hidden in that mode, so nothing else would).
Letting a container keep its own `label` costs a second, dimmer copy of the name
underneath the overlay's, which reads as "the text is dim" — and no amount of
retuning `LABEL_COLORS` fixes that, because the copy is not on the palette.
A box's span is named from the basename of its `_filePath`; the root box stands
for the whole graph and has no path, so it falls back to the `label` the builder
gave it (`'root'`) — that used to be the one name cytoscape painted itself.

Line numbers (*Line numbers on labels*, on by default) are the start line of the
node's span, `span.start.row + 1`. The DOM overlay appends it as a separate
`.ln` span; the native path switches the element's label between `data(label)`
and `data(labelLine)`, which `builder.js` precomputes. **Box labels stay bare
names** — a folder called `line 3` is useless; a box's range lives in its
tooltip instead. That tooltip (DOM overlay, hover) carries the signature, the
`file:line:col` address, the byte range and the doc paragraph.

Every piece of that text is painted from one palette, `LABEL_COLORS` in
`constants.js` (`folder`, `file`, `symbol` and the `:line` beside a name), over
`LABEL_HALO` — the dark shadow the overlay puts behind a label so an edge
running through it does not eat it. Both modes read the same constants, which is
the point of having them: this used to be five literals across four files, and
the overlay had already drifted from itself (one pair when a label span was
first built, a brighter pair on the next pan, so box names changed colour the
moment you scrolled). `main.js`'s container stylesheet is on the palette now as
well — it carried the literal `#737aa2` for a folder name, which is exactly how
that second copy drifted from the overlay. `wiring.mjs` pins that the two paths
agree on the colours *and* that only one of them names a box, so retuning the
palette is a one-line edit in `constants.js` and nothing else.

### Focus mode and edge direction (`focus.js`, `constants.js`)

Clicking a symbol focuses it:

- everything not incident to it is dimmed. Opacity is derived from the node's
  own drawing alphas multiplied down its ancestor chain (`effectiveOpacity`), so
  a circle inside a dimmed file box dims exactly once, not twice;
- containers dim through `background-opacity` / `border-opacity` /
  `text-opacity`, so box chrome fades while the circles inside stay lit;
- **incident edges are recoloured by direction**: outgoing `#7dcfff` (cyan),
  incoming `#f7768e` (pink). The *tag* stays readable from the line style, the
  width and the details panel, which labels the two groups with the same
  colours;
- the focus indicator in the sidebar names the focused node and shows the
  `outgoing`/`incoming` swatches;
- clearing (click the node again, the ✕, or double-click the canvas) restores
  **each edge's exact previous colour** — the harness snapshots every colour
  before the focus and asserts the round trip, rather than hunting for hexes.

The incoming hue is deliberately the same pink `implements` uses: every warm hue
in the palette is already claimed by a tag, and `implements` is rare enough
(10 of 523 edges in the shipped snapshot) not to compete. When a pink tag edge
sits next to a pink incoming edge, the arrowhead, the line style and the details
panel disambiguate. If that ever becomes ambiguous, `constants.js` carries a
one-line alternative (amber `#e0af68`).

### Details panel (`details.js`)

Clicking a symbol fills the sidebar panel with:

- kind chip (in the kind's colour), label and **signature**;
- **address**: `file:line:col [startByte..endByte]`;
- `line N · ast: <tree-sitter kind>`, `depth N`, **visibility**, qualified name;
- the **doc** paragraph, when the extractor captured one;
- **Members** — children reached through `contains`, each clickable, with its
  own line number and signature;
- **Outgoing** / **Incoming** groups, each row showing the edge kind, an arrow
  and the other endpoint (clicking navigates/focuses it); rows standing for
  several collapsed edges show their aggregate count.

Clicking a collapsed container expands it *and* shows its details; clicking an
expanded one just collapses it.

### Filtering, search, collapse (`visibility.js`, `aggregate.js`, `controls.js`)

`refreshVisibility()` is a single pass that reads every filter and decides once
per node: collapsed ancestor → name search → path search → kind filter → depth
filter. Symbols are decided first and containers after them, deepest-first,
because a box has to know whether anything inside it survived — cytoscape will
not draw a node whose ancestor is hidden, so hiding a box for its own path miss
used to erase the matching circles inside it.

Collapsing a box also changes which edges exist. `aggregate.js` re-projects the
edges of hidden children onto whatever is still on screen: an edge from inside a
collapsed box to an outside symbol is drawn box → symbol, and box → box when
both ends are collapsed. Aggregate edges are dashed, sum their weights, keep the
first edge's colour and arrow flag, and disappear when the container is expanded
again. Nothing is invented — the aggregate set is a pure function of which
containers are collapsed.

The metrics HUD (`controls.js:updateMetrics`) reports zoom, graph extent,
node-size-in-pixels against label-size-in-pixels (the disproportion that
motivates the two label modes), the tree geometry of the last layout (levels,
boxes, symbols, cell size) and the active engine/detail/label/lines state.

## Interaction cheatsheet

| Input | Effect |
|-------|--------|
| Drag | pan |
| Scroll | zoom (`0.05`–`10`) |
| Click a symbol | focus it; click again to unfocus |
| Click a box | collapse it — or expand it, and then also show its details |
| Double-click the canvas | unfocus everything and re-fit |
| Hover a symbol | amber ring |
| Hover a label | tooltip: signature, address, byte range, doc |
| Click a row in Members / Outgoing / Incoming | focus that node |
| *Reset View* / *Re-layout* | re-fit to all elements / re-run the layout with the current params |
| *Reset params* | restore every slider and both selections to factory defaults |

## Module map

| File | Responsibility |
|------|----------------|
| `app/main.js` | bootstrap: fetch `graph.json`, build the cytoscape instance + stylesheet, event handlers, kind filters, depth selector, search, stats header |
| `app/state.js` | `S` — the single mutable state object, factory defaults, `resetParams()`, `PRESETS`/`applyPreset()` |
| `app/constants.js` | `KIND_COLORS`, `EDGE_COLORS`, `DIRECTION_COLORS`/`DIRECTION_NAMES`/`DIRECTION_ARROWS`, `LABEL_COLORS`/`LABEL_HALO`, `BORDERS`, `KIND_ORDER` |
| `app/builder.js` | snapshot → elements: compound boxes, symbol nodes, edges, `label`/`labelLine`, path normalization |
| `app/hierarchy.js` | the `'hierarchy'` engine: deterministic containment packing |
| `app/layout.js` | layout options from live state, `runLayout()`, post-layout overlay refresh + re-fit |
| `app/visibility.js` | the single-pass filter (collapse + search + kind + depth), `toggleContainer()` |
| `app/aggregate.js` | aggregated edges for collapsed containers |
| `app/overlay.js` | DOM label overlay + tooltips, native-label switch |
| `app/focus.js` | focus/dim, direction recolouring, exact-colour restore |
| `app/details.js` | the details panel (signature/address/visibility/ast/doc, Members, Outgoing/Incoming) |
| `app/controls.js` | wires every sidebar control to state, applies instantly, HUD metrics |
| `app/utils.js` | `esc`, `nodeId`, `resolveToSymbol`, `shortLabel`, `relPath`, `addressOf` |
| `style.css` | sidebar, panels, overlay labels, focus indicator, legend swatches |

`main.js` is the only module that touches the global `cytoscape` (it registers
the engine there), and `details.js` receives `focusNode` through a setter
(`setFocusHandler`) instead of importing `focus.js`, which would close an import
cycle (`focus → visibility → details`).

## Colour reference

| Kind | Colour | | Kind | Colour |
|------|--------|-|------|--------|
| `function`, `method` | `#7aa2f7` | | `module` | `#2ac3de` |
| `struct` | `#9ece6a` | | `constant`, `static` | `#ff9e64` |
| `enum`, `enum_variant` | `#bb9af7` | | `type_alias` | `#73daca` |
| `trait` | `#f7768e` | | `macro` | `#f7768e` |
| `impl_block` | `#e0af68` | | `field` | `#565f89` |

| Edge kind | Colour | Style | Arrow |
|-----------|--------|-------|-------|
| `calls` | `#7aa2f7` | solid | yes |
| `defines` | `#565f89` | dotted | no |
| `contains` | `#414868` | solid | no |
| `imports` | `#73daca` | dashed | no |
| `implements` | `#f7768e` | dashed | yes |
| `data_flow` | `#ff9e64` | solid | yes |
| `references` | `#bb9af7` | dashed | no |
| `inherits` | `#e0af68` | dotted | no |
| `extends` | `#9ece6a` | dotted | no |

Focused incident edges: outgoing `#7dcfff`, incoming `#f7768e`
(`DIRECTION_COLORS`).

Text drawn on the graph (`LABEL_COLORS` in `constants.js`; the DOM overlay and
cytoscape's native labels both read it, and `wiring.mjs` pins that they agree):
folder `#ffffff`, file `#dde0f1`, symbol `#a9b1d6`, `:line` `#b1b8d9` — all over
the `#0f0f1a` halo (`LABEL_HALO`). The sidebar's own panel text is a separate
palette and lives in `style.css`.

## Tests

Three Node harnesses live in `.cgtest/` and run the **real app modules against a
real `graph.json`** inside headless cytoscape (`.cgtest/cytoscape.min.cjs`):

```powershell
node --experimental-default-type=module .cgtest/validate.mjs     # layout invariants (44 assertions)
node --experimental-default-type=module .cgtest/wiring.mjs       # UI wiring, focus, metadata, palette (252 assertions)
node --experimental-default-type=module .cgtest/python-demo.mjs  # the Python snapshot: keys, cross-file calls, builder, layout, page copy (77 assertions)
```

- `validate.mjs` drives `state.js`, `builder.js`, `layout.js` and `hierarchy.js`
  directly and asserts the five engine invariants above, including the preset
  behaviour.
- `wiring.mjs` parses `index.html` for the ids, ranges, selects and preset
  buttons it declares, builds a DOM shim from exactly that, then runs the
  **real** `initControls()` and drives every control the way a user would —
  sliders, checkboxes, selects, preset buttons, search boxes, container
  collapse, focus/unfocus. It exists because `bindRange()` in `controls.js`
  returns silently when its element is missing, so one mistyped id in
  `index.html` turns a control into a no-op with no error anywhere.
- its last section pins the one thing two independent code paths could silently
  disagree about: the colour of label text (`LABEL_COLORS`), asserted on the DOM
  overlay's spans and on cytoscape's computed style in native-label mode — plus
  that a box is named *once* (the overlay's span while the overlay is on, the
  native label when the checkbox hands the name over), including the root box,
  which has no `_filePath` to take a basename from.
- `python-demo.mjs` exists because the demo page is a *copy* of `index.html` and
  its snapshot is one the other two harnesses never load. It asserts the Python
  snapshot's keys and `stats` block, counts the calls that cross a file boundary
  (the enricher's work, and the one thing a screenshot cannot show), runs the
  real `builder.js` at all three detail levels and the real hierarchy layout over
  that tree, then parses both pages and fails if their ids, sliders (with bounds),
  selects or preset buttons differ — and if any local reference on the demo page
  stops resolving. It also pins the inline boot guard that both pages carry (both
  silent-empty-canvas cases, see below) and requires the two copies of it to stay
  textually identical.

All three print `FAIL <label>` per failing check and exit non-zero. Convention
after touching `web/refactor/**` or `web/python-demo/**`: run all three, and for
a guard that is *supposed* to catch something, verify it bites by mutating the
code so the check must fail, then revert the mutation.

`wiring.mjs` reads `web/refactor/graph.json` and `python-demo.mjs` reads
`web/python-demo/graph.json`, so regenerating either changes what is asserted
(node/edge counts, label rules). Keep both real snapshots — of this repo and of
the Python checkout; write throwaway snapshots elsewhere.

### Two ways the page silently shows an empty canvas

Both `index.html` files carry the *same* inline guard, because two completely
different misconfigurations look identical — a live sidebar above a blank canvas,
with no error shown anywhere:

1. **A `file://` origin.** Browsers run neither ES modules nor `fetch()` there,
   so `main.js` never executes at all. Detected synchronously, at load.
2. **A server rooted at the page's own folder.** The pages take their code from a
   sibling folder (`../refactor/…`) and their data from next to themselves, so
   `python -m http.server 8000 --directory web/python-demo` 404s the module
   script and the graph never appears. Only the repository root serves both.

Case 2 can only be spotted by *absence*, so the guard arms a timer: `main.js`
writes `#stats` the moment the snapshot arrives, which means a `#stats` still
holding `Loading…` after a few seconds proves nothing ever started. The guard
then prints the command that fixes it, in the details panel. It has to be a plain
`<script>` — a module script would be blocked by the very rule case 1 detects,
and `main.js` never gets to run — and the two copies are byte-identical (asserted
by `python-demo.mjs`).

That case *can* be checked without a browser (the harnesses assert the guard is
present and identical on both pages), but a real boot was verified too — Edge
and Chrome both work headlessly (found at `C:\Program Files\Google\Chrome\
Application\chrome.exe`):

```powershell
python -m http.server 8123 --directory .     # in another shell, repo root
& $chrome --headless=new --virtual-time-budget=10000 `
    --dump-dom 'http://127.0.0.1:8123/web/python-demo/'
```

The dump is the DOM *after* the page has run, so it shows `#stats` filled with
the snapshot's own numbers and three `<canvas>` elements inside
`#graph-container` — i.e. the viewer booted on the Python tree. Add
`--screenshot=shot.png --window-size=1600,900` to a second run if you want to
look at the boxes. Pointing the server at `web/python-demo` itself (`--directory
web/python-demo`, then `http://127.0.0.1:8123/`) reproduces case 2: the same dump
then shows `Loading…`, zero canvases and the guard's explanation; a `file://` URL
shows the other message.

### What the harnesses cannot see

Everything drawn on the canvas is measured through cytoscape's **model**, not
through pixels. Palette contrast, tooltip placement, hover rings and the look of
the focus dimming still need a human eye — which is why the interaction
cheatsheet above doubles as a manual smoke-test list.

## Known gaps / next steps

- **No source pane.** Addresses and line numbers are displayed, but there is no
  jump-to-source editor (Phase 4 in the root README).
- **No live updates.** `graph.json` is fetched once; the WebSocket delta path
  (`cg-server`) does not exist yet.
- **No language badge or filter.** Both languages extract and render now — the
  refactor page shows this Rust repo, `web/python-demo/` shows a Python
  checkout — but the viewer draws no `lang` badge, has no per-language filter,
  and colours by `kind` only. The sidebar's counters are the cross-language
  vocabulary (`function_count`, `calls_edge_count`, …), so a Python snapshot
  reports `0 structs / 0 traits / 0 impls` by design. Tracked in
  [../docs/NEXT-SESSION.md](../docs/NEXT-SESSION.md).
- **A file that defines nothing gets no box.** File containers are built from
  the defs a file contributes, and the CLI skips empty files, so a def-less
  file is invisible in the tree: the Python demo walks 41 files and draws 34
  file boxes.
- `web/demo/` is kept for comparison only; new work belongs in `web/refactor/`.

# graphcodetree

Extract a **structured, keyed code graph** from source code — the semantic skeleton of a codebase, designed for LLM tool-use, interactive browsing, and graph-to-code edit intents.

Built on [tree-sitter](https://tree-sitter.github.io/), the graph survives incremental edits (body changes are upserts, not remove+add), uses stable keys so identity persists across re-extraction, and abstracts language-specific grammar kinds into a small cross-language vocabulary.

## Why a code graph?

A text file is a linear byte sequence. A code graph is its **semantic skeleton**: functions, structs, traits, modules, calls, imports, and containment — all explicitly connected. This unlocks:

- **LLM context maps** — render a project tree with signatures and doc comments, staying within token budgets via semantic zoom
- **Graph-to-code edits** — drag a function to move it, draw an edge to insert a call, rename a symbol across files
- **Live incremental updates** — tree-sitter re-parses the changed range, the extractor diffs against the previous keyed snapshot, only tiny deltas flow over the wire
- **Polyglot normalization** — `function_item` (Rust), `function_definition` (Python), `function_declaration` (TypeScript) all collapse to `NodeKind::Function`

## Architecture (target)

The full pipeline has four layers. Extraction produces keyed ops; the store interns keys into runtime IDs, versioned ingest/apply of deltas; enriching layers query the store and add semantic edges; the server broadcasts to clients via WebSocket.

```
                  +------------------+
file edit ------>|  cg-extract      |--- KeyOp[] (NodeKey/EdgeKey-based, self-contained)
                  +--------+---------+
                           |
                  +--------v---------+
                  |  cg-store        |--- intern keys -> NodeId/EdgeId, versioned ingest/apply
                  +--------+---------+
                           |
                  +--------v---------+
                  |  cg-enrich       |--- query store, produce GraphDelta (Imports, Calls, Implements, DataFlow)
                  +--------+---------+
                           |
             +-------------+-------------+
             v             v             v
      cg-project      cg-server      cg-intent
      (LLM maps)   (axum WS + web)  (EditIntent -> WorkspaceEdit)
```

## Pipeline & Status

| Layer | Crate | Path | Status | What's done |
|-------|-------|------|--------|-------------|
| **Schema** | `cg-ir` | `crates/ir/` | ✅ Complete | NodeKind, EdgeKind (incl. DataFlow), NodeKey, EdgeKey, Span, NodeAttrs, GraphDelta, GraphOp, EditIntent, IntentOutcome, ViewSpec — full serde round-trip, zero runtime deps |
| **Structure** | `cg-extract` | `crates/extract/` | 🟡 Mostly done | Rust tree-walk extractor: two-pass def registration + call resolution, stable keyed identity, same-file scope resolution, import flattening, intra-function data flow tracking (`flows_from` annotation on call sites), incremental `diff()` |
| **Semantic** | `cg-enrich` | `crates/enrich/` | 🟡 Mostly done | `Enricher` trait + `run_pipeline()`, four enrichers (`ImportResolver`, `CallGraphEnricher`, `ImplTraitEnricher`, `DataFlowEnricher` — produces `DataFlow` edges from `flows_from` annotations) |
| **Store** | `cg-store` | `crates/store/` | ✅ Complete | Monotonic interning, `ingest()`, `apply()`, query methods, `to_snapshot()` + `snapshot(&ViewSpec)`, 6 store + 3 intern tests |
| **Intents** | `cg-intent` | ❌ Not started | Empty | EditIntent validation rules, span→text compilation, legality table |
| **Projection** | `cg-project` | 🔴 Stubs only | Stubs | `DetailLevel` enum + `render_map()` signature exist, no implementation |
| **Server** | `cg-server` | ❌ Not started | Empty | axum WebSocket server, file watcher (notify), delta broadcast |
| **CLI** | `cg-cli` | `crates/cli/` | 🟡 Mostly done | clap-based command runner, extract-and-json-serialize pipeline, no store or enrichment wiring yet |

### Key design choices

- **Extraction is stateless**: produces self-contained `KeyOp[]` arrays keyed by `NodeKey` (language, file path, qualified name, kind, disambiguator). The extractor never sees a `NodeId`.
- **Store is the single source of truth**: it interns `NodeKey` -> `NodeId`, assigns `EdgeId`s monotonically, enforces version monotonicity on ingest/apply, and owns all node/edge storage. Query methods provide read access for enrichers and broadcast.
- **Enrichment is additive**: enrichers are stateless `Enricher` implementations that query the store and return `GraphDelta`s of new edges. These are applied via `store.apply()` and broadcast.
- **Keys are stable across body edits**: A function retains its `NodeKey` when its body changes -- only `NodeAttrs.signature`, `.doc`, and `.span` update. Identity churn only happens on structural delete+recreate.

### NodeKey design

```
NodeKey::Symbol { lang, file, qualified_name, kind, disambiguator }
   vs.
NodeKey::Anchored { ancestor, ast_kind, ordinal }
```

| Variant | Used for | Identity stability |
|---------|----------|-------------------|
| `Symbol` | Named definitions (fn, struct, enum, trait) | Stable across renames, moves to other files -- same qualified name == same key |
| `Anchored` | Call sites, anonymous constructs | Edits in other parts of the file |

The `diff()` function compares two `FileGraph`s key-by-key and produces `KeyOp::UpsertNode` / `KeyOp::RemoveEdge` etc. -- identity churn only happens when a construct is genuinely deleted or renamed.

## The IR Vocabulary

### Node Kinds

`File`, `Module`, `Struct`, `Enum`, `EnumVariant`, `Trait`, `Interface`, `ImplBlock`, `Function`, `Method`, `Field`, `Constant`, `Static`, `TypeAlias`, `Macro`, `CallSite`

### Edge Kinds

`Contains` (hierarchy tree), `Defines` (type -> member), `Imports`, `References`, `Calls`, `Inherits`, `Implements`, `DataFlow` (value produced by one call consumed as argument by another)

### Attributes

Each node carries optional `signature`, `visibility` (Private/Crate/Public), `doc` (first doc-comment paragraph), and an `extra` map for per-language extensions.

## Data Flow

The pipeline produces **intra-function data flow** edges by identifying when a call's result is captured by a variable binding and that variable later appears as an argument to another call.

### How it works

1. **Extraction phase** (`crates/extract/src/rust.rs`): The `extract_calls` function walks each function body in source order using a flat traversal. It maintains a `bindings` map that tracks which call ordinal produced each variable. When a `let` binding or `=` assignment captures a call result (e.g., `let x = foo();`), the bound variable name is associated with the call's ordinal. When a subsequent call passes that variable as an argument (e.g., `bar(x)`), a `flows_from` annotation is emitted on the call site node — e.g., `"0->0"` meaning argument 0 flows from call ordinal 0.

2. **Enrichment phase** (`crates/enrich/src/data_flow.rs`): The `DataFlowEnricher` reads `flows_from` annotations from call site nodes and creates `DataFlow` edges connecting the consumer call site (source) to the producer call site (target).

### Supported patterns

```rust
// Simple binding
let x = foo();
bar(x);              // flows_from: "0->0"

// Reference argument
let y = baz();
qux(&y);             // flows_from: "0->2"

// Tuple destructuring
let (a, b) = foobar();
both(a, &b);         // flows_from: "0->4,1->4"
```

The `extract_identifier_name` helper unwraps `&`, `&mut`, `*`, and field expressions to resolve the underlying variable name before looking it up in the bindings map.

## Query File

The project includes a tree-sitter query file (`queries/rust.scm`) that drives capture-based extraction:

```scheme
(function_item name: (identifier) @name) @definition.function
(struct_item   name: (type_identifier) @name) @definition.type
(call_expression function: (identifier) @name) @reference.call
(use_declaration) @import
```

This provides an alternative, query-driven extraction path alongside the direct AST walk in the Rust extractor.

## Planned Languages

The `Lang` enum already includes variants for: **Rust**, **Python**, **TypeScript**, **TSX**, **JavaScript**, **Go**, **C**, **C++**, **Java**. Extractors beyond Rust are forthcoming.

## Roadmap

### Phase 1 -- Structure extraction ✓
- [x] `cg-ir`: full canonical schema with serde round-trip
- [x] `cg-extract`: Rust tree-walk extractor (two-pass, keyed, same-file resolution)
- [x] Incremental `diff()` producing `KeyOp` streams
- [x] `queries/rust.scm`: tree-sitter query file for Rust
- [x] `cg-store`: `GraphStore` with interning, `ingest()`, `apply()`, `snapshot()`, query API
- [x] `cg-enrich`: `Enricher` trait + `run_pipeline()`, import resolver, call graph, impl/trait enrichers, data flow enricher
- [x] Intra-function data flow tracking: `flows_from` on call sites, `DataFlow` edges
- [x] **MVP demo**: one-shot static graph from a Rust codebase ➔ JSON ➔ HTML visualizer

### Phase 2 — Multi-file & cross-file ✓
- [x] Directory-walking CLI (`codegraph snapshot` / `codegraph enrich`)
- [x] Full pipeline: extract → ingest → enrich → snapshot with `codegraph enrich`
- [x] Cross-file module resolution (`mod foo;` → `foo.rs` / `foo/mod.rs`)
- [x] Cross-file import resolution (qualified-name lookup across files)
- [x] Cross-file call graph enrichment (resolves `imported`, `path_unresolved`, `method_unresolved` call sites)
- [x] **Depth / nesting level**: each definition node carries a `depth: u32` field (top-level = 0, nested inside modules/impls = 1, fields/variants inside structs/enums = 2, etc.), used for proportional dimming during focus mode in the visualizer
- [ ] Extract Python, TypeScript, Go via tree-sitter queries
- [ ] Crate-graph builder (external dependency discovery from `Cargo.toml`)

### Phase 3 -- Semantic enrichment (next)
- [ ] Dogfood: test enrichment on real workspace
- [ ] Type inference / method dispatch enricher
- [ ] `cg-project`: `DetailLevel` renderer, PageRank-based token budgeting
- [ ] `cg-intent`: EditIntent validation, span-to-text compilation, legality table

### Phase 4 -- Server & real-time
- [ ] `cg-server`: axum WebSocket server, file watcher (notify), delta broadcast
- [ ] `web/`: TypeScript normalized store, Cytoscape.js graph canvas, Monaco code pane
- [ ] `codegraph serve`: CLI command to start the dev server
- [ ] Live incremental re-extraction on file save

### Phase 5 -- LLM integration
- [ ] Tool API: LLM agents can call `expand()`, submit `EditIntent`, receive `WorkspaceEdit`
- [ ] Aider-style text map with inline `[n:ID]` references
- [ ] Semantic zoom: collapse modules into summary edges within token budget

## Next Session Goals

### 1. Crate-graph & TOML discovery
- [ ] Parse `Cargo.toml` files for external dependency names → map to `crate::` import prefixes
- [ ] Build crate-level nodes and edges showing inter-crate dependency
- [ ] Resolve `use crate_name::...` imports against real crate types (fallback: stub crate nodes)

### 2. Deeper cross-file resolution
- [ ] Make `CallGraphEnricher` re-check cross-file calls after import resolution adds new edges
- [ ] Resolve `super::` and `crate::`-relative paths by walking directory hierarchy
- [ ] Handle glob re-exports (`pub use foo::*;`)

### 4. Visualizer polish
- [ ] Collapsible edge legend with color swatches and checkboxes to toggle edge kinds
- [ ] "Show only connected" toggle that hides isolated nodes
- [ ] Depth slider: filter nodes by max depth to see only shallow vs. deep structure
- [ ] PNG export button for the graph canvas

### 5. Export & stats
- [ ] Per-kind edge counts in the stats header (how many Calls, Imports, etc.)
- [ ] Node/edge count changes after filtering/searching
- [ ] JSON schema documentation page

## License

MIT

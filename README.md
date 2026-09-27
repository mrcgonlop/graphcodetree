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

The full pipeline has four layers. Extraction produces keyed data; the store interns keys into runtime IDs and applies deltas; enriching layers add semantic edges; the server broadcasts to clients via WebSocket.

```
                 ┌──────────────┐
file edit ──────▶│  cg-extract  │─── FileGraph (NodeKey-based, self-contained)
                 └──────┬───────┘
                        │
                 ┌──────▼──────���┐
                 │  cg-resolve  │─── cross-file name resolution
                 └──────┬───────┘
                        │
                 ┌──────▼───────┐
                 │  cg-enrich   │─── call graphs, impls, types (semantic, lazy)
                 └──────┬───────┘
                        │
                 ┌──────▼───────┐
                 │   cg-store   │─── intern keys → NodeId/EdgeId, versioned apply
                 └──────┬───────┘
                        │
          ┌─────────────┼─────────────┐
          ▼             ▼             ▼
   cg-project      cg-server      cg-intent
   (LLM maps)   (axum WS + web)  (EditIntent → WorkspaceEdit)
```

## Pipeline & Status

| Layer | Crate | Path | Status | What's done |
|-------|-------|------|--------|-------------|
| **Schema** | `cg-ir` | `crates/ir/` | ✅ Complete | NodeKind, EdgeKind, NodeKey, EdgeKey, Span, NodeAttrs, GraphDelta, GraphOp, EditIntent, IntentOutcome, ViewSpec — full serde round-trip, zero runtime deps |
| **Structure** | `cg-extract` | `crates/extract/` | 🟡 Mostly done | Rust tree-walk extractor: two-pass def registration + call resolution, stable keyed identity, same-file scope resolution, import flattening, incremental `diff()` |
| **Symbols** | `cg-resolve` | ❌ Not started | Empty | Cross-file crate paths, `mod foo;` joining, method receiver resolution |
| **Semantic** | `cg-enrich` | ❌ Not started | Empty | Full call graph construction, impl/trait hierarchy, type inference hints |
| **Store** | `cg-store` | 🔴 Stubs only | Stubs | `GraphStore` struct + method signatures exist, no interning, no `apply()`, no `snapshot()` |
| **Intents** | `cg-intent` | ❌ Not started | Empty | EditIntent validation rules, span→text compilation, legality table |
| **Projection** | `cg-project` | 🔴 Stubs only | Stubs | `DetailLevel` enum + `render_map()` signature exist, no implementation |
| **Server** | `cg-server` | ❌ Not started | Empty | axum WebSocket server, file watcher (notify), tool API for LLM agents |
| **CLI** | `cg-cli` | ❌ Not started | Empty | `codegraph index`, `codegraph map`, `codegraph serve` commands |
| **Web client** | `web/` | ❌ Not started | Empty | TypeScript normalized store, Cytoscape.js graph renderer, Monaco code pane |
| **Queries** | `queries/` | 🟡 Partial | Only `rust.scm` | tree-sitter query files per language for capture-based extraction |

## Getting Started

### Prerequisites

- Rust 2021 edition or later
- A C compiler (for tree-sitter grammar compilation)

### Build & Test

```bash
# Build all crates
cargo build

# Run all tests
cargo test

# Run extraction tests with output
cargo test -p cg-extract -- --nocapture
```

### Quick Example — Extract a Rust file

```rust
use cg_extract::{RustExtractor, SourceFile, Extractor};

let source = SourceFile {
    path: "src/main.rs".into(),
    lang: cg_ir::Lang::Rust,
    text: r#"
        pub fn greet(name: &str) -> String {
            format!("Hello, {}!", name)
        }
    "#.to_string(),
};

let extractor = RustExtractor;
let graph = extractor.extract(&source).expect("extract");

println!("{} nodes, {} edges, {} imports",
    graph.nodes.len(), graph.edges.len(), graph.imports.len());
```

### Incremental Extraction

```rust
use cg_extract::{extract_delta, SourceFile};
use cg_ir::Lang;

let file = SourceFile {
    path: "src/lib.rs".into(), lang: Lang::Rust,
    text: original_text.to_string(),
};

let (graph, ops) = extract_delta(&extractor, &file, None).unwrap();

// After editing the file:
let file = SourceFile { text: edited_text, ..file };
let (new_graph, ops) = extract_delta(&extractor, &file, Some(&graph)).unwrap();
// ops is now incremental: only the changed keys
```


## How Extraction Works

### Two-Pass Walk (Rust)

1. **Pass 1 — Registration** (`walk_items`): Walks the AST root, emitting a `NodeKey::Symbol` for every definition (function, struct, enum, trait, impl block, module, constant, type alias, macro). Registers the qualified name in `defs_qualified` and the simple name in `defs_simple`. Queues function/method bodies as `call_jobs`.

2. **Pass 2 — Call resolution** (`extract_calls`): For each queued body, walks descendants looking for `call_expression` and `macro_invocation` nodes. Resolves each callee syntactically:
   - `identifier` → unique same-file definition (`same_file`), imported name (`imported`), or `unresolved`
   - `scoped_identifier` (`Thing::new`) → qualified lookup (`same_file`) or `path_unresolved`
   - `field_expression` (`self.log()`, `t.bump()`) → self-method lookup (`self_method`) or `method_unresolved`
   - Everything else → `dynamic`

Call sites get `NodeKey::Anchored` keys, anchored to the nearest stable ancestor + ordinal, so edits elsewhere in the file don't renumber them.

### Keyed Identity

| Key type | Used for | Survives |
|----------|----------|----------|
| `NodeKey::Symbol { lang, file, qualified_name, kind, disambiguator }` | Named definitions | Body edits, span changes, attribute changes |
| `NodeKey::Anchored { ancestor, ast_kind, ordinal }` | Call sites, anonymous constructs | Edits in other parts of the file |

The `diff()` function compares two `FileGraph`s key-by-key and produces `KeyOp::UpsertNode` / `KeyOp::RemoveEdge` etc. — identity churn only happens when a construct is genuinely deleted or renamed.

## The IR Vocabulary

### Node Kinds

`File`, `Module`, `Struct`, `Enum`, `EnumVariant`, `Trait`, `Interface`, `ImplBlock`, `Function`, `Method`, `Field`, `Constant`, `Static`, `TypeAlias`, `Macro`, `CallSite`

### Edge Kinds

`Contains` (hierarchy tree), `Defines` (type → member), `Imports`, `References`, `Calls`, `Inherits`, `Implements`

### Attributes

Each node carries optional `signature`, `visibility` (Private/Crate/Public), `doc` (first doc-comment paragraph), and an `extra` map for per-language extensions.

## Data Flow

```
edit → tree-sitter reparse
     → extract_delta(extractor, file, prev)
     → Vec<KeyOp>
     → cg-store intern keys → GraphDelta (NodeId/EdgeId based)
     → broadcast to all clients
     → UI re-renders / LLM receives snapshot delta
```

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

### Phase 1 — Structure extraction (current)
- [x] `cg-ir`: full canonical schema with serde round-trip
- [x] `cg-extract`: Rust tree-walk extractor (two-pass, keyed, same-file resolution)
- [x] Incremental `diff()` producing `KeyOp` streams
- [x] `queries/rust.scm`: tree-sitter query file for Rust
- [ ] **MVP demo**: one-shot static graph from a Rust codebase → JSON → HTML visualizer

### Phase 2 — Multi-file & cross-file
- [ ] `cg-resolve`: `mod foo;` joining, `use` path resolution, crate graph
- [ ] `cg-store`: NodeKey → NodeId interning, versioned `apply()`, `snapshot()`
- [ ] Directory-walking CLI (`codegraph index`)
- [ ] Extract Python, TypeScript, Go via tree-sitter queries

### Phase 3 — Semantic enrichment
- [ ] `cg-enrich`: full call graph (cross-file `Calls`), impl/trait wiring, type hints
- [ ] `cg-project`: `DetailLevel` renderer, PageRank-based token budgeting
- [ ] `cg-intent`: EditIntent validation, span→text compilation, legality table

### Phase 4 — Server & real-time
- [ ] `cg-server`: axum WebSocket server, file watcher (notify), delta broadcast
- [ ] `web/`: TypeScript normalized store, Cytoscape.js graph canvas, Monaco code pane
- [ ] `codegraph serve`: CLI command to start the dev server
- [ ] Live incremental re-extraction on file save

### Phase 5 — LLM integration
- [ ] Tool API: LLM agents can call `expand()`, submit `EditIntent`, receive `WorkspaceEdit`
- [ ] Aider-style text map with inline `[n:ID]` references
- [ ] Semantic zoom: collapse modules into summary edges within token budget

## License

MIT


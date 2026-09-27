# graphcodetree

Extract a **structured, keyed code graph** from source code — the semantic skeleton of a codebase, designed for LLM tool-use, interactive browsing, and graph-to-code edit intents.

Built on [tree-sitter](https://tree-sitter.github.io/), the graph survives incremental edits (body changes are upserts, not remove+add), uses stable keys so identity persists across re-extraction, and abstracts language-specific grammar kinds into a small cross-language vocabulary.

## Why a code graph?

A text file is a linear byte sequence. A code graph is its **semantic skeleton**: functions, structs, traits, modules, calls, imports, and containment — all explicitly connected. This unlocks:

- **LLM context maps** — render a project tree with signatures and doc comments, staying within token budgets via semantic zoom
- **Graph-to-code edits** — drag a function to move it, draw an edge to insert a call, rename a symbol across files
- **Live incremental updates** — tree-sitter re-parses the changed range, the extractor diffs against the previous keyed snapshot, only tiny deltas flow over the wire
- **Polyglot normalization** — `function_item` (Rust), `function_definition` (Python), `function_declaration` (TypeScript) all collapse to `NodeKind::Function`

## Architecture

```
                  ┌─────────────┐
  file edit ─────▶│ cg-extract  │─── FileGraph (keyed, self-contained)
                  └─────────────┘
                        │
                        ▼ cg-ir types
                  ┌─────────────┐
                  │  cg-store   │─── intern keys → NodeId/EdgeId
                  │             │─── apply deltas → GraphDelta stream
                  └─────────────┘
                        │
          ┌─────────────┼─────────────┐
          ▼             ▼             ▼
   LLM context map   Browser UI   EditIntent compiler
   (cg-project)
```

## Crates

| Crate | Path | Purpose |
|-------|------|---------|
| `cg-ir` | `crates/ir/` | Canonical IR types: `NodeKind`, `EdgeKind`, `NodeKey`, `EdgeKey`, `Span`, `GraphDelta`, `EditIntent`. Shared by every crate. Zero runtime dependencies. |
| `cg-extract` | `crates/extract/` | Tree-sitter → keyed `FileGraph` extraction. Two-pass: first registers all definitions, then resolves call sites. Produces `KeyOp` diffs against a previous snapshot. |
| `cg-store` | `crates/store/` | Versioned in-memory store. Interns stable keys → compact IDs, builds containment and kind indices, applies deltas, projects snapshots through a `ViewSpec`. |
| `cg-project` | `crates/project/` | Renders the LLM context map (aider-style but with inline node IDs). Deterministic ordering, module-chunked output, token-budget-aware via PageRank-based pruning. |

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

## Status

Early development. The extraction crate (`cg-extract`) is functional for Rust with a tree-walk extractor. The store (`cg-store`) and project renderer (`cg-project`) have APIs sketched but not yet implemented. The intent pipeline (graph edit → text edit compilation) is designed in the IR but not wired.

## License

MIT


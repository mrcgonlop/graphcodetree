# Next session — multi-language extraction

*Session prep note, written against the current state of the repo: `codegraph
enrich` produces a Rust-only snapshot (393 nodes / 2 252 edges) and
`cargo test --workspace` is green (14 tests + 1 ignored); the two UI harnesses
in `.cgtest/` pass at 236 and 44 assertions.*

## Goal

Make extraction **language-parameterised** instead of Rust-shaped, and prove it
by shipping **Python** and **JavaScript** extractors that produce the same
`FileGraph`/`Snapshot` shape Rust does. The durable outcome is not "two more
languages" — it is a language registry plus a written procedure where adding a
language is *one profile + one fixture + one test*, so every other tree-sitter
grammar is a bounded amount of work.

## Definition of done

- [ ] `cargo run -p cg-cli -- enrich <dir>` walks `.rs`, `.py`, `.js` (and `.ts`/`.tsx` if Phase 4 lands) and dispatches to the right extractor by extension; unknown extensions are skipped with a warning.
- [ ] A Python-only directory and a JavaScript-only directory each produce a snapshot whose nodes/edges satisfy the same invariants the Rust tests assert (defs registered, `contains` tree well-formed, same-file calls resolved, keys stable under body edits).
- [ ] A **mixed** directory produces one snapshot where every node's `key.lang` matches its file's language, and no key collides across languages.
- [ ] Every existing Rust test still passes **unchanged**, and the Rust snapshot for this repo is byte-identical to the one taken in Phase 0.
- [ ] Both `.cgtest` harnesses still pass, and the viewer shows a per-node language (badge or filter) for a mixed snapshot (Phase 6 — can be deferred if the earlier phases overrun, but the snapshot must already carry the information).
- [ ] README: a per-language coverage matrix (defs / imports / calls / visibility / docs / data flow), and `web/README.md` keeps matching reality.

## Where the Rust-specific code is today

Everything below is the surface that has to be generalised. Line numbers are
anchors, not contracts.

| Concern | Today | Where |
|---------|-------|-------|
| grammar + language gate | `tree_sitter_rust::LANGUAGE`, `if file.lang != Lang::Rust { LangMismatch }` | `crates/extract/src/rust.rs:40-45` |
| file node | `Lang::Rust` literal in the key, `ast_kind: "source_file"` | `rust.rs:48-70` |
| item classification | one `match child.kind()` over Rust kinds (`mod_item`, `function_item`, `struct_item`, `enum_item`, `trait_item`, `impl_item`, `use_declaration`, `const_item`, `static_item`, `type_item`, `associated_type`, `macro_definition`) | `rust.rs:133-305` |
| qualified names | `scope.join("::")` | `rust.rs:321-325` |
| definition tables | `defs_simple` / `defs_qualified` (name → keys, qualified → key) | `rust.rs:108-115`, `360-374` |
| call sites | `call_expression` / `macro_invocation`, `let`/`=` binding tracking, `self.` methods, resolution tags (`same_file`, `imported`, `path_unresolved`, `method_unresolved`, `dynamic`) | `rust.rs:387-573` |
| imports | `use_declaration` → `flatten_use` (`scoped_identifier`, `identifier`, `use_as_clause`, `scoped_use_list`, `use_list`, `use_wildcard`) | `rust.rs:259-277`, `635-697` |
| item-kind set | `is_item()` | `rust.rs:701-719` |
| visibility | `visibility_modifier` → `pub` / `pub(...)` | `rust.rs:731-746` |
| impl / trait | `impl_item`, `base_type_name`, `extra.impl_trait`, `Type—Defines→member` jobs | `rust.rs:237-258`, `749-762` |
| fields / variants | `field_declaration`, `enum_variant`, `prev_doc` | `rust.rs:191-225`, `765-779` |
| doc comments | `///` via `doc_line`, contiguous block above a sibling | `crates/extract/src/text.rs:9-17`, `rust.rs:765-779` |
| signature text | strip `attribute_item`s, cut at the `body` field | `text.rs:32-52` |
| file discovery | `.rs` only, `Lang::Rust` hard-coded per file | `crates/cli/src/main.rs:141-173`, `177-247` |
| module resolution | `foo.rs` / `foo/mod.rs` | `crates/enrich/src/import_resolver.rs:49-70`, `143-165` |
| import → qualified name | strips `crate`/`self`/`super`, joins with `::` | `import_resolver.rs:135-141` |
| cross-file call resolution | `strip_crate_prefix`, "hunt every `ImplBlock` for a method with this name" | `crates/enrich/src/call_graph.rs:135-176` |
| stats | `match node.kind` counters | `crates/extract/src/snapshot.rs:55-77` |
| vocabulary gaps | no `NodeKind::Class`; `Visibility` has only `private`/`crate`/`public` | `crates/ir/src/node.rs:11-38` |

Already language-neutral, so reuse rather than rewrite: `Lang` (one variant per
language, `crates/ir/src/lib.rs:54-66`), `ImportRecord` (a segment vector, not a
string — `lib.rs:26-35`), `NodeKey`/`EdgeKey` identity and `diff()`, the store,
the `Enricher` trait, and the whole web view.

## Target design

Three options were on the table:

| Option | Shape | Verdict |
|--------|-------|---------|
| **A. Per-language extractor modules** (`python.rs`, `js.rs`, …), each ~900 lines | copy-paste the walker per language | Rejected: three copies of two-pass resolution, key building and call/binding tracking — and the *next* language pays the same cost again |
| **B. Pure `.scm` query-driven extraction** | `queries/<lang>.scm` is the whole extractor | Rejected as the whole answer: queries can say *which* nodes matter, but not "the signature is the text between the last attribute and the `body` field", "visibility is `pub(crate)`", "the doc is the contiguous comment block above", nor the two-pass call/binding analysis |
| **C. Shared walker + per-language profile, `.scm` as the declared vocabulary** (recommended) | one `walk.rs` with no grammar strings in it; each language is a `static LangProfile` plus a handful of functions | Recommended: the walker is written once, a language is *data plus five small functions*, and the query file documents/validates the profile's item kinds |

### The profile (sketch — `crates/extract/src/profile.rs`)

```rust
/// Everything the shared walker needs to know about one grammar. The walker
/// contains no grammar kind strings at all: classification is `classify()`.
pub struct LangProfile {
    pub lang: Lang,
    pub extensions: &'static [&'static str],        // [".py"], [".js", ".mjs", ".cjs"]
    pub grammar: fn() -> tree_sitter::Language,     // tree_sitter_python::LANGUAGE.into()
    pub root_ast_kind: &'static str,                // "source_file" | "module" | "program"

    /// item node kind → what it means
    pub classify: fn(&str) -> ItemClass,
    pub name_field: &'static str,                   // "name" for Rust/Python/JS
    pub qual_sep: &'static str,                     // "::" Rust, "." Python/JS

    pub doc: fn(Node, &[u8]) -> Option<String>,       // leading doc for an item
    pub prev_doc: fn(Node, &[u8]) -> Option<String>,  // doc above a sibling (fields/variants)
    pub signature: fn(Node, &[u8]) -> Option<String>,
    pub visibility: fn(Node, &[u8]) -> Visibility,

    /// Rust-only today: `impl Foo for Bar` → (type, trait); None elsewhere.
    pub impl_targets: Option<fn(Node, &[u8]) -> (String, Option<String>)>,
    pub imports: fn(Node, &[u8]) -> Vec<ImportRecord>,
    pub member_kinds: &'static [(&'static str, NodeKind)], // field/variant tables
    pub call_kinds: &'static [&'static str],               // ["call_expression", …]
}

pub enum ItemClass {
    Definition(NodeKind),   // emit a def + a Contains edge
    Container,              // recurse into the body with a new scope (mod, class)
    Members(NodeKind),      // container whose children become members (struct, enum)
    Impl,                   // Rust impl_item: members + Defines + `impl_trait`
    Import,                 // → FileGraph.imports, no node
    Transparent,            // anything else: no node, never a wrong one
}

/// The registry the CLI and tests iterate.
pub fn all() -> &'static [&'static LangProfile];            // [&RUST, &PYTHON, &JAVASCRIPT]
pub fn for_lang(l: Lang) -> Option<&'static LangProfile>;
pub fn for_extension(ext: &str) -> Option<&'static LangProfile>;
```

`ProfileExtractor(&'static LangProfile)` implements the existing `Extractor`
trait, so `cg-store`, `cg-enrich` and the CLI keep working against the trait they
already use. Keep `RustExtractor` as a thin unit struct delegating to
`ProfileExtractor(&RUST)` so today's callers and tests compile untouched.

A cheap extra win: a test that checks every node kind named in
`queries/<lang>.scm` is classified by the profile, so the query file cannot
drift away from the code (or delete the `.scm` files deliberately — see
Decisions).

## Phase plan

### Phase 0 — freeze current behaviour (~30 min)

- [ ] `cargo run -p cg-cli -- enrich . --output .cgtest/goldens/rust-repo.json` and commit it. Use `--output`, never shell redirection: on Windows `>` writes UTF-16 and the file stops being diffable.
- [ ] `cargo test --workspace` → 14 passed, 1 ignored.
- [ ] `node --experimental-default-type=module .cgtest/{validate,wiring}.mjs` → 44 / 236 assertions.
- [ ] Record the `stats` block of `web/refactor/graph.json` too, since both UI harnesses read that file.

Baseline `stats` for this repo: `total_nodes 393`, `total_edges 2252`,
`function_count 119`, `struct_count 32`, `trait_count 2`, `impl_count 10`,
`calls_edge_count 268`, `contains_edge_count 1711`, `impl_edge_count 10`,
`data_flow_edge_count 37`.

### Phase 1 — the profile seam, zero behaviour change (~2 h)

- [ ] New `crates/extract/src/profile.rs` (the struct above) and
      `crates/extract/src/walk.rs`. Move `walk_items`, `emit_def`, `extract_calls`,
      `emit_callsite`, `resolve_callee`, `unique_simple`, `add_edge`, `span_of`
      and `txt` out of `rust.rs` verbatim, replacing every hard-coded kind string
      with a profile call.
- [ ] `rust.rs` keeps only Rust data: the `RUST` profile (`classify`,
      `visibility_of`, `signature_of`, `doc_line`/`prev_doc` adapters,
      `flatten_use`, `base_type_name`, the resolution helpers).
- [ ] `text.rs`: keep `collapse_ws`/`first_paragraph` (already generic); move the
      Rust-specific `doc_line`/`signature_of` behind the profile.
- [ ] `impl Extractor for ProfileExtractor` replaces
      `impl Extractor for RustExtractor`; the `Lang::Rust` gate becomes
      `profile.lang != file.lang`.
- [ ] `lib.rs`: module list + re-exports
      (`pub use profile::{all, for_extension, for_lang, ItemClass, LangProfile}`).

Exit criterion: the Phase 0 golden is **byte-identical** (`fc` / `git diff`
the two JSON files), `cargo test --workspace` untouched and green.

### Phase 2 — file discovery and dispatch in the CLI (~1 h)

- [ ] `cli/src/main.rs:141-173`: `collect_rs_files` → `collect_source_files(dir)
      -> Vec<(PathBuf, Lang, String)>`, driven by `profile::for_extension`.
- [ ] `run_snapshot` / `run_enrich` (`main.rs:177-247`): drop the hard-coded
      `Lang::Rust`; take each file's language from the walk and pick its
      extractor with `cg_extract::for_lang`.
- [ ] Keep the directory skip-list (`target`, `node_modules`, `vendor`,
      dot-dirs) and add the usual Python/JS noise (`__pycache__`, `.venv`,
      `venv`, `dist`, `build`, `coverage`) — a Python repo walk without them is
      unusable.
- [ ] Optional: a `--langs rs,py,js` filter, plus per-language counts in the
      summary line that `write_json` prints.
- [ ] While here: either add `--web <dir>` or document clearly that the refactor
      viewer is fed with `--output` (only `--demo` targets `web/demo/` today).

Exit criterion: one snapshot over a mixed directory with no `LangMismatch`, and
the Rust-only snapshot still equal to the Phase 0 golden.

### Phase 3 — Python (~half a day)

- [ ] `crates/extract/Cargo.toml`: add `tree-sitter-python = "0.23"` (pin it; kind names drift between grammar releases — the same note already sits next to `tree-sitter-rust` in the workspace manifest).
- [ ] `crates/extract/src/python.rs`: `pub static PYTHON: LangProfile` plus the Python-only helpers (`docstring`, `visibility_from_name`, `flatten_import`, `decorators`). See **Python specifics** below for the kinds.
- [ ] `queries/python.scm` mirroring `queries/rust.scm`, and wire it into the profile-vs-query test (Phase 1).
- [ ] Tests in `python.rs` following the existing convention: an inline
      `const FIXTURE: &str = r#"..."#;` next to a `#[cfg(test)] mod tests`,
      asserting the def keys, the `contains` tree, same-file call resolution
      tags, the doc/signature/visibility attrs, and key stability under a body
      edit (mirror `rust.rs:807-1000`).
- [ ] A mixed-language test: two files in different languages in one
      `flatten()`/store run — no key collisions, `key.lang` correct per node.

Exit criterion: the fixture's expected node/edge set matches and the tags on
`self`-ish calls (Python: `self.helper()`) resolve the way Rust's `self_method`
does.

### Phase 4 — JavaScript, then TypeScript/TSX if cheap (~half a day)

- [ ] `tree-sitter-javascript` (and optionally `tree-sitter-typescript`, which
      ships both grammars: `LANGUAGE_TYPESCRIPT`, `LANGUAGE_TSX`).
- [ ] `crates/extract/src/javascript.rs` with `JAVASCRIPT` (and `TYPESCRIPT`,
      `TSX` if the first went smoothly — they share almost all kinds, so the
      profiles can be one function-parameterised table).
- [ ] `Lang::Tsx` exists in the IR already; keep TSX a separate profile because
      the grammar really is a separate one, but note that TS/TSX files will call
      it out in `lang`.
- [ ] Decide whether `const f = () => {}`/`const C = class {}` count as
      definitions (recommended: yes, `Function`/`Struct`) and whether they are
      keys of the variable or of the arrow function.
- [ ] Do **not** attempt JSX-to-IR mapping in this session: JSX elements are
      `Transparent` (no nodes), which keeps the walker honest.

### Phase 5 — enrichers off the Rust assumptions (~2-3 h)

- [ ] `import_resolver.rs`: make the `mod`-resolution table a profile concern
      (Rust: `foo.rs` / `foo/mod.rs`; Python: `foo.py` / `foo/__init__.py`;
      JS: `foo.js`, `foo/index.js`) and make `import_path_to_qualified` use the
      profile's separator + root-prefix rule (`crate`/`self`/`super` for Rust;
      `.`-joined, relative dots for Python; `./`, `../` for JS).
- [ ] `import_resolver.rs:148-165` and `find_module_node` hard-code `Lang::Rust`
      in the key they look up — take the language from the importing file.
- [ ] `call_graph.rs`: `strip_crate_prefix` becomes a per-language normaliser
      (`::`→`.` for Python/JS, drop `crate`/`self`/`super` only for Rust);
      `resolve_method`'s "hunt all `ImplBlock`s" is a Rust-only heuristic — for
      Python/JS, methods hang off a `Struct`/class container, so search the
      receiver type's members (via `contains`) first and keep the global hunt as
      a fallback.
- [ ] `DataFlowEnricher` should need no change (it reads `flows_from` off call
      sites), but its Python/JS producer side does: the binding tracker in the
      walker must understand Python assignment (`x = f()`) and JS
      `const x = f()` / destructuring. Keep the same `flows_from` annotation
      format (`"0->0"`) so the enricher stays language-blind.
- [ ] `ImplTraitEnricher`: Rust-specific by nature — either gate it on
      `impl_trait` extras (it already reads them, so it becomes a no-op for
      Python) or repurpose it for Python base classes / JS `extends` →
      `Inherits`/`Implements`, which needs an extractor-side `extra` first.

### Phase 6 — web view, stats and docs (~2 h)

- [ ] `snapshot.rs:55-77`: the stats switch gains `class_count`, `interface_count`
      and per-language file counts (`stats.langs: BTreeMap<Lang, usize>`), so the
      viewer header can say "12 files · rust 8 · python 3 · javascript 1".
- [ ] `web/refactor`: show the language in the details panel (chip next to the
      kind) and add a language filter next to the kind filters (same
      single-pass `refreshVisibility()` slot). `key.lang` is already in the
      snapshot — no builder change needed beyond a data field.
- [ ] `web/refactor/app/constants.js`: `KIND_COLORS` needs entries for any new
      `NodeKind` (`class`, `interface` if added), otherwise those nodes fall
      back to the default colour and the legend lies.
- [ ] `.cgtest/wiring.mjs` / `validate.mjs`: extend for the new data field (a
      language badge must be present when `key.lang` differs; a filter must hide
      the other languages). Keep the mutation-testing convention.
- [ ] README: per-language coverage matrix + "How to add a language" section
      pointing at the profile, the fixture and the test. `web/README.md`:
      the language badge/filter in the cheatsheet and the module map.

## Decisions to settle first

These change the IR or the key space, so decide them *before* writing an
extractor — a late change here means re-keying every snapshot.

| # | Decision | Options | Recommendation |
|---|----------|---------|----------------|
| D1 | Class-like definitions | (a) reuse `NodeKind::Struct`, (b) add `NodeKind::Class` | **(b)** — a Python `class` is not a Rust `struct`, and the viewer colours by kind; `NodeKind` is serde `snake_case`, so this is one variant plus `snapshot.rs` stats plus `KIND_COLORS`/`KIND_ORDER` |
| D2 | Visibility vocabulary | (a) keep `private`/`crate`/`public`, (b) add `module` + `protected` | **(b)**: Python's `_name` is module-private (not `crate`), TS/Java `protected` has no home today. Existing Rust output is unchanged (`pub`→`public`, `pub(crate)`→`crate`) |
| D3 | Qualified-name separator | (a) always `::`, (b) per-language (`::` Rust, `.` Python/JS) | **(b)**, carried by `profile.qual_sep`, because the separator is also what the enrichers split on. Keys stay unambiguous either way — `NodeKey::Symbol.lang` disambiguates |
| D4 | `queries/*.scm` | (a) keep as documentation + profile-consistency test, (b) delete, (c) make them the real driver | **(a)** — cheap, and it stops the "the README claims a query-driven path" lie from recurring |
| D5 | Python nesting in `qualified_name` | (a) `Outer::inner` as Rust does, (b) `Outer.inner` including the class | **(b)**: use the module path for module-level defs (`app.models.Thing.save`) or the enclosing scope for nested ones, and assert it in the fixture test so it stops being accidental |
| D6 | Arrow functions / function-valued constants | (a) skip, (b) definition of the variable, (c) definition of the arrow | **(b)** — what a reader looks for; key on the variable name |
| D7 | `Lang::Tsx` vs `Ts` | — | No `Lang::Ts` variant exists; either add one or map `.ts` to `Lang::TypeScript` and `.tsx` to `Lang::Tsx` (cheapest, recommended) |

## Python specifics

Grammar: `tree-sitter-python`. Kinds verified with `tree-sitter parse` before
being committed to the profile — keep that habit; every line below is a claim
about a specific grammar version.

| Concern | Nodes |
|---------|-------|
| root | `module` |
| definition | `function_definition` → `Function` (or `Method` inside a class), `class_definition` → `Class` (D1); `decorated_definition` wraps either and must be unwrapped (the inner node carries the name, the decorators become `extra.decorators`) |
| container | `class_definition` body (`block`) — recurse with the class in scope so methods are `Method` and `Class—Defines→member` works |
| members | assignment targets in a class body (`expression_statement` → `assignment`) → `Field`; no separate variant kind |
| names | field `name` (`identifier`), and `parameters` for the signature |
| doc | a lone `expression_statement` → `string` as the first statement of the body (`"""..."""`): strip the triple quotes, take the first paragraph with the existing `first_paragraph`; module docstring = the same at the top of `module` |
| signature | text from the start of `def`/`class` (after decorators) to the `:` that opens the body — `def save(self, path: str) -> None` |
| visibility | name-based: `__x` → `private`, `_x` → `module` (D2), otherwise `public`; a `class`/`def` inside a function is effectively private |
| imports | `import_statement` (`dotted_name`, `aliased_import`) and `import_from_statement` (`relative_import` with `.`/`..` prefixes, `dotted_name`, `wildcard_import`, parenthesised `import_from_statement` with newlines); the relative-dot count belongs in `ImportRecord.path` as leading `"."`/`".."` segments |
| calls | `call` with `function: identifier` → simple; `function: attribute` (`self.helper()`, `mod.func()`) → `method_unresolved`/`path_unresolved` with the receiver in `hint` |
| data flow | `assignment` (`x = f()`), `augmented_assignment` (skip — no producer), tuple targets (reuse Rust's `extract_bound_names` shape); keep the `"arg->call"` `flows_from` format |
| deliberately skipped | comprehensions, `lambda`, nested `def` inside a function body, `async`/`await` wrappers (recurse through them, don't emit) |

Python-specific gotchas worth an assertion each: a docstring is *also* the first
statement, so the walker must not emit a node for it; `decorated_definition`
means the name lives one level down; `__init__` in a class is a `Method` named
`__init__`, not a constructor kind.

## JavaScript specifics

Grammar: `tree-sitter-javascript` (and `tree-sitter-typescript` for TS/TSX).

| Concern | Nodes |
|---------|-------|
| root | `program` |
| definition | `function_declaration`, `generator_function_declaration` → `Function`; `class_declaration` → `Class`; `method_definition` inside a class body → `Method`; `arrow_function` / `function_expression` **only** when bound by `variable_declarator` (`const f = () => {}`) → `Function` (D6) |
| container | `class_declaration` body (`class_body`); a class field holding a function is a `Method` if it is `method_definition`, a `Field` otherwise |
| members | `field_definition` (TS `public_field_definition`) → `Field`; `method_definition` → `Method` |
| names | field `name`; `variable_declarator` name for D6 defs; note `#private` fields and computed names |
| doc | `comment` starting with `/**` immediately above the node (`prev_doc` shape): strip the `/**`, leading `*` and the trailing `*/`, then `first_paragraph` |
| signature | for a function: text up to the `body` field; for D6 defs: the `variable_declarator` text up to the arrow's body, with the name prefixed (`const f = (a) =>` reads badly, so emit `f(a): <return type if TS>`) — decide once, assert it |
| visibility | ESM `export` on the nearest `export_statement` → `public`; `#name` → `private`; TS `accessibility_modifier` (`public`/`private`/`protected`) wins when present → needs D2's `protected` |
| imports | `import_statement` (`import_clause` → `named_imports`, `namespace_import`, default `identifier`), `export_statement` re-exports, and CommonJS `require` calls (`const x = require('mod')`) — the last one is a call, so it needs a deliberate rule; recommended: record the import *and* skip the call site |
| calls | `call_expression` with `function: identifier` (simple), `function: member_expression` (`obj.method()`, `mod.fn()`) → `method_unresolved`/`path_unresolved` with the receiver in `hint`; `new_expression` → same treatment |
| data flow | `variable_declarator` with a call initializer, plus object/array destructuring patterns; same `flows_from` format |
| deliberately skipped | JSX elements, template literals, decorators (TS), `async`/`await` wrappers (recurse through) |

## Generalising to any tree-sitter language

The registry is the deliverable; the checklist for language *N+1* should be
short enough to put in the README:

1. Add the grammar crate (pinned) and a `Lang` variant if it is missing
   (`crates/ir/src/lib.rs:54-66`; new variants cost nothing on the wire, they
   are serde `lowercase`).
2. Write `crates/extract/src/<lang>.rs`: one `static PROFILE: LangProfile`, plus
   `doc`/`prev_doc`/`signature`/`visibility`/`imports`. `classify()` is a
   `match` over the grammar's item kinds — nothing else.
3. Add `queries/<lang>.scm` and register the profile in `profile::all()`.
4. Add an inline-fixture test (defs, contains tree, attrs, one resolved and one
   unresolved call, key stability under a body edit) and, if the language has
   anything unusual, one test per quirk.
5. Note the coverage in the README matrix and the escape hatches used: which
   kinds are `Transparent`, what is deliberately not extracted.

Known quirks to expect, per family (worth a line in the README, not a session
each):

- **Indentation grammars** (Python, YAML, Nim): bodies are `block` nodes, and a
  syntax error can swallow a whole file into an `ERROR` node — the walker must
  stay transparent on `ERROR` (it already is).
- **Receivers**: Go methods hang off a `method_declaration` with a receiver
  field (not inside an `impl` block), so `Impl`/`Defines` need a per-language
  member-link rule — the profile's `ItemClass` covers this, the walker must not.
- **Preprocessor** (C/C++): macros hide definitions; treat `preproc_def` as
  `Macro` and never try to expand.
- **Optional/overloaded signatures** (C++ Java Kotlin): keep the text up to the
  body; do not attempt type resolution — that is a later enricher, not
  extraction.
- **Everything is a definition** families (Ruby `def`/`attr_accessor`, PHP
  traits, C# properties): map to the closest `NodeKind` and record the original
  kind in `ast_kind` (which already round-trips).

Acceptance for "all tree-sitter languages in general" is therefore not a list of
languages but the property: **adding one touches no shared file except
`profile::all()` and the Cargo manifest.**

## Verification (copy-paste)

```powershell
# Rust side — must stay at 14 passed / 1 ignored through phases 1-2
cargo test --workspace

# Golden behaviour check: byte-compare against the Phase 0 snapshot
cargo run -p cg-cli -- enrich . --output .cgtest/goldens/rust-repo-after.json
fc.exe .cgtest/goldens/rust-repo.json .cgtest/goldens/rust-repo-after.json

# New languages: enrich a mixed fixture tree and inspect the shape
cargo run -p cg-cli -- enrich .\crates\extract\tests\fixtures --output .\out\mixed.json
node -e "const s=require('./out/mixed.json');console.log(Object.keys(s.stats));console.log([...new Set(s.nodes.map(n=>n.key.lang))]);console.log(s.file_count, s.stats.total_nodes, s.stats.total_edges)"

# Viewer (do not clobber the committed snapshot the harnesses read)
node --experimental-default-type=module .cgtest/validate.mjs
node --experimental-default-type=module .cgtest/wiring.mjs
```

Checks specific to multi-language output, all expressible as tests:

- every node's `key.lang` equals the language of its file (and of its
  `span.file`'s extension);
- `qualified_name` contains no separator of another language (no `::` in a
  Python key, no `.`-separated JS key with `::`);
- a `contains` tree exists per file and is connected — no orphan symbols;
- the same key set before and after a body-only edit (the existing
  `keys_are_stable_under_body_edits` test, re-run per language);
- `calls` edges resolve within a file at least as often as the Rust extractor's
  do on comparable code, and unresolved call sites keep their `resolution` tag
  in `extra` (never silently dropped).

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Grammar kind names drift between releases → silently fewer nodes | pin grammars (`tree-sitter-rust = "0.23"` style), commit `Cargo.lock`, and assert node counts in the fixture tests rather than only "a node exists" |
| `Parser::set_language` / `LanguageFn` mismatch after a tree-sitter bump | the workspace pins `tree-sitter = "0.24"` while the grammars are `0.23`; if a bump breaks the build, pin tree-sitter down rather than the grammar up, and do it in its own commit |
| The Python/JS fixture passes but a real repo produces garbage | dogfood on a real repo (e.g. a Django or Express checkout) the way `rust::tests::dogfoods_own_source` dogfoods this one, and keep the assertion loose (parses, has N defs, no orphans) |
| Key collisions across languages | `NodeKey::Symbol.lang` is part of the key — but write the test anyway, because two languages in *one* file (`.tsx` with embedded JSX, PHP with HTML) is where this actually bites |
| Scope creep into type inference | the resolution-tag contract in `rust.rs:10-18` is the boundary: extraction records a hint, `cg-enrich` resolves. Language N must not add type analysis to the walker |
| Phase 1 turns into a rewrite | freeze first (Phase 0) and diff JSON, not intuition: the golden file is the only judge of "no behaviour change" |
| Python data flow silently produces nothing | assert one `flows_from` annotation in the Python fixture (`x = f(); g(x)`), not just "no crash" |

## Session order (suggested)

1. Phase 0 + the D1–D7 decisions (write them down in this file, as decided).
2. Phase 1, then stop and re-run the golden + both harnesses. Do not start Phase 3 with a red Phase 1.
3. Phase 2 (small), then Phase 3 (Python) end-to-end including tests.
4. Phase 4 (JavaScript) only if Phase 3's "no shared file touched" claim held; otherwise fix the profile first.
5. Phase 5 (enrichers) and Phase 6 (viewer + docs) — the last two are the ones that make the result *usable* rather than merely extracted.

If the session runs short, the best stopping point is "Phase 3 green with Python
fully wired, JavaScript profile written but a known-unfinished note in the
README" — a half-finished profile is honest, a half-generalised walker is not.

## Carried-over backlog (from the root README)

These were the previous "next session" goals; they are still open and are not
part of the multi-language push.

- [ ] Crate-graph: parse `Cargo.toml` files for external dependency names → `crate::` prefixes, crate nodes + inter-crate edges, stub crate nodes for unresolved `use crate_name::…`.
- [ ] Deeper cross-file resolution: re-run `CallGraphEnricher` after `ImportResolver` adds edges; resolve `super::`/`crate::` by walking the directory hierarchy; handle glob re-exports (`pub use foo::*;`).
- [ ] Visualizer polish: collapsible edge legend with swatches + per-kind toggles; "show only connected"; depth slider (the *depth filter* exists, the slider form does not); PNG export.
- [ ] Export & stats: per-kind edge counts in the stats header (partially there), node/edge counts after filtering, a JSON schema documentation page.
- [ ] Housekeeping: delete the scratch `.cgtest/_probe4*.mjs/txt` files; decide the fate of `.cgtest/drift.mjs` and `.cgtest/count.mjs`; regenerate `.cgtest/wiring-out.txt` / `validate-out.txt` as UTF-8 (`cmd /c … >`) if they are still wanted.

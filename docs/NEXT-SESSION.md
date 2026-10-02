# Next session — multi-language extraction

*Status note. This file began as a plan; **Phases 0–2 have since landed** — the
seam exists (`profile.rs` + `walk.rs`, Rust as the first profile) and the CLI
dispatches by extension. See "Status: Phases 0–2 landed" immediately below for
what actually got built and the surprises worth knowing before Phase 3. Baseline
after the refactor: `cargo test --workspace` = 16 passed / 1 ignored;
`.cgtest/validate.mjs` = 44 assertions; `.cgtest/wiring.mjs` = 236 assertions.*

## Status: Phases 0–2 landed

The walker is language-agnostic now. Concretely:

| File | Role |
|------|------|
| `crates/extract/src/walk.rs` | the whole walk: `Ctx`, `extract`, `walk_items`, `promoted_kind`, `handle_body`, `emit_def`, `extract_calls`, `emit_callsite`, `resolve_callee`, `unique_simple`, `add_edge`, `span_of`, `txt`. **No grammar kind strings.** |
| `crates/extract/src/profile.rs` | the vocabulary (`ItemClass`, `BodyRole`, `DocAction`, `BindingCapture`, `CalleeShape`, `ImplInfo`, `LangProfile`), the registry (`PROFILES`, `all`, `for_lang`, `for_extension`) and `ProfileExtractor`. |
| `crates/extract/src/rust.rs` | Rust *data*: `pub static RUST: LangProfile`, its helper fns, and all the tests (fixture unchanged). |
| `crates/extract/src/text.rs` | `collapse_ws` / `first_paragraph` only — the Rust-specific `doc_line`/`signature_of` moved into the profile. |
| `crates/cli/src/main.rs` | `collect_source_files` (extension → profile via `for_extension`) and `ProfileExtractor(profile)` per file; extended `SKIP_DIRS`. |

Three places the sketch in "The profile" below is **wrong** — read these before Phase 3:

1. **`RustExtractor` is kept**, as a unit struct delegating to
   `walk::extract(&RUST, file)`, so every pre-existing test compiles and passes
   untouched. It is a compatibility shim; new code should use
   `ProfileExtractor(profile)` or `for_extension`.
2. **A profile is richer than "classify + a few fns".** Classification alone
   cannot do it: the walker also needs *what to do with a body* (`BodyRole` =
   `None` / `Scope` / `Members(&[(&str, NodeKind)])` / `Calls`), *when a
   `Function` becomes a `Method`* (`method_parents`), and a **three-way**
   data-flow answer (`BindingCapture` — the `Leave` case matters: a `let` with a
   call but no pattern must *not* reset the tracker). `CalleeShape` replaces the
   kind-string `match` inside `resolve_callee`, and `mod_decl_name` covers
   `mod foo;`. `doc_comment` returns `DocAction`, not `Option<String>`, because
   a Rust attribute is *consumed* but must not break the doc block.
3. **D1/D2 are already in the IR**: `NodeKind::Class` and
   `Visibility::{Module, Protected}` now exist (purely additive — Rust output is
   unchanged). `web/refactor/app/constants.js` gained `class`/`interface`
   colours so the legend cannot lie.

### Two surprises before you start

- **The snapshot is not order-stable, so a byte-golden is impossible.**
  `GraphStore` stores `HashMap<NodeId, Node>` / `HashMap<EdgeId, Edge>` and
  `to_snapshot()` iterates `.values()`, so array order is randomised per
  process: two runs of the *same* binary differ in order (content identical).
  The Phase 1 exit criterion below — "the golden is byte-identical" — therefore
  cannot hold as written. Compare goldens with
  `node --experimental-default-type=module .cgtest/golden-cmp.mjs <a.json> <b.json>`,
  which checks `file_count`, `stats` and the node/edge **sets**. Making
  `to_snapshot()` sort its output is a real, separate task: it rewrites
  `web/refactor/graph.json`, and `wiring.mjs` asserts **line numbers** inside
  that file (the `RustExtractor` method-member assertions), so regenerate it
  deliberately and re-run both harnesses.
- **`queries/rust.scm` is dead weight.** Nothing in the crate loads or parses
  it — there is no query-driven code path anywhere. The "profile-vs-query
  consistency test" the plan proposes below would be asserting agreement with an
  unused file. Either make the `.scm` actually drive `item_kinds`/`classify`
  (real work) or delete it; do not write that test as-is.

### The evidence that Phase 1 changed nothing

`git worktree add <tmp> HEAD` (the pre-refactor tree), run the **new** binary
over it (`cg-cli enrich . --output out.json`), and compare against the frozen
pre-refactor golden with `golden-cmp.mjs`: identical `file_count` (21),
identical `stats` (393 nodes / 2 252 edges / 268 calls / 1 711 contains / 10
impls / 37 data-flow) and identical node and edge **sets**. That is the honest
form of "byte-identical" this pipeline allows. The inline `rust.rs` tests remain
the finer guard: exact census (27 nodes / 34 edges), 4 resolved calls, 8 call
sites, data-flow annotations, and key stability across a body edit.

### Adding a language — the procedure, as built

1. `crates/extract/Cargo.toml`: add the pinned grammar
   (`tree-sitter-python = "0.23"`).
2. New `crates/extract/src/python.rs`: a `pub static PYTHON: LangProfile` whose
   fields are small `fn`s (`classify`, `doc_comment`, `prev_doc`, `signature`,
   `visibility`, `body_of`, `call_target`, `callee_shape`, `binding`,
   `ident_name`), the tables (`item_kinds`, `simple_resolvable`,
   `method_parents`, `call_kinds`, `path_root_strip`, `extensions`), and
   `impl_info: None` / `mod_decl_name: None`.
3. `crates/extract/src/lib.rs`: `mod python;` and re-export if wanted.
4. `crates/extract/src/profile.rs`: add `&crate::python::PYTHON` to `PROFILES`.
5. Tests in `python.rs` mirroring `rust.rs`'s (exact census, same-file calls,
   data flow, key stability under a body edit).

Steps 3–4 are the *only* shared edits, one line each. If a language needs a
sixth hook, that is the signal `LangProfile` is missing a concept: add the hook
to *every* profile and let the walker own the sequencing — never special-case a
language inside `walk.rs`. The registry tests in `profile.rs`
(`registry_resolves_rust_by_lang_and_extension`,
`unregistered_languages_and_extensions_are_absent_not_panics`) pin that
`for_extension`/`for_lang` return `None` rather than panicking for languages
that are not registered yet.

**Phase 3 prompt (copy-paste):**

> Read `crates/extract/src/profile.rs`, `crates/extract/src/walk.rs` and
> `crates/extract/src/rust.rs`. Then implement Phase 3 of
> `docs/NEXT-SESSION.md` exactly as its "Adding a language — the procedure, as
> built" section describes: add `tree-sitter-python`, write
> `crates/extract/src/python.rs` with `PYTHON` as a `LangProfile` plus the
> Python-only helpers, register it in `PROFILES`, and add fixture tests
> mirroring `rust.rs`'s. Do **not** modify `walk.rs`; if you think you must,
> stop and report which `LangProfile` hook is missing.

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
- [ ] Every existing Rust test still passes **unchanged**, and the Rust snapshot for this repo is *content*-identical to the one taken in Phase 0 — compare with `.cgtest/golden-cmp.mjs`, because the snapshot's array order is randomised per process and `fc` fails even on two runs of the same binary (see "Two surprises before you start").
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

**Not taken, deliberately.** Nothing in the crate ever loads a `.scm`, so that
test would assert agreement with text no code reads. The registry tests in
`profile.rs` are the real guard. Leave the `.scm` as prose or delete it — but do
not write the consistency test until something actually parses the file.

## Phase plan

### Phase 0 — freeze current behaviour ✅ DONE

- [x] Golden written with `cargo run -p cg-cli -- enrich . --output .cgtest/goldens/rust-repo.json`. Keep using `--output`, never shell redirection: on Windows `>` writes UTF-16 and the file stops being diffable.
- [x] `cargo test --workspace` — 14 passed / 1 ignored before the refactor; **16 passed / 1 ignored now** (the two new registry tests in `profile.rs`).
- [x] `node --experimental-default-type=module .cgtest/{validate,wiring}.mjs` → 44 / 236 assertions.
- [x] `.cgtest/golden-cmp.mjs` added: an order-insensitive comparator. Note the criterion below is **not** achievable as a byte-diff — see "Two surprises before you start".

The frozen pre-refactor numbers are the regression reference. (The file on disk
now holds the current tree, 23 files, because the extract crate gained
`profile.rs` + `walk.rs`.) Pre-refactor: `file_count 21`, `total_nodes 393`,
`total_edges 2252`, `function_count 119`, `struct_count 32`, `trait_count 2`,
`impl_count 10`, `calls_edge_count 268`, `contains_edge_count 1711`,
`impl_edge_count 10`, `data_flow_edge_count 37`.

### Phase 1 — the profile seam, zero behaviour change ✅ DONE

- [x] `crates/extract/src/profile.rs` and `crates/extract/src/walk.rs` created.
      Moved out of `rust.rs`: `walk_items`, `emit_def`, `extract_calls`,
      `emit_callsite`, `resolve_callee`, `unique_simple`, `add_edge`, `span_of`,
      `txt` — every hard-coded kind string replaced by a profile call. Two extra
      seams came out of it: `promoted_kind` and `handle_body` (the walker owns
      the sequencing; the profile only classifies).
- [x] `rust.rs` keeps only Rust data: `RUST`, the kind tables
      (`RUST_ITEM_KINDS`, `RUST_SIMPLE_RESOLVABLE`, `RUST_CALL_KINDS`,
      `RUST_STRUCT_MEMBERS`, `RUST_ENUM_MEMBERS`), the helper fns
      (`rust_classify`, `rust_doc_comment`, `rust_prev_doc`, `rust_signature`,
      `rust_visibility`, `rust_body_of`, `rust_call_target`, `rust_callee_shape`,
      `rust_binding`, `rust_imports`, `rust_impl_info`, `rust_mod_decl_name`,
      `base_type_name`, `flatten_use`), and the tests.
- [x] `text.rs`: `collapse_ws`/`first_paragraph` only — the Rust-specific
      `doc_line`/`signature_of` now sit behind the profile.
- [x] `impl Extractor` lives on `ProfileExtractor`; the `Lang::Rust` gate became
      `profile.lang != file.lang`. `RustExtractor` is kept as a delegating shim
      so the pre-existing tests compile unchanged.
- [x] `lib.rs`: `mod profile; mod walk;` plus re-exports
      (`pub use profile::{all, for_extension, for_lang, BindingCapture, BodyRole,
      CalleeShape, DocAction, ImplInfo, ItemClass, LangProfile, ProfileExtractor}`).

Exit criterion, as amended: the golden was **not** byte-identical — the snapshot
is order-unstable (see "Two surprises"). It was proven equal instead by
`golden-cmp.mjs` against the pre-refactor tree in a `git worktree`: identical
`file_count`, identical `stats`, identical node and edge sets.
`cargo test --workspace` green.

### Phase 2 — file discovery and dispatch in the CLI ✅ DONE

- [x] `collect_rs_files` → `collect_source_files`, returning
      `(PathBuf, &'static LangProfile, String)` and driven by
      `cg_extract::for_extension` — the extension → profile mapping lives in the
      profile, not in the CLI.
- [x] `run_snapshot` / `run_enrich`: no hard-coded `Lang::Rust` left; both build
      `cg_extract::ProfileExtractor(profile)` per file.
- [x] `SKIP_DIRS` extended with `target`, `node_modules`, `vendor`, `dist`,
      `build`, `coverage`, `__pycache__`, `.venv`, `venv` (the dot-dir skip was
      already there), so a Python/JS checkout can be walked at all.
- [ ] **Still open here**: a `--langs rs,py,js` filter and per-language counts in
      the summary line; and `--web <dir>` (today only `--demo` targets
      `web/demo/`, everything else goes through `--output`).

Exit criterion, as achieved: the Rust snapshot is still equal to the Phase 0
golden (order-insensitive — see above) and the CLI has no language-specific
branch left. The "mixed directory" half of the criterion needs a second profile
to exist, so it moves to Phase 3.

### Phase 3 — Python (~half a day)

> **Start from "Adding a language — the procedure, as built" at the top of this
> file**, not from this list: it reflects what the seam actually looks like now
> (and skips the `.scm` step below).

- [ ] `crates/extract/Cargo.toml`: add `tree-sitter-python = "0.23"` (pin it; kind names drift between grammar releases — the same note already sits next to `tree-sitter-rust` in the workspace manifest).
- [ ] `crates/extract/src/python.rs`: `pub static PYTHON: LangProfile` plus the Python-only helpers (`docstring`, `visibility_from_name`, `flatten_import`, `decorators`). See **Python specifics** below for the kinds.
- [x] ~~`queries/python.scm` mirroring `queries/rust.scm`, and wire it into the profile-vs-query test (Phase 1)~~ — **dropped**: nothing loads the `.scm` (see D4), so register in `PROFILES` instead and write no query file.
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
| D4 | `queries/*.scm` | (a) keep as documentation + profile-consistency test, (b) delete, (c) make them the real driver | **Resolved in practice — none of the three was needed.** Nothing loads the file, so option (a)'s consistency test would assert against dead text; the README already calls it documentation-not-a-driver, and the `profile.rs` registry tests are the real guard. Either delete the `.scm` or leave it unread; never build on it |
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
3. Register the profile in `PROFILES` (`crates/extract/src/profile.rs`, one
   line: `&crate::python::PYTHON`). **Skip `queries/<lang>.scm`** — nothing
   loads those files (see "Two surprises before you start"), so an unread `.scm`
   is documentation that lies. `PROFILES` is `pub static PROFILES: &[&LangProfile]`
   with `all()` / `for_lang()` / `for_extension()` on top.
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
`PROFILES` in `profile.rs` and the Cargo manifest.**

## Verification (copy-paste)

```powershell
# Rust side — 16 passed / 1 ignored after the refactor
cargo test --workspace

# Golden behaviour check: ORDER-INSENSITIVE, never `fc` (the snapshot order is
# randomised per process — see "Two surprises before you start")
cargo run -p cg-cli -- enrich . --output .cgtest/goldens/rust-repo-after.json
node --experimental-default-type=module .cgtest/golden-cmp.mjs .cgtest/goldens/rust-repo.json .cgtest/goldens/rust-repo-after.json

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

## Session order (as executed)

1. ~~Phase 0~~ — done. D1 (`NodeKind::Class`) and D2
   (`Visibility::{Module, Protected}`) **landed additively** in the IR; D3–D7
   remain open because they are questions only the language that needs them can
   answer (Python indentation, JS arrow functions, the qualified-name separator).
2. ~~Phase 1~~ — done, with the behaviour proof against a pre-refactor
   `git worktree` ("The evidence that Phase 1 changed nothing").
3. ~~Phase 2~~ — done.
4. **Next: Phase 3 (Python)**, following "Adding a language — the procedure, as
   built": grammar crate → `python.rs` profile → one line in `PROFILES` → tests.
   This is the first real test of the seam. If a Python profile forces an edit to
   `walk.rs`, **stop and fix the abstraction**, do not special-case the language.
5. Phase 4 (JavaScript) only if Phase 3's "no shared file touched" claim held.
6. Phase 5 (enrichers) and Phase 6 (viewer + docs) last — they are what make the
   result *usable* rather than merely extracted.

Before starting Phase 3, all four of these must be green (they are, at the time
of writing): `cargo test --workspace` (16 passed / 1 ignored),
`node --experimental-default-type=module .cgtest/validate.mjs` (44),
`node --experimental-default-type=module .cgtest/wiring.mjs` (236), and
`cargo run -q -p cg-cli -- enrich .` end-to-end.

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

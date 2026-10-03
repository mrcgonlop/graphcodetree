//! CallGraphEnricher — R2 enricher.
//!
//! Walks CallSite nodes tagged by the extractor and attempts to resolve
//! them against the store's global definition index.
//!
//! Resolution strategy by tag:
//!
//! | Tag                | Strategy |
//! |--------------------|----------|
//! | `"imported"`       | The callee is a name this file imported. Rust: `extra.hint` is the use path (`crate::foo::Bar`) — strip the crate prefix, then qualified-name lookup. Python: `extra.hint` is the dotted import path (`pkg.mod.helper`), so the file's own [`ImportRecord`]s say which module to look the name up in. |
//! | `"path_unresolved"`| `extra.hint` is a full path like `"crate::foo::bar::new"`. Try qualified-name lookup directly. |
//! | `"unresolved"`     | Try `lookup_qualified` with the callee name alone. |
//! | `"method_unresolved"` | `extra.hint` is the receiver: Rust — a short type name, so look for a method impl'd for it anywhere in the store; Python — a name the file imported, so look for a member of that module (or of the class it imported). |
//! | `"self_method"`    | Resolved same-file by the extractor — already wired, skip. |
//! | `"same_file"`      | Already wired by extractor — skip. |
//! | `"dynamic"`        | Closures, macros — skip. |
//!
//! # Why this file is language-aware
//!
//! The extractor is deliberately same-file only (`walk::resolve_callee`): every
//! cross-file call in the graph is decided *here*, from a tag plus a hint. A
//! hint is written in the language's own spelling, so two per-language facts
//! have to be honoured, and both live in [`Dialect`]:
//!
//! - the **separator** that joins path segments (`::` in Rust, `.` in Python)
//!   — a hint split on the wrong one is one unsplittable token, which is how
//!   every Python cross-file call used to vanish;
//! - whether an import path can be turned back into a **file**. Rust `use`
//!   paths line up with the store's qualified names, so a string lookup is
//!   enough. Python qualified names are module-*relative* (a module-level
//!   function is just `helper`, a method is `Shape.area`), so the module part
//!   of `pkg.mod.helper` is only usable through the import records and the
//!   walk's file list — see [`ModuleIndex`].
//!
//! A site is only ever resolved through the records of *its own* file, in its
//! own language, so the two paths cannot leak into each other.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

use cg_ir::{
    Edge, EdgeId, EdgeKind, GraphDelta, GraphOp, ImportRecord, Lang, NodeId, NodeKey, NodeKind,
};
use cg_store::GraphStore;
use crate::Enricher;

/// Resolves cross-file call sites to their definition nodes.
pub struct CallGraphEnricher;

impl Enricher for CallGraphEnricher {
    fn name(&self) -> &'static str { "call_graph" }

    fn enrich(&self, store: &GraphStore) -> GraphDelta {
        let base = store.version();
        let mut ops = Vec::new();
        let mut next_eid = store.edge_count() as u32 + 1;
        // Pure function of the store, built once per pass (not per call site).
        let index = ModuleIndex::build(store);

        for call_site in store.nodes_by_kind(NodeKind::CallSite) {
            let resolution = call_site.attrs.extra.get("resolution")
                .and_then(|v| v.as_str()).unwrap_or("");
            // The extractor writes "hint"; the enricher reads "hint".
            let hint = call_site.attrs.extra.get("hint")
                .and_then(|v| v.as_str()).unwrap_or("");
            // The call site's own file and language, from its anchored key.
            let site = Site::of(store, call_site.id);

            let target = match resolution {
                // Already wired by the extractor — skip.
                "same_file" | "self_method" | "dynamic" => None,

                // Imported call: hint is the import path the name came in through.
                "imported" => resolve_imported(store, &index, site.as_ref(), hint, &call_site.label),

                // Scoped path that wasn't resolved: hint is e.g. "crate::foo::bar::new".
                "path_unresolved" => resolve_path(store, site.as_ref(), hint),

                // Simple name: try lookup by label.
                "unresolved" => resolve_simple(store, &call_site.label),

                // Method call on a receiver: hint is the receiver.
                "method_unresolved" => resolve_method(store, &index, site.as_ref(), &call_site.label, hint),

                _ => None,
            };

            if let Some(target_id) = target {
                let eid = EdgeId(next_eid);
                next_eid += 1;
                ops.push(GraphOp::UpsertEdge(Edge {
                    id: eid,
                    kind: EdgeKind::Calls,
                    source: call_site.id,
                    target: target_id,
                    span: None,
                    weight: 1,
                }));
            }
        }

        GraphDelta {
            base_version: base,
            version: base + 1,
            ops,
        }
    }
}

// ─── Where a call site was written ───────────────────────────────────────────

/// The file (and language) that own a call site.
///
/// Sites are extracted with an `Anchored { ancestor: Symbol { lang, file, .. } }`
/// key, so a call site's own file comes free with its key — no span lookup, and
/// no dependence on the span being present.
#[derive(Clone, Debug)]
struct Site {
    lang: Lang,
    file: PathBuf,
}

impl Site {
    fn of(store: &GraphStore, id: NodeId) -> Option<Site> {
        match store.interner().lookup_node(id)? {
            NodeKey::Anchored { ancestor, .. } => match ancestor.as_ref() {
                NodeKey::Symbol { lang, file, .. } => Some(Site { lang: *lang, file: file.clone() }),
                _ => None,
            },
            NodeKey::Symbol { lang, file, .. } => Some(Site { lang: *lang, file: file.clone() }),
        }
    }
}

/// The per-language facts cross-file resolution needs.
struct Dialect {
    /// Joins the segments of a path (`::`, `.`).
    sep: &'static str,
    /// Leading segments that are contextual rather than real modules; stripped
    /// before a qualified-name lookup.
    roots: &'static [&'static str],
}

/// An unknown language resolves as Rust, which is what every caller did before
/// this was parameterized.
fn dialect(lang: Option<Lang>) -> Dialect {
    match lang {
        Some(Lang::Python) => Dialect { sep: ".", roots: &[] },
        _ => Dialect { sep: "::", roots: &["crate", "self", "super"] },
    }
}

/// Strip each contextual root, repeatedly, in `roots` order: `crate::self::x`
/// loses both, but a root that only appears after another is left alone —
/// which is exactly what the old chained `trim_start_matches` did.
fn strip_roots(d: &Dialect, path: &str) -> String {
    let mut out = path.to_string();
    for root in d.roots {
        let head = format!("{}{}", root, d.sep);
        while let Some(rest) = out.strip_prefix(head.as_str()) {
            out = rest.to_string();
        }
    }
    out
}

// ─── Tag handlers ────────────────────────────────────────────────────────────

/// Resolve an `"imported"` call.
///
/// Python goes through the file's import records first: they are the only place
/// that says *which* module a bare name came from (`from pkg.mod import helper`
/// binds `helper` to `pkg.mod`), and Python qualified names are module-relative,
/// so they cannot answer that on their own.
fn resolve_imported(
    store: &GraphStore,
    index: &ModuleIndex,
    site: Option<&Site>,
    hint: &str,
    label: &str,
) -> Option<NodeId> {
    if let Some(site) = site {
        if site.lang == Lang::Python {
            if let Some(id) = via_import_records(store, index, site, label) {
                return Some(id);
            }
        }
    }
    if hint.is_empty() {
        return None;
    }
    let d = dialect(site.map(|s| s.lang));
    let qn = strip_roots(&d, hint);
    if qn.is_empty() {
        return None;
    }
    // First try the full qualified name.
    let results = store.lookup_qualified(&qn);
    if !results.is_empty() {
        return Some(results[0].0);
    }
    // Then try just the last path segment (the callee name).
    if let Some(name) = qn.rsplit(d.sep).next().filter(|n| !n.is_empty()) {
        let results = store.lookup_qualified(name);
        if results.len() == 1 {
            return Some(results[0].0);
        }
    }
    None
}

/// Resolve a `"path_unresolved"` call: hint is a full path like
/// `"crate::foo::bar::new"`.
fn resolve_path(store: &GraphStore, site: Option<&Site>, hint: &str) -> Option<NodeId> {
    if hint.is_empty() {
        return None;
    }
    let qn = strip_roots(&dialect(site.map(|s| s.lang)), hint);
    if qn.is_empty() {
        return None;
    }
    let results = store.lookup_qualified(&qn);
    if !results.is_empty() {
        return Some(results[0].0);
    }
    None
}

/// Resolve an `"unresolved"` call: try to find a single definition
/// matching the callee name.
fn resolve_simple(store: &GraphStore, callee: &str) -> Option<NodeId> {
    let results = store.lookup_qualified(callee);
    if results.len() == 1 {
        return Some(results[0].0);
    }
    None
}

/// Resolve a `"method_unresolved"` call: `receiver.method_name()` where
/// `method_name` is `call_site.label` and `hint` is the receiver.
///
/// Python: the receiver is a name this file imported, so the import records say
/// where to look — a member of the module it names, or a member of the class it
/// imported. Rust: the receiver is a short type name, so search every
/// `ImplBlock` node in the store for a method with this name.
fn resolve_method(
    store: &GraphStore,
    index: &ModuleIndex,
    site: Option<&Site>,
    method_name: &str,
    hint: &str,
) -> Option<NodeId> {
    if method_name.is_empty() {
        return None;
    }
    if let Some(site) = site {
        if site.lang == Lang::Python {
            if let Some(id) = method_via_import_records(store, index, site, method_name, hint) {
                return Some(id);
            }
        }
    }
    // Strategy 1: search all impl blocks for a method matching the name.
    // Uses `Contains` edges from the impl block to find its children.
    for impl_node in store.nodes_by_kind(NodeKind::ImplBlock) {
        for edge in store.edges_from(impl_node.id) {
            if edge.kind != EdgeKind::Contains {
                continue;
            }
            let child_id = edge.target;
            if let Some(child) = store.node(child_id) {
                if child.label == method_name
                    && matches!(child.kind, NodeKind::Method | NodeKind::Function)
                {
                    return Some(child_id);
                }
            }
        }
    }

    // Strategy 2: if hint contains a receiver name, try
    // `store.lookup_qualified("{receiver}{sep}{method}")` — the shape a Python
    // `Shape.area()` or a Rust `Foo::bar` has in the store.
    if !hint.is_empty() {
        let sep = dialect(site.map(|s| s.lang)).sep;
        let candidate = format!("{hint}{sep}{method_name}");
        let results = store.lookup_qualified(&candidate);
        if !results.is_empty() {
            return Some(results[0].0);
        }
    }

    None
}

// ─── Python: from an import record to a definition ───────────────────────────

/// The name an import record binds in the importing file — the same rule
/// `walk.rs` uses to fill `simple_imports`: the alias when there is one, the
/// last path segment otherwise (`from pkg.mod import helper as h` binds `h`,
/// `import pkg.mod` binds `mod`).
///
/// Note the last one: the extractor's convention for `import pkg.mod` is the
/// segment `mod`, where CPython binds `pkg`. Resolution mirrors the extractor,
/// so `pkg.mod.fn()` stays unresolved; `import mod` + `mod.fn()` — the shape
/// the profile's own hint contract is written for — resolves.
fn bound_name(r: &ImportRecord) -> Option<String> {
    if r.glob || r.path.is_empty() {
        return None;
    }
    Some(r.alias.clone().unwrap_or_else(|| r.path.last().cloned().unwrap_or_default()))
}

/// An `"imported"` call in Python: the callee is a name this file bound, so the
/// record that bound it names the module to look the definition up in.
fn via_import_records(
    store: &GraphStore,
    index: &ModuleIndex,
    site: &Site,
    callee: &str,
) -> Option<NodeId> {
    let imports = store.imports_for(&site.file)?;
    // The last binding of a name is the one that wins, both at runtime and in
    // `simple_imports`, so walk the records backwards.
    for r in imports.iter().rev().filter(|r| !r.glob) {
        if bound_name(r).as_deref() != Some(callee) {
            continue;
        }
        let name = r.path.last()?.clone();
        let module = &r.path[..r.path.len() - 1];
        if let Some(id) = find_in_module(store, index, site, module, &name) {
            return Some(id);
        }
    }
    // `from pkg.star import *` binds no name, but the name can still live there.
    for r in imports.iter().rev().filter(|r| r.glob) {
        if let Some(id) = find_in_module(store, index, site, &r.path, callee) {
            return Some(id);
        }
    }
    None
}

/// A `"method_unresolved"` call in Python: `receiver.method()`. The receiver is
/// a bare name, so it is only resolvable when this file imported it — either as
/// a class (`from pkg.mod import Shape` → `Shape.area`) or as a module
/// (`import lib` → `lib.other`).
fn method_via_import_records(
    store: &GraphStore,
    index: &ModuleIndex,
    site: &Site,
    method: &str,
    receiver: &str,
) -> Option<NodeId> {
    if receiver.is_empty() {
        return None;
    }
    // The receiver is source text, so it may itself be dotted.
    let head = receiver.split('.').next()?;
    let imports = store.imports_for(&site.file)?;

    for r in imports.iter().rev().filter(|r| !r.glob) {
        if bound_name(r).as_deref() != Some(head) {
            continue;
        }
        let name = r.path.last()?.clone();
        let module = &r.path[..r.path.len() - 1];

        // The imported name is a class: the method is one of its members.
        if let Some(owner) = find_in_module(store, index, site, module, &name) {
            if let Some(id) = member_of(store, owner, method) {
                return Some(id);
            }
        }

        // The imported name is itself a module: the method is a definition in
        // the file that provides it (`lib` → `lib.py`).
        let mut segs: Vec<String> = module.to_vec();
        segs.push(name);
        if let Some(id) = find_in_module(store, index, site, &segs, method) {
            return Some(id);
        }
    }
    None
}

/// The definition called `name` in one of the files a module path names.
fn find_in_module(
    store: &GraphStore,
    index: &ModuleIndex,
    site: &Site,
    module: &[String],
    name: &str,
) -> Option<NodeId> {
    for file in index.resolve(site, module) {
        if let Some(id) = find_named_in_file(store, index, &file, name) {
            return Some(id);
        }
    }
    None
}

/// A module-level definition called `name` — the plain function or class an
/// `import` can bind. A *member* is only reachable through its owner, never by
/// bare import, so it is left to [`member_of`].
fn find_named_in_file(
    store: &GraphStore,
    index: &ModuleIndex,
    file: &str,
    name: &str,
) -> Option<NodeId> {
    let mut fallback: Option<NodeId> = None;
    for &id in index.defs_in(file)? {
        let Some(n) = store.node(id) else { continue };
        if n.label != name {
            continue;
        }
        if matches!(
            n.kind,
            NodeKind::Function
                | NodeKind::Class
                | NodeKind::Struct
                | NodeKind::Enum
                | NodeKind::Constant
                | NodeKind::Static
                | NodeKind::TypeAlias
        ) {
            return Some(id);
        }
        if fallback.is_none() {
            fallback = Some(id);
        }
    }
    fallback
}

/// A member of `owner` by name, following the namespace edges the Python
/// profile emits for a class body (`Defines`, else `Contains`).
fn member_of(store: &GraphStore, owner: NodeId, name: &str) -> Option<NodeId> {
    for e in store.edges_from(owner) {
        if !matches!(e.kind, EdgeKind::Defines | EdgeKind::Contains) {
            continue;
        }
        if let Some(child) = store.node(e.target) {
            if child.is_definition && child.label == name {
                return Some(e.target);
            }
        }
    }
    None
}

// ─── Module paths ↔ files ────────────────────────────────────────────────────

/// The extension a Python module is recognised by. The extractor knows it too
/// (`crates/extract/src/python.rs`); repeating it here keeps `cg-enrich` free of
/// a dependency on the extractor, and only affects which hints can be resolved.
const MODULE_EXT: &str = "py";
/// The file that names a package rather than a module inside it.
const PACKAGE_INIT: &str = "__init__.py";

/// The walk's file list, indexed so a module path can be turned back into the
/// file that provides it.
///
/// Python qualified names are module-*relative*, so `pkg.mod.helper` cannot be
/// found by name alone: the module part has to become a file first, and only
/// then can `helper` be looked up inside it. Both indexes are pure functions of
/// the store, so the enricher stays stateless.
/// A file path as the index keys it: separators normalized to `/`, so nothing
/// here depends on how the walk spelled its paths (Windows `\`, POSIX `/`) or on
/// how a caller built them.
fn norm(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

struct ModuleIndex {
    /// module path → the file(s) that provide it, as normalized keys
    by_module: BTreeMap<String, Vec<String>>,
    /// every file the walk produced, keyed the same way
    files: BTreeSet<String>,
    /// normalized file → its definition nodes, in walk order
    defs: BTreeMap<String, Vec<NodeId>>,
}

impl ModuleIndex {
    fn build(store: &GraphStore) -> ModuleIndex {
        let mut files = BTreeSet::new();
        let mut defs: BTreeMap<String, Vec<NodeId>> = BTreeMap::new();
        for n in store.all_nodes() {
            if let Some(NodeKey::Symbol { file, .. }) = store.interner().lookup_node(n.id) {
                let key = norm(file);
                files.insert(key.clone());
                if n.is_definition {
                    defs.entry(key).or_default().push(n.id);
                }
            }
        }
        let mut by_module: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for file in &files {
            for path in module_paths(Path::new(file)) {
                by_module.entry(path).or_default().push(file.clone());
            }
        }
        ModuleIndex { by_module, files, defs }
    }

    fn defs_in(&self, file: &str) -> Option<&Vec<NodeId>> {
        self.defs.get(file)
    }

    /// The files a module path names.
    ///
    /// A relative path (leading `.`/`..` segments, which is how the Python
    /// profile keeps them) is resolved against the importing file; an absolute
    /// one is matched by module suffix, so `agx_emulsion.model` is found even
    /// though the walk's root puts `agx-emulsion\` in front of every path.
    fn resolve(&self, site: &Site, module: &[String]) -> Vec<String> {
        let dots = module.iter().take_while(|s| is_dot_run(s)).count();
        if dots > 0 {
            // `.` is the importing file's own directory, `..` its parent, ...
            let up: usize = module[..dots]
                .iter()
                .map(|s| s.chars().filter(|c| *c == '.').count())
                .sum::<usize>()
                .saturating_sub(1);
            let mut dir = site.file.parent().unwrap_or_else(|| Path::new("")).to_path_buf();
            for _ in 0..up {
                dir = dir.parent().map(Path::to_path_buf).unwrap_or_default();
            }
            for seg in &module[dots..] {
                dir.push(seg);
            }
            return self.at_path(&dir);
        }
        if module.is_empty() {
            return Vec::new();
        }
        self.by_module.get(&module.join(".")).cloned().unwrap_or_default()
    }

    /// The two files a path can name: `dir/mod.py` and `dir/mod/__init__.py`.
    /// Both probes test membership in the walk's own file list, so a module path
    /// only ever resolves to a file that was actually extracted.
    fn at_path(&self, p: &Path) -> Vec<String> {
        let mut out = Vec::new();
        let module = norm(&p.with_extension(MODULE_EXT));
        if self.files.contains(&module) {
            out.push(module);
        }
        let package = norm(&p.join(PACKAGE_INIT));
        if self.files.contains(&package) {
            out.push(package);
        }
        out
    }
}

/// The module paths a Python file can be imported as, shortest first:
/// `pkg/mod/sub.py` → `["sub", "mod.sub", "pkg.mod.sub"]`. An `__init__.py`
/// names its package instead of itself (`pkg/mod/__init__.py` → `"mod"`).
/// Files that are not Python modules contribute nothing.
fn module_paths(file: &Path) -> Vec<String> {
    let mut segs: Vec<String> = file
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    let Some(last) = segs.pop() else { return Vec::new() };
    let suffix = format!(".{MODULE_EXT}");
    let Some(stem) = last.strip_suffix(suffix.as_str()) else { return Vec::new() };
    if stem != "__init__" {
        segs.push(stem.to_string());
    }
    let mut out = Vec::new();
    for i in (0..segs.len()).rev() {
        out.push(segs[i..].join("."));
    }
    out
}

/// True for a segment that is nothing but dots (`.`, `..`, `...`) — a Python
/// relative import keeps its dot run as a single segment.
fn is_dot_run(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c == '.')
}

#[cfg(test)]
mod tests {
    use super::*;
    use cg_ir::{EdgeKey, EdgeSpec, KeyOp, NodeAttrs, NodeSpec, Point, Span};

    fn span(file: &str) -> Span {
        Span {
            file: file.into(),
            start_byte: 0,
            end_byte: 1,
            start: Point { row: 0, col: 0 },
            end: Point { row: 0, col: 1 },
        }
    }

    fn key(lang: Lang, file: &str, qn: &str, kind: NodeKind) -> NodeKey {
        NodeKey::Symbol {
            lang,
            file: file.into(),
            qualified_name: qn.into(),
            kind,
            disambiguator: 0,
        }
    }

    fn file_node(lang: Lang, file: &str) -> KeyOp {
        KeyOp::UpsertNode {
            key: key(lang, file, "", NodeKind::File),
            spec: NodeSpec {
                kind: NodeKind::File,
                label: Path::new(file).file_name().unwrap().to_string_lossy().into_owned(),
                ast_kind: "module".into(),
                span: Some(span(file)),
                is_definition: false,
                attrs: NodeAttrs::default(),
            },
        }
    }

    /// A definition, as `walk.rs` emits it (`is_definition: true`).
    fn def(lang: Lang, file: &str, qn: &str, label: &str, kind: NodeKind) -> KeyOp {
        KeyOp::UpsertNode {
            key: key(lang, file, qn, kind),
            spec: NodeSpec {
                kind,
                label: label.into(),
                ast_kind: "function_definition".into(),
                span: Some(span(file)),
                is_definition: true,
                attrs: NodeAttrs::default(),
            },
        }
    }

    /// A namespace edge: `Class` —Defines→ member.
    fn defines(
        lang: Lang,
        file: &str,
        owner: (&str, NodeKind),
        member: (&str, NodeKind),
    ) -> KeyOp {
        KeyOp::UpsertEdge {
            key: EdgeKey {
                kind: EdgeKind::Defines,
                source: key(lang, file, owner.0, owner.1),
                target: key(lang, file, member.0, member.1),
                ordinal: 0,
            },
            spec: EdgeSpec { kind: EdgeKind::Defines, span: None, weight: 1 },
        }
    }

    /// A call site, exactly as `walk.rs::emit_callsite` records one: an
    /// `Anchored` key under the enclosing function, plus the tag and hint the
    /// enricher reads.
    fn call(
        lang: Lang,
        file: &str,
        in_fn: &str,
        ordinal: u32,
        callee: &str,
        tag: &str,
        hint: Option<&str>,
    ) -> KeyOp {
        let mut extra = BTreeMap::new();
        extra.insert("callee".to_string(), callee.into());
        extra.insert("resolution".to_string(), tag.into());
        if let Some(h) = hint {
            extra.insert("hint".to_string(), h.into());
        }
        KeyOp::UpsertNode {
            key: NodeKey::Anchored {
                ancestor: Box::new(key(lang, file, in_fn, NodeKind::Function)),
                ast_kind: "call".into(),
                ordinal,
            },
            spec: NodeSpec {
                kind: NodeKind::CallSite,
                label: callee.into(),
                ast_kind: "call".into(),
                span: Some(span(file)),
                is_definition: false,
                attrs: NodeAttrs { extra, ..Default::default() },
            },
        }
    }

    fn rec(path: &[&str], alias: Option<&str>) -> ImportRecord {
        ImportRecord {
            path: path.iter().map(|s| s.to_string()).collect(),
            alias: alias.map(str::to_string),
            glob: false,
            span: span("imported.py"),
        }
    }

    fn store(ops: Vec<KeyOp>, imports: &[(&str, Vec<ImportRecord>)]) -> GraphStore {
        let mut s = GraphStore::new();
        let records: Vec<(PathBuf, Vec<ImportRecord>)> = imports
            .iter()
            .map(|(p, r)| (PathBuf::from(p), r.clone()))
            .collect();
        s.ingest(0, &ops, &records, &[]).expect("ingest");
        s
    }

    /// Run the enricher and describe every `Calls` edge it produced, as
    /// `caller -> callee` (sorted, so order is not asserted).
    fn resolved(store: &mut GraphStore) -> Vec<String> {
        let delta = CallGraphEnricher.enrich(store);
        store.apply(&delta).expect("apply");
        let mut out: Vec<String> = store
            .edges_of_kind(EdgeKind::Calls)
            .iter()
            .map(|e| format!("{} -> {}", name_of(store, e.source), name_of(store, e.target)))
            .collect();
        out.sort();
        out
    }

    fn name_of(store: &GraphStore, id: NodeId) -> String {
        match store.interner().lookup_node(id) {
            Some(NodeKey::Anchored { ancestor, .. }) => format!("{} (call)", name_of_key(ancestor)),
            Some(k) => name_of_key(k),
            None => "?".into(),
        }
    }

    fn name_of_key(k: &NodeKey) -> String {
        match k {
            NodeKey::Symbol { qualified_name, file, .. } => {
                if qualified_name.is_empty() {
                    format!("<file {}>", norm(file))
                } else {
                    format!("{}@{}", qualified_name, norm(file))
                }
            }
            _ => "?".into(),
        }
    }






    // ── Python: cross-file calls ────────────────────────────────────────

    /// `from lib import helper` + `helper()`: the hint is a dotted module path,
    /// which is what used to be split on Rust's `::` — so nothing resolved. The
    /// decoy `helper` in `extra.py` is what keeps this test about the import
    /// record: with two candidates the global name lookup cannot decide, so an
    /// edge can only come from `lib.helper` naming `lib.py`.
    #[test]
    fn python_imported_name_reaches_the_imported_module() {
        let ops = vec![
            file_node(Lang::Python, "lib.py"),
            file_node(Lang::Python, "extra.py"),
            file_node(Lang::Python, "main.py"),
            def(Lang::Python, "lib.py", "helper", "helper", NodeKind::Function),
            def(Lang::Python, "extra.py", "helper", "helper", NodeKind::Function),
            def(Lang::Python, "main.py", "caller", "caller", NodeKind::Function),
            call(Lang::Python, "main.py", "caller", 0, "helper", "imported", Some("lib.helper")),
        ];
        let imports = [("main.py", vec![rec(&["lib", "helper"], None)])];
        let mut s = store(ops, &imports);
        assert_eq!(resolved(&mut s), vec!["caller@main.py (call) -> helper@lib.py"]);
    }

    /// `from ..pkg import helper as h2` + `h2()`: `..` walks one directory up
    /// from the importing file, and the alias is the name the call site uses.
    #[test]
    fn python_relative_import_resolves_the_parent_directories_file() {
        let ops = vec![
            file_node(Lang::Python, "agx/pkg.py"),
            file_node(Lang::Python, "agx/model/process.py"),
            def(Lang::Python, "agx/pkg.py", "helper", "helper", NodeKind::Function),
            def(Lang::Python, "agx/model/process.py", "develop", "develop", NodeKind::Function),
            call(
                Lang::Python,
                "agx/model/process.py",
                "develop",
                0,
                "h2",
                "imported",
                Some("...pkg.helper"),
            ),
        ];
        let imports = [(
            "agx/model/process.py",
            vec![rec(&["..", "pkg", "helper"], Some("h2"))],
        )];
        let mut s = store(ops, &imports);
        assert_eq!(
            resolved(&mut s),
            vec!["develop@agx/model/process.py (call) -> helper@agx/pkg.py"]
        );
    }

    /// `from . import sibling` + `sibling.use()`: `.` is the importing file's own
    /// directory, and the receiver is a module bound by that record.
    #[test]
    fn python_dot_import_resolves_the_sibling_file() {
        let ops = vec![
            file_node(Lang::Python, "pkg/sibling.py"),
            file_node(Lang::Python, "pkg/main.py"),
            def(Lang::Python, "pkg/sibling.py", "use", "use", NodeKind::Function),
            def(Lang::Python, "pkg/main.py", "caller", "caller", NodeKind::Function),
            call(
                Lang::Python,
                "pkg/main.py",
                "caller",
                0,
                "use",
                "method_unresolved",
                Some("sibling"),
            ),
        ];
        let imports = [("pkg/main.py", vec![rec(&[".", "sibling"], None)])];
        let mut s = store(ops, &imports);
        assert_eq!(
            resolved(&mut s),
            vec!["caller@pkg/main.py (call) -> use@pkg/sibling.py"]
        );
    }

    /// `import lib` + `lib.other()`: the receiver is the imported module, so the
    /// method is a definition in the file that provides it.
    #[test]
    fn python_module_receiver_resolves_a_module_function() {
        let ops = vec![
            file_node(Lang::Python, "lib.py"),
            file_node(Lang::Python, "main.py"),
            def(Lang::Python, "lib.py", "other", "other", NodeKind::Function),
            def(Lang::Python, "main.py", "caller", "caller", NodeKind::Function),
            call(Lang::Python, "main.py", "caller", 0, "other", "method_unresolved", Some("lib")),
        ];
        let imports = [("main.py", vec![rec(&["lib"], None)])];
        let mut s = store(ops, &imports);
        assert_eq!(resolved(&mut s), vec!["caller@main.py (call) -> other@lib.py"]);
    }

    /// `from pkg.shapes import Shape` + `Shape.area()`: the imported name is a
    /// class, so the method is one of its members.
    #[test]
    fn python_class_receiver_resolves_a_member() {
        let ops = vec![
            file_node(Lang::Python, "pkg/shapes.py"),
            file_node(Lang::Python, "pkg/main.py"),
            def(Lang::Python, "pkg/shapes.py", "Shape", "Shape", NodeKind::Class),
            def(Lang::Python, "pkg/shapes.py", "Shape.area", "area", NodeKind::Method),
            def(Lang::Python, "pkg/main.py", "caller", "caller", NodeKind::Function),
            call(
                Lang::Python,
                "pkg/main.py",
                "caller",
                0,
                "area",
                "method_unresolved",
                Some("Shape"),
            ),
            defines(
                Lang::Python,
                "pkg/shapes.py",
                ("Shape", NodeKind::Class),
                ("Shape.area", NodeKind::Method),
            ),
        ];
        let imports = [("pkg/main.py", vec![rec(&["pkg", "shapes", "Shape"], None)])];
        let mut s = store(ops, &imports);
        assert_eq!(
            resolved(&mut s),
            vec!["caller@pkg/main.py (call) -> Shape.area@pkg/shapes.py"]
        );
    }

    /// A name the file neither defines nor imports still resolves when the whole
    /// store offers exactly one candidate — the behaviour this enricher always
    /// had, kept so the new path cannot narrow the old one.
    #[test]
    fn python_unresolved_name_still_uses_the_global_lookup() {
        let ops = vec![
            file_node(Lang::Python, "far.py"),
            file_node(Lang::Python, "main.py"),
            def(Lang::Python, "far.py", "only_here", "only_here", NodeKind::Function),
            def(Lang::Python, "main.py", "caller", "caller", NodeKind::Function),
            call(Lang::Python, "main.py", "caller", 0, "only_here", "unresolved", None),
        ];
        let mut s = store(ops, &[]);
        assert_eq!(resolved(&mut s), vec!["caller@main.py (call) -> only_here@far.py"]);
    }

    // ── Rust: unchanged ─────────────────────────────────────────────────

    /// The Rust path still works exactly as before: a `use` path strips its
    /// roots and finds the definition by qualified name.
    #[test]
    fn rust_use_path_resolves_through_the_qualified_name() {
        let ops = vec![
            file_node(Lang::Rust, "src/a.rs"),
            file_node(Lang::Rust, "src/b.rs"),
            def(Lang::Rust, "src/b.rs", "b::helper", "helper", NodeKind::Function),
            def(Lang::Rust, "src/a.rs", "a::caller", "caller", NodeKind::Function),
            call(
                Lang::Rust,
                "src/a.rs",
                "a::caller",
                0,
                "helper",
                "imported",
                Some("crate::b::helper"),
            ),
        ];
        let mut s = store(ops, &[]);
        assert_eq!(
            resolved(&mut s),
            vec!["a::caller@src/a.rs (call) -> b::helper@src/b.rs"]
        );
    }

    /// The import records of a file are never consulted for a language that does
    /// not use them: the very record that resolves for Python leaves the Rust
    /// site alone, even with Python's spelling of the path in the hint.
    #[test]
    fn python_records_never_resolve_a_rust_site() {
        let ops = vec![
            file_node(Lang::Rust, "src/a.rs"),
            file_node(Lang::Rust, "src/b.rs"),
            def(Lang::Rust, "src/b.rs", "helper", "helper", NodeKind::Function),
            def(Lang::Rust, "src/a.rs", "a::caller", "caller", NodeKind::Function),
            call(Lang::Rust, "src/a.rs", "a::caller", 0, "helper", "imported", Some("lib.helper")),
        ];
        let imports = [("src/a.rs", vec![rec(&["lib", "helper"], None)])];
        let mut s = store(ops, &imports);
        assert_eq!(resolved(&mut s), Vec::<String>::new());
    }
}


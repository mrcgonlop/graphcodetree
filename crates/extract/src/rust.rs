//! The Rust language profile.
//!
//! This file is Rust *data*: the mapping from tree-sitter-rust kinds to the
//! shared walker's vocabulary ([`LangProfile`]), plus the handful of helpers
//! only Rust needs. The walk itself lives in [`crate::walk`] and holds no
//! grammar kind strings — adding Python is a sibling of this file, not an
//! edit to it.
//!
//! The four-way classifier from the IR design, as a `kind -> ItemClass` map:
//!   Def:         function_item, struct_item, trait_item, const_item, ...
//!   Impl:        impl_item (type/trait fields → `impl_trait`, Defines edges)
//!   Import:      use_declaration (→ FileGraph.imports, no node)
//!   Transparent: everything else — no nodes, never wrong ones.
//!
//! Resolution is syntactic and same-file only (see `walk::resolve_callee`):
//!   foo()            → unique same-file def            ("same_file")
//!   Thing::new()     → same-file qualified match       ("same_file")
//!   self.helper()    → method on enclosing impl type   ("self_method")
//!   imported_name()  → recorded with a path hint       ("imported")
//!   x.method()       → needs types → cg-resolve        ("method_unresolved")
//!   crate::a::b()    → needs crate index → cg-resolve  ("path_unresolved")

use cg_ir::{ImportRecord, Lang, NodeKind, Visibility};
use tree_sitter::Node;

use crate::profile::{
    BindingCapture, BodyRole, CalleeShape, DocAction, ImplInfo, ItemClass, LangProfile,
};
use crate::text::{collapse_ws, first_paragraph};
use crate::walk::{dummy_span, txt};
use crate::{ExtractError, Extractor, FileGraph, SourceFile};

/// A thin handle for today's callers and tests: the Rust profile behind the
/// [`Extractor`] trait. Kept as a unit struct so existing code compiles
/// unchanged; new code should prefer `ProfileExtractor(&RUST)` or
/// [`crate::for_extension`].
pub struct RustExtractor;

impl Extractor for RustExtractor {
    fn lang(&self) -> Lang {
        Lang::Rust
    }

    fn extract(&self, file: &SourceFile) -> Result<FileGraph, ExtractError> {
        crate::walk::extract(&RUST, file)
    }
}

/// The Rust language profile.
pub static RUST: LangProfile = LangProfile {
    lang: Lang::Rust,
    extensions: &["rs"],
    grammar: rust_grammar,
    root_ast_kind: "source_file",
    name_field: "name",
    qual_sep: "::",

    classify: rust_classify,
    doc_comment: rust_doc_comment,
    prev_doc: rust_prev_doc,
    signature: rust_signature,
    visibility: rust_visibility,
    body_of: rust_body_of,
    item_kinds: RUST_ITEM_KINDS,
    simple_resolvable: RUST_SIMPLE_RESOLVABLE,
    method_parents: &[NodeKind::ImplBlock, NodeKind::Trait],
    member_name: rust_member_name,
    owned_doc: None,
    unwrap_def: None,

    call_kinds: RUST_CALL_KINDS,
    call_target: rust_call_target,
    args_field: "arguments",
    callee_shape: rust_callee_shape,
    path_root_strip: &["self"],
    self_receiver: Some("self"),
    binding: rust_binding,
    ident_name: extract_identifier_name,
    imports: rust_imports,

    impl_info: Some(rust_impl_info),
    mod_decl_name: Some(rust_mod_decl_name),
    def_extra: None,
};

fn rust_grammar() -> tree_sitter::Language {
    tree_sitter_rust::LANGUAGE.into()
}

// --- kind tables (the only place these strings live) ----------------------

/// Kinds skipped inside a body's call walk: their own calls belong to them.
/// Nested *items* in fn bodies are a known v1 gap — rare in practice.
static RUST_ITEM_KINDS: &[&str] = &[
    "mod_item",
    "function_item",
    "function_signature_item",
    "struct_item",
    "union_item",
    "enum_item",
    "trait_item",
    "impl_item",
    "use_declaration",
    "const_item",
    "static_item",
    "type_item",
    "associated_type",
    "macro_definition",
];

/// Definition kinds that participate in same-file simple-name resolution.
static RUST_SIMPLE_RESOLVABLE: &[NodeKind] = &[
    NodeKind::Function,
    NodeKind::Struct,
    NodeKind::Enum,
    NodeKind::Trait,
    NodeKind::Constant,
    NodeKind::Static,
    NodeKind::TypeAlias,
    NodeKind::Macro,
    NodeKind::Module,
];

/// Call-site and callee kinds.
static RUST_CALL_KINDS: &[&str] = &["call_expression", "macro_invocation"];

/// Struct/union bodies: `field_declaration` children become `Field`s.
static RUST_STRUCT_MEMBERS: &[(&str, NodeKind)] = &[("field_declaration", NodeKind::Field)];

/// Enum bodies: `enum_variant` children become `EnumVariant`s.
static RUST_ENUM_MEMBERS: &[(&str, NodeKind)] = &[("enum_variant", NodeKind::EnumVariant)];

// --- classify -------------------------------------------------------------

fn rust_classify(kind: &str) -> ItemClass {
    use ItemClass::{Def, Impl, Import, Transparent};
    match kind {
        "mod_item" => Def { kind: NodeKind::Module, body: BodyRole::Scope },
        "function_item" | "function_signature_item" => {
            Def { kind: NodeKind::Function, body: BodyRole::Calls }
        }
        "struct_item" | "union_item" => Def {
            kind: NodeKind::Struct,
            body: BodyRole::Members(RUST_STRUCT_MEMBERS),
        },
        "enum_item" => Def { kind: NodeKind::Enum, body: BodyRole::Members(RUST_ENUM_MEMBERS) },
        "trait_item" => Def { kind: NodeKind::Trait, body: BodyRole::Scope },
        "impl_item" => Impl,
        "use_declaration" => Import,
        "const_item" => Def { kind: NodeKind::Constant, body: BodyRole::Calls },
        "static_item" => Def { kind: NodeKind::Static, body: BodyRole::Calls },
        "type_item" | "associated_type" => Def { kind: NodeKind::TypeAlias, body: BodyRole::None },
        "macro_definition" => Def { kind: NodeKind::Macro, body: BodyRole::None },
        _ => Transparent,
    }
}

// --- documentation, signatures, visibility --------------------------------

/// `///` lines accumulate; attributes and block comments are consumed but
/// leave the buffer alone (they annotate, they do not document).
fn rust_doc_comment(n: Node, src: &[u8]) -> DocAction {
    match n.kind() {
        "line_comment" => DocAction::Comment(doc_line(txt(&n, src))),
        "attribute_item" | "block_comment" => DocAction::Comment(None),
        _ => DocAction::NotComment,
    }
}

/// "/// foo" → Some("foo"). "////" and "//" are not doc comments.
fn doc_line(comment: &str) -> Option<String> {
    if comment.starts_with("////") {
        return None;
    }
    let body = comment.strip_prefix("///")?;
    Some(body.strip_prefix(' ').unwrap_or(body).to_string())
}

/// Contiguous `///` block above a sibling (fields, variants).
fn rust_prev_doc(n: Node, src: &[u8]) -> Option<String> {
    let mut lines = Vec::new();
    let mut cur = n;
    while let Some(p) = cur.prev_named_sibling() {
        match doc_line(txt(&p, src)) {
            Some(l) if p.kind() == "line_comment" => {
                lines.push(l);
                cur = p;
            }
            _ => break,
        }
    }
    lines.reverse();
    first_paragraph(&lines)
}

/// Item text minus leading attributes, up to the body — signatures read
/// `pub async fn f(...) -> T`, not `#[instrument] pub async fn f(...)`.
/// Items without a body (`mod foo;`, trait method decls) sign in full.
fn rust_signature(n: Node, src: &[u8]) -> Option<String> {
    let mut start = n.start_byte();
    let mut cur = n.walk();
    for c in n.named_children(&mut cur) {
        if c.kind() == "attribute_item" {
            start = c.end_byte();
        } else {
            break;
        }
    }
    let end = n
        .child_by_field_name("body")
        .map(|b| b.start_byte())
        .unwrap_or(n.end_byte());
    if start >= end || end > src.len() {
        return None;
    }
    let raw = std::str::from_utf8(&src[start..end]).ok()?.trim();
    if raw.is_empty() {
        None
    } else {
        Some(collapse_ws(raw))
    }
}

/// `pub` / `pub(...)` / default private. Rust has no `protected`; `pub(crate)`
/// and friends are approximated as `Crate`.
fn rust_visibility(n: Node, src: &[u8]) -> Visibility {
    let mut cur = n.walk();
    for c in n.named_children(&mut cur) {
        if c.kind() == "visibility_modifier" {
            let t = txt(&c, src);
            return if t == "pub" {
                Visibility::Public
            } else if t.starts_with("pub(") {
                Visibility::Crate // pub(crate)/pub(super)/pub(in ...) — approximate
            } else {
                Visibility::Private
            };
        }
    }
    Visibility::Private
}

/// A definition's body (`fn`/`struct`/`impl`/...) or value (`const`/`static`).
fn rust_body_of(n: Node) -> Option<Node> {
    n.child_by_field_name("body")
        .or_else(|| n.child_by_field_name("value"))
}

/// Struct fields and enum variants carry their name in the `name` field.
fn rust_member_name(n: Node, src: &[u8]) -> Option<String> {
    n.child_by_field_name("name")
        .map(|m| txt(&m, src).to_string())
}

// --- call sites -----------------------------------------------------------

/// Calls name their callee in `function`; macros in `macro`.
fn rust_call_target(call: Node) -> Option<Node> {
    if call.kind() == "macro_invocation" {
        call.child_by_field_name("macro")
    } else {
        call.child_by_field_name("function")
    }
}

/// How a callee expression resolves syntactically.
fn rust_callee_shape(func: Node, src: &[u8]) -> CalleeShape {
    match func.kind() {
        "identifier" => CalleeShape::Simple,
        "scoped_identifier" => CalleeShape::Path,
        "field_expression" => {
            let method = func
                .child_by_field_name("field")
                .map(|f| txt(&f, src).to_string())
                .unwrap_or_else(|| txt(&func, src).rsplit("::").next().unwrap_or("").to_string());
            let receiver = func
                .child_by_field_name("value")
                .map(|v| txt(&v, src).to_string())
                .unwrap_or_default();
            CalleeShape::Method { receiver, method }
        }
        _ => CalleeShape::Dynamic,
    }
}

/// Data-flow capture: a `let`/assignment whose RHS is a call binds the name.
fn rust_binding(n: Node, src: &[u8]) -> BindingCapture {
    let is_call = |v: Node| RUST_CALL_KINDS.contains(&v.kind());
    match n.kind() {
        "let_declaration" => {
            let has_call = n.child_by_field_name("value").map(is_call).unwrap_or(false);
            if !has_call {
                return BindingCapture::Reset;
            }
            match n.child_by_field_name("pattern") {
                Some(pat) => BindingCapture::Bind(extract_bound_names(pat, src)),
                None => BindingCapture::Leave,
            }
        }
        "assignment_expression" => {
            let has_call = n.child_by_field_name("right").map(is_call).unwrap_or(false);
            if !has_call {
                return BindingCapture::Reset;
            }
            match n.child_by_field_name("left") {
                Some(l) if l.kind() == "identifier" || l.kind() == "field_expression" => {
                    BindingCapture::Bind(vec![txt(&l, src).to_string()])
                }
                _ => BindingCapture::Leave,
            }
        }
        _ => BindingCapture::NotBinding,
    }
}

/// `use a::b::{c, d as e};` — flatten the argument into resolver records.
fn rust_imports(n: Node, out: &mut Vec<ImportRecord>, src: &[u8]) {
    if let Some(arg) = n.child_by_field_name("argument") {
        flatten_use(arg, Vec::new(), out, src);
    }
}

// --- impl blocks, modules, type names -------------------------------------

/// `impl Trait for Type` / `impl Type` → label, type name, optional trait.
fn rust_impl_info(n: Node, src: &[u8]) -> Option<ImplInfo> {
    let type_n = n.child_by_field_name("type")?;
    let type_name = base_type_name(type_n, src);
    let trait_name = n.child_by_field_name("trait").map(|t| base_type_name(t, src));
    let label = match &trait_name {
        Some(t) => format!("{t} for {type_name}"),
        None => format!("impl {type_name}"),
    };
    Some(ImplInfo { label, type_name, trait_name })
}

/// A body-less `mod foo;` — its contents live in a sibling file that
/// cg-resolve joins. `None` for anything that is not a bare module decl.
fn rust_mod_decl_name(n: Node, src: &[u8]) -> Option<String> {
    if n.kind() != "mod_item" {
        return None;
    }
    n.child_by_field_name("name").map(|m| txt(&m, src).to_string())
}

/// "impl<T> Foo<T>" → "Foo"; "impl crate::a::Foo" → "Foo".
fn base_type_name(n: Node, src: &[u8]) -> String {
    match n.kind() {
        "type_identifier" => txt(&n, src).to_string(),
        "generic_type" => n
            .named_child(0)
            .map(|c| base_type_name(c, src))
            .unwrap_or_else(|| txt(&n, src).to_string()),
        "scoped_type_identifier" => n
            .child_by_field_name("name")
            .map(|c| txt(&c, src).to_string())
            .unwrap_or_else(|| txt(&n, src).to_string()),
        _ => collapse_ws(txt(&n, src)),
    }
}

// --- use-tree flattening --------------------------------------------------

fn flatten_use(n: Node, prefix: Vec<String>, out: &mut Vec<ImportRecord>, src: &[u8]) {
    let record = |path: Vec<String>, alias: Option<String>, glob: bool| ImportRecord {
        path,
        alias,
        glob,
        span: dummy_span(), // caller overwrites with the use_declaration span
    };
    match n.kind() {
        "scoped_identifier" => {
            let mut path = prefix;
            path.extend(txt(&n, src).split("::").map(str::to_string));
            out.push(record(path, None, false));
        }
        "identifier" => {
            let mut path = prefix;
            path.push(txt(&n, src).to_string());
            out.push(record(path, None, false));
        }
        "use_as_clause" => {
            let mut cur = n.walk();
            let children: Vec<_> = n.named_children(&mut cur).collect();
            if let Some(target) = children.first() {
                let before = out.len();
                flatten_use(*target, prefix, out, src);
                let alias = n
                    .child_by_field_name("alias")
                    .or_else(|| children.get(1).copied())
                    .map(|a| txt(&a, src).to_string());
                for r in &mut out[before..] {
                    r.alias = alias.clone();
                }
            }
        }
        "scoped_use_list" => {
            // `a::b::{x, y}` — path field when present, else first named child
            let mut cur = n.walk();
            let children: Vec<_> = n.named_children(&mut cur).collect();
            let path_n = n.child_by_field_name("path").or_else(|| children.first().copied());
            let Some(path_n) = path_n else { return };
            let mut pfx = prefix;
            pfx.extend(txt(&path_n, src).split("::").map(str::to_string));
            for c in children {
                if c.id() != path_n.id() {
                    flatten_use(c, pfx.clone(), out, src);
                }
            }
        }
        "use_list" => {
            let mut cur = n.walk();
            for c in n.named_children(&mut cur) {
                flatten_use(c, prefix.clone(), out, src);
            }
        }
        "use_wildcard" => {
            let mut path = prefix;
            if let Some(p) = n.named_child(0) {
                path.extend(txt(&p, src).split("::").map(str::to_string));
            }
            out.push(record(path, None, true));
        }
        _ => {}
    }
}

// --- data-flow name helpers -----------------------------------------------

fn extract_identifier_name(node: Node, src: &[u8]) -> Option<String> {
    match node.kind() {
        "identifier" => Some(txt(&node, src).to_string()),
        "field_expression" => {
            if let Some(value) = node.child_by_field_name("value") {
                extract_identifier_name(value, src)
            } else {
                None
            }
        }
        "reference_expression" | "mut_reference_expression" => {
            if let Some(inner) = node.child_by_field_name("value") {
                extract_identifier_name(inner, src)
            } else {
                let mut cur = node.walk();
                let first = node
                    .named_children(&mut cur)
                    .next()
                    .and_then(|c| extract_identifier_name(c, src));
                first
            }
        }
        "pointer_expression" => {
            let mut cur = node.walk();
            let first = node
                .named_children(&mut cur)
                .next()
                .and_then(|c| extract_identifier_name(c, src));
            first
        }
        _ => None,
    }
}

/// Extract names bound by a let pattern (single or tuple).
fn extract_bound_names(node: Node, src: &[u8]) -> Vec<String> {
    match node.kind() {
        "identifier" => vec![txt(&node, src).to_string()],
        "tuple_pattern" => {
            let mut cur = node.walk();
            node.named_children(&mut cur)
                .filter(|c| c.kind() == "identifier")
                .map(|c| txt(&c, src).to_string())
                .collect()
        }
        _ => Vec::new(),
    }
}

// --- tests: the fixture doubles as the spec for what extraction sees ------

#[cfg(test)]
mod tests {
    use super::*;
    use cg_ir::{EdgeKind, NodeKey, NodeSpec};
    use std::path::PathBuf;

    const FIXTURE: &str = r#"
use std::collections::HashMap;
use crate::delta::{GraphDelta as Delta, GraphOp};

/// A thing does stuff.
///
/// More detail here.
pub struct Thing {
    /// ident
    pub name: String,
    count: u32,
}

pub enum Color { Red, Green }

pub trait Describe {
    fn describe(&self) -> String;
}

impl Thing {
    pub fn new(name: String) -> Self {
        helper();
        Thing { name, count: 0 }
    }
    fn bump(&mut self) {
        self.count += 1;
        self.log();
    }
    fn log(&self) {}
}

impl Describe for Thing {
    fn describe(&self) -> String {
        format!("{}", self.name)
    }
}

fn helper() {}

pub fn top_level() {
    let mut t = Thing::new(String::new());
    t.bump();
    helper();
    std::process::exit(0);
}

mod inner {
    pub fn nested() {}
}
"#;

    fn extract(src: &str) -> FileGraph {
        let file = SourceFile {
            path: "src/fixture.rs".into(),
            lang: Lang::Rust,
            text: src.to_string(),
        };
        RustExtractor.extract(&file).expect("extract")
    }

    fn def_key(g: &FileGraph, qualified: &str) -> NodeKey {
        g.nodes
            .keys()
            .find(|k| matches!(k, NodeKey::Symbol { qualified_name, .. } if qualified_name == qualified))
            .unwrap_or_else(|| panic!("missing def {qualified}"))
            .clone()
    }

    fn node<'a>(g: &'a FileGraph, qualified: &str) -> &'a NodeSpec {
        &g.nodes[&def_key(g, qualified)]
    }

    #[test]
    fn extracts_structure() {
        let g = extract(FIXTURE);
        assert_eq!(g.nodes.len(), 27, "node census changed: {:#?}", g.nodes.keys().collect::<Vec<_>>());
        assert_eq!(g.edges.len(), 34);

        // docs, signatures, visibility
        assert_eq!(node(&g, "Thing").attrs.doc.as_deref(), Some("A thing does stuff."));
        assert!(node(&g, "Thing::new")
            .attrs
            .signature
            .as_deref()
            .unwrap()
            .starts_with("pub fn new(name: String) -> Self"));
        assert_eq!(node(&g, "Thing::bump").attrs.visibility, Visibility::Private);
        assert_eq!(node(&g, "Thing").attrs.visibility, Visibility::Public);

        // qualified names through mod / impl / enum / field
        for q in [
            "inner::nested", "Thing::name", "Color::Red", "Describe::describe",
            "Thing::new", "Thing::describe",
        ] {
            def_key(&g, q);
        }
        assert_eq!(node(&g, "Thing::describe").kind, NodeKind::Method);

        // imports: no nodes, resolver records + simple-name hints
        assert_eq!(g.imports.len(), 3, "{:?}", g.imports);
        assert!(g.imports.iter().any(|r| r.alias.as_deref() == Some("Delta")));

        // namespace edges: Type Defines its members (inherent + trait impl)
        let thing = def_key(&g, "Thing");
        for m in ["Thing::new", "Thing::describe"] {
            let member = def_key(&g, m);
            assert!(g.edges.keys().any(|k| k.kind == EdgeKind::Defines
                && k.source == thing
                && k.target == member));
        }
    }

    #[test]
    fn tracks_data_flow_across_bindings() {
        let src = r#"
fn test() {
    let x = foo();
    bar(x);
    let y = baz();
    qux(&y);
    let (a, b) = foobar();
    both(a, &b);
}
"#;
        let file = SourceFile {
            path: PathBuf::from("test.rs"),
            lang: Lang::Rust,
            text: src.to_string(),
        };
        let fg = RustExtractor.extract(&file).unwrap();

        let flows: Vec<_> = fg.nodes.iter()
            .filter(|(_, n)| n.kind == NodeKind::CallSite)
            .filter(|(_, n)| n.attrs.extra.contains_key("flows_from"))
            .collect();

        assert!(!flows.is_empty(), "expected at least one flows_from annotation");
        let bar_has_flow = fg.nodes.iter().any(|(_, n)| {
            n.label == "bar" && n.attrs.extra.contains_key("flows_from")
        });
        assert!(bar_has_flow, "bar(x) should have flows_from");

        let qux_has_flow = fg.nodes.iter().any(|(_, n)| {
            n.label == "qux" && n.attrs.extra.contains_key("flows_from")
        });
        assert!(qux_has_flow, "qux(&y) should have flows_from");

        let both_has_flow = fg.nodes.iter().any(|(_, n)| {
            n.label == "both" && n.attrs.extra.contains_key("flows_from")
        });
        assert!(both_has_flow, "both(a, &b) should have flows_from");
    }

    #[test]
    fn resolves_same_file_calls() {
        let g = extract(FIXTURE);
        let calls: Vec<_> = g.edges.iter().filter(|(k, _)| k.kind == EdgeKind::Calls).collect();
        assert_eq!(calls.len(), 4, "{calls:#?}");

        // helper() from Thing::new resolves even though helper is defined later
        let new = def_key(&g, "Thing::new");
        let helper = def_key(&g, "helper");
        let site = NodeKey::Anchored {
            ancestor: Box::new(new),
            ast_kind: "call_expression".into(),
            ordinal: 0,
        };
        assert!(calls.iter().any(|(k, _)| k.source == site && k.target == helper));

        // self.log() inside bump → Thing::log
        let log = def_key(&g, "Thing::log");
        assert!(calls.iter().any(|(k, _)| k.target == log));

        // Thing::new() scoped path from top_level
        let new2 = def_key(&g, "Thing::new");
        assert!(calls.iter().any(|(k, _)| k.target == new2));

        // unresolved-but-recorded: method on local, std path, macro
        let sites: Vec<_> = g.nodes.values().filter(|n| n.kind == NodeKind::CallSite).collect();
        assert_eq!(sites.len(), 8);
        for (callee, tag) in [
            ("bump", "method_unresolved"),
            ("exit", "path_unresolved"),
            ("format", "unresolved"),
        ] {
            assert!(sites.iter().any(|s| {
                s.attrs.extra.get("callee").and_then(|v| v.as_str()) == Some(callee)
                    && s.attrs.extra.get("resolution").and_then(|v| v.as_str()) == Some(tag)
            }), "missing {callee}/{tag}");
        }
    }

    #[test]
    fn keys_are_stable_under_body_edits() {
        let before = extract(FIXTURE);
        let edited_src = FIXTURE.replace("fn helper() {}", "fn helper() {\n    // noop\n}");
        let after = extract(&edited_src);
        let ops = crate::diff(&before, &after);

        // identity survives; only specs (spans) change
        assert!(!ops.is_empty());
        assert!(ops.iter().all(|op| !matches!(
            op,
            crate::KeyOp::RemoveNode { .. } | crate::KeyOp::RemoveEdge { .. }
        )), "no identity churn expected: {ops:#?}");

        let callsites = |g: &FileGraph| {
            g.nodes
                .iter()
                .filter(|(_, n)| n.kind == NodeKind::CallSite)
                .map(|(k, _)| k.clone())
                .collect::<std::collections::BTreeSet<_>>()
        };
        assert_eq!(callsites(&before), callsites(&after), "anchored keys renumbered");
    }

    /// The repo renders itself: extract this crate's own extractor sources.
    ///
    /// After the profile refactor the extractor spans three files, so the
    /// dogfood check covers the walker and the profile too, not just this one.
    #[test]
    fn dogfoods_own_source() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut total_nodes = 0usize;
        for (name, expect_def) in [
            ("rust.rs", "RustExtractor"),
            ("walk.rs", "walk_items"),
            ("profile.rs", "LangProfile"),
        ] {
            let path = dir.join(name);
            let text = std::fs::read_to_string(&path).unwrap();
            let file = SourceFile { path: path.clone(), lang: Lang::Rust, text };
            let g = RustExtractor.extract(&file).unwrap();
            def_key(&g, expect_def);

            let sites = g.nodes.values().filter(|n| n.kind == NodeKind::CallSite).count();
            let calls = g.edges.values().filter(|e| e.kind == EdgeKind::Calls).count();
            eprintln!(
                "self-render of {name}: {} nodes ({} call sites), {} edges ({} resolved calls), {} imports",
                g.nodes.len(), sites, g.edges.len(), calls, g.imports.len()
            );
            total_nodes += g.nodes.len();
        }
        assert!(total_nodes > 100, "suspiciously thin self-render: {total_nodes} nodes");
    }
}

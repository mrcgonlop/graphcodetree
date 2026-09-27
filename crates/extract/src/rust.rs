//! Rust structure extraction via a direct tree walk.
//!
//! The four-way classifier from the IR design, as a match over
//! tree-sitter-rust kinds:
//!   Definition:  function_item, struct_item, trait_item, impl_item, ...
//!   Reference:   call_expression, macro_invocation (→ CallSite + Calls)
//!   Container:   mod_item / declaration_list bodies (recurse, new scope)
//!   Transparent: everything else falls through — no nodes, never wrong ones.
//!
//! Two-pass: `walk_items` registers defs and queues body jobs; pass two
//! resolves call sites against the fully-registered def tables, so forward
//! references work. Resolution is syntactic and same-file only:
//!   foo()            → unique same-file def            ("same_file")
//!   Thing::new()     → same-file qualified match       ("same_file")
//!   self.helper()    → method on enclosing impl type   ("self_method")
//!   imported_name()  → recorded with `via_import` hint ("imported")
//!   x.method()       → needs types → cg-resolve        ("method_unresolved")
//!   crate::a::b()    → needs crate index → cg-resolve  ("path_unresolved")

use crate::text::{collapse_ws, doc_line, first_paragraph, signature_of};
use crate::{
    EdgeSpec, ExtractError, Extractor, FileGraph, ImportRecord, ModDecl, NodeSpec, SourceFile,
};
use cg_ir::{
    EdgeKind, EdgeKey, Lang, NodeAttrs, NodeKey, NodeKind, Point, Span, Visibility,
};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use tree_sitter::Node;

pub struct RustExtractor;

impl Extractor for RustExtractor {
    fn lang(&self) -> Lang {
        Lang::Rust
    }

    fn extract(&self, file: &SourceFile) -> Result<FileGraph, ExtractError> {
        if file.lang != Lang::Rust {
            return Err(ExtractError::LangMismatch);
        }
        let language: tree_sitter::Language = tree_sitter_rust::LANGUAGE.into();
        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&language).map_err(|_| ExtractError::LanguageInit)?;
        let tree = parser.parse(&file.text, None).ok_or(ExtractError::ParseFailed)?;

        let file_key = NodeKey::Symbol {
            lang: Lang::Rust,
            file: file.path.clone(),
            qualified_name: String::new(),
            kind: NodeKind::File,
            disambiguator: 0,
        };
        let mut graph = FileGraph::new(&file.path, Lang::Rust, crate::hash_text(&file.text));
        graph.nodes.insert(
            file_key.clone(),
            NodeSpec {
                kind: NodeKind::File,
                label: file
                    .path
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                ast_kind: "source_file".into(),
                span: Some(span_of(&file.path, tree.root_node())),
                is_definition: false,
                attrs: NodeAttrs::default(),
            },
        );

        let mut ctx = Ctx {
            src: file.text.as_bytes(),
            file: file.path.clone(),
            graph,
            used: HashSet::from([file_key.clone()]),
            defs_simple: HashMap::new(),
            defs_qualified: HashMap::new(),
            simple_imports: HashMap::new(),
            call_jobs: Vec::new(),
            defines_jobs: Vec::new(),
        };

        walk_items(&mut ctx, tree.root_node(), &mut Vec::new(), &file_key);

        // Pass 2: everything is registered now; forward references resolve.
        for (body, ancestor, scope) in std::mem::take(&mut ctx.call_jobs) {
            extract_calls(&mut ctx, body, &ancestor, &scope);
        }
        for (ty, members) in std::mem::take(&mut ctx.defines_jobs) {
            // Namespace fact: Type—Defines→member (syntactic counterpart of
            // Contains, which is ImplBlock—Contains→member).
            if let Some(target) = unique_simple(&ctx, &ty) {
                for m in members {
                    add_edge(&mut ctx, EdgeKind::Defines, target.clone(), m, None);
                }
            }
        }
        Ok(ctx.graph)
    }
}

struct Ctx<'a, 't> {
    src: &'a [u8],
    file: PathBuf,
    graph: FileGraph,
    used: HashSet<NodeKey>,
    /// simple name → all defs with that name (resolve only if unique)
    defs_simple: HashMap<String, Vec<NodeKey>>,
    /// "inner::Thing::new" → key; drives scoped-path and self-method lookup
    defs_qualified: HashMap<String, NodeKey>,
    /// imported simple name → full use path (resolver hint)
    simple_imports: HashMap<String, String>,
    call_jobs: Vec<(Node<'t>, NodeKey, Vec<String>)>,
    defines_jobs: Vec<(String, Vec<NodeKey>)>,
}

/// Walks one item container, emitting defs + Contains edges and queueing
/// body jobs. Returns direct definitional children (impl wires them into
/// Type—Defines→member edges).
fn walk_items<'a>(
    ctx: &mut Ctx<'a, 'a>,
    container: Node<'a>,
    scope: &mut Vec<String>,
    parent: &NodeKey,
) -> Vec<NodeKey> {
    let mut emitted = Vec::new();
    let mut pending_docs: Vec<String> = Vec::new();
    let mut cursor = container.walk();

    for child in container.named_children(&mut cursor) {
        match child.kind() {
            "line_comment" => {
                if let Some(l) = doc_line(txt(&child, ctx.src)) {
                    pending_docs.push(l);
                }
                continue;
            }
            // attributes belong to the next item; don't reset pending docs
            "attribute_item" | "block_comment" => continue,
            _ => {}
        }
        let doc = first_paragraph(&pending_docs);
        pending_docs.clear();

        match child.kind() {
            "mod_item" => {
                let Some(name_n) = child.child_by_field_name("name") else { continue };
                let name = txt(&name_n, ctx.src).to_string();
                let key = emit_def(ctx, parent, scope, child, NodeKind::Module, &name, doc);
                emitted.push(key.clone());
                match child.child_by_field_name("body") {
                    Some(body) => {
                        scope.push(name);
                        walk_items(ctx, body, scope, &key);
                        scope.pop();
                    }
                    None => {
                        // `mod foo;` — contents live in a sibling file; cg-resolve joins them.
                        ctx.graph.mod_decls.push(ModDecl {
                            name,
                            span: span_of(&ctx.file, child),
                        });
                        if let Some(n) = ctx.graph.nodes.get_mut(&key) {
                            n.attrs.extra.insert("external_file".into(), true.into());
                        }
                    }
                }
            }
            "function_item" | "function_signature_item" => {
                let Some(name_n) = child.child_by_field_name("name") else { continue };
                let name = txt(&name_n, ctx.src).to_string();
                let parent_kind = ctx.graph.nodes.get(parent).map(|n| n.kind);
                let kind = if matches!(parent_kind, Some(NodeKind::ImplBlock | NodeKind::Trait)) {
                    NodeKind::Method
                } else {
                    NodeKind::Function
                };
                let key = emit_def(ctx, parent, scope, child, kind, &name, doc);
                emitted.push(key.clone());
                if let Some(body) = child.child_by_field_name("body") {
                    ctx.call_jobs.push((body, key, scope.clone()));
                }
            }
            "struct_item" | "union_item" => {
                let Some(name_n) = child.child_by_field_name("name") else { continue };
                let name = txt(&name_n, ctx.src).to_string();
                let key = emit_def(ctx, parent, scope, child, NodeKind::Struct, &name, doc);
                emitted.push(key.clone());
                if let Some(body) = child.child_by_field_name("body") {
                    let mut fcur = body.walk();
                    for f in body.named_children(&mut fcur) {
                        if f.kind() != "field_declaration" {
                            continue; // tuple structs degrade gracefully: no field nodes
                        }
                        let Some(fname_n) = f.child_by_field_name("name") else { continue };
                        let fname = txt(&fname_n, ctx.src).to_string();
                        let fdoc = prev_doc(f, ctx.src);
                        scope.push(name.clone());
                        emit_def(ctx, &key, scope, f, NodeKind::Field, &fname, fdoc);
                        scope.pop();
                    }
                }
            }
            "enum_item" => {
                let Some(name_n) = child.child_by_field_name("name") else { continue };
                let name = txt(&name_n, ctx.src).to_string();
                let key = emit_def(ctx, parent, scope, child, NodeKind::Enum, &name, doc);
                emitted.push(key.clone());
                if let Some(body) = child.child_by_field_name("body") {
                    let mut vcur = body.walk();
                    for v in body.named_children(&mut vcur) {
                        if v.kind() != "enum_variant" {
                            continue;
                        }
                        let Some(vname_n) = v.child_by_field_name("name") else { continue };
                        let vname = txt(&vname_n, ctx.src).to_string();
                        let vdoc = prev_doc(v, ctx.src);
                        scope.push(name.clone());
                        emit_def(ctx, &key, scope, v, NodeKind::EnumVariant, &vname, vdoc);
                        scope.pop();
                    }
                }
            }
            "trait_item" => {
                let Some(name_n) = child.child_by_field_name("name") else { continue };
                let name = txt(&name_n, ctx.src).to_string();
                let key = emit_def(ctx, parent, scope, child, NodeKind::Trait, &name, doc);
                emitted.push(key.clone());
                if let Some(body) = child.child_by_field_name("body") {
                    scope.push(name);
                    walk_items(ctx, body, scope, &key);
                    scope.pop();
                }
            }
            "impl_item" => {
                let Some(type_n) = child.child_by_field_name("type") else { continue };
                let ty = base_type_name(type_n, ctx.src);
                let trait_name = child
                    .child_by_field_name("trait")
                    .map(|t| base_type_name(t, ctx.src));
                let label = match &trait_name {
                    Some(t) => format!("{t} for {ty}"),
                    None => format!("impl {ty}"),
                };
                let key = emit_def(ctx, parent, scope, child, NodeKind::ImplBlock, &label, doc);
                emitted.push(key.clone());
                if let (Some(t), Some(n)) = (&trait_name, ctx.graph.nodes.get_mut(&key)) {
                    n.attrs.extra.insert("impl_trait".into(), t.clone().into());
                }
                if let Some(body) = child.child_by_field_name("body") {
                    scope.push(ty.clone());
                    let members = walk_items(ctx, body, scope, &key);
                    scope.pop();
                    ctx.defines_jobs.push((ty, members));
                }
            }
            "use_declaration" => {
                // No node — imports are resolver input, plus the simple-name
                // table used for "imported" hints on call sites.
                if let Some(arg) = child.child_by_field_name("argument") {
                    let src = ctx.src;
                    let before = ctx.graph.imports.len();
                    flatten_use(arg, Vec::new(), &mut ctx.graph.imports, src);
                    for r in &mut ctx.graph.imports[before..] {
                        r.span = span_of(&ctx.file, child);
                        if !r.glob {
                            let name = r
                                .alias
                                .clone()
                                .unwrap_or_else(|| r.path.last().cloned().unwrap_or_default());
                            ctx.simple_imports.insert(name, r.path.join("::"));
                        }
                    }
                }
            }
            "const_item" | "static_item" => {
                let Some(name_n) = child.child_by_field_name("name") else { continue };
                let name = txt(&name_n, ctx.src).to_string();
                let kind = if child.kind() == "const_item" {
                    NodeKind::Constant
                } else {
                    NodeKind::Static
                };
                let key = emit_def(ctx, parent, scope, child, kind, &name, doc);
                emitted.push(key.clone());
                if let Some(value) = child.child_by_field_name("value") {
                    ctx.call_jobs.push((value, key, scope.clone()));
                }
            }
            "type_item" | "associated_type" => {
                let Some(name_n) = child.child_by_field_name("name") else { continue };
                let name = txt(&name_n, ctx.src).to_string();
                let key = emit_def(ctx, parent, scope, child, NodeKind::TypeAlias, &name, doc);
                emitted.push(key);
            }
            "macro_definition" => {
                let Some(name_n) = child.child_by_field_name("name") else { continue };
                let name = txt(&name_n, ctx.src).to_string();
                let key = emit_def(ctx, parent, scope, child, NodeKind::Macro, &name, doc);
                emitted.push(key);
            }
            _ => {} // transparent at item level: loose statements, extern crate, ERROR nodes
        }
    }
    emitted
}

#[allow(clippy::too_many_arguments)]
fn emit_def(
    ctx: &mut Ctx<'_, '_>,
    parent: &NodeKey,
    scope: &[String],
    node: Node,
    kind: NodeKind,
    name: &str,
    doc: Option<String>,
) -> NodeKey {
    let qualified = if scope.is_empty() {
        name.to_string()
    } else {
        format!("{}::{name}", scope.join("::"))
    };
    // Collisions (inherent + trait impl with same method name) bump the
    // disambiguator instead of overwriting.
    let mut disambiguator = 0u32;
    let key = loop {
        let k = NodeKey::Symbol {
            lang: Lang::Rust,
            file: ctx.file.clone(),
            qualified_name: qualified.clone(),
            kind,
            disambiguator,
        };
        if ctx.used.insert(k.clone()) {
            break k;
        }
        disambiguator += 1;
    };

    let spec = NodeSpec {
        kind,
        label: name.to_string(),
        ast_kind: node.kind().to_string(),
        span: Some(span_of(&ctx.file, node)),
        is_definition: true,
        attrs: NodeAttrs {
            signature: signature_of(node, ctx.src),
            visibility: visibility_of(node, ctx.src),
            doc,
            extra: BTreeMap::new(),
        },
    };
    ctx.defs_qualified.insert(qualified, key.clone());
    if matches!(
        kind,
        NodeKind::Function
            | NodeKind::Struct
            | NodeKind::Enum
            | NodeKind::Trait
            | NodeKind::Constant
            | NodeKind::Static
            | NodeKind::TypeAlias
            | NodeKind::Macro
            | NodeKind::Module
    ) {
        ctx.defs_simple.entry(name.to_string()).or_default().push(key.clone());
    }
    ctx.graph.nodes.insert(key.clone(), spec);
    add_edge(ctx, EdgeKind::Contains, parent.clone(), key.clone(), None);
    key
}

/// DFS for call sites. Nested items are skipped (their calls belong to
/// them); nested *items* in fn bodies are a known v1 gap — rare in practice.
fn extract_calls(ctx: &mut Ctx<'_, '_>, root: Node, ancestor: &NodeKey, scope: &[String]) {
    let mut ordinal = 0u32;
    let mut stack = vec![root];
    while let Some(n) = stack.pop() {
        if n != root && is_item(n.kind()) {
            continue;
        }
        match n.kind() {
            "call_expression" => {
                emit_callsite(ctx, ancestor, scope, ordinal, n);
                ordinal += 1;
            }
            "macro_invocation" => {
                emit_callsite(ctx, ancestor, scope, ordinal, n);
                ordinal += 1;
            }
            _ => {}
        }
        let mut cur = n.walk();
        let children: Vec<_> = n.named_children(&mut cur).collect();
        for c in children.into_iter().rev() {
            stack.push(c); // pre-order ≈ source order → stable ordinals
        }
    }
}

fn emit_callsite(
    ctx: &mut Ctx<'_, '_>,
    ancestor: &NodeKey,
    scope: &[String],
    ordinal: u32,
    call: Node,
) {
    let is_macro = call.kind() == "macro_invocation";
    let func = if is_macro {
        call.child_by_field_name("macro")
    } else {
        call.child_by_field_name("function")
    };
    let Some(func) = func else { return };

    let callee = txt(&func, ctx.src).to_string();
    let res = resolve_callee(ctx, scope, func, &callee);

    let key = NodeKey::Anchored {
        ancestor: Box::new(ancestor.clone()),
        ast_kind: call.kind().to_string(),
        ordinal,
    };
    let mut extra = BTreeMap::new();
    extra.insert("callee".into(), res.label.clone().into());
    extra.insert("resolution".into(), res.tag.into());
    if let Some(hint) = res.hint {
        extra.insert("hint".into(), hint.into());
    }
    ctx.graph.nodes.insert(
        key.clone(),
        NodeSpec {
            kind: NodeKind::CallSite,
            label: res.label,
            ast_kind: call.kind().to_string(),
            span: Some(span_of(&ctx.file, call)),
            is_definition: false,
            attrs: NodeAttrs { extra, ..Default::default() },
        },
    );
    add_edge(ctx, EdgeKind::Contains, ancestor.clone(), key.clone(), None);
    if let Some(target) = res.target {
        add_edge(ctx, EdgeKind::Calls, key, target, Some(span_of(&ctx.file, call)));
    }
}

struct Resolution {
    label: String,
    tag: &'static str,
    target: Option<NodeKey>,
    hint: Option<String>,
}

fn resolve_callee(ctx: &Ctx<'_, '_>, scope: &[String], func: Node, callee: &str) -> Resolution {
    let short = || callee.rsplit("::").next().unwrap_or(callee).to_string();
    match func.kind() {
        "identifier" => {
            if let Some(k) = unique_simple(ctx, callee) {
                return Resolution { label: short(), tag: "same_file", target: Some(k), hint: None };
            }
            if let Some(path) = ctx.simple_imports.get(callee) {
                return Resolution {
                    label: short(),
                    tag: "imported",
                    target: None,
                    hint: Some(path.clone()),
                };
            }
            Resolution { label: short(), tag: "unresolved", target: None, hint: None }
        }
        "scoped_identifier" => {
            if let Some(k) = ctx.defs_qualified.get(callee) {
                return Resolution { label: short(), tag: "same_file", target: Some(k.clone()), hint: None };
            }
            if let Some(stripped) = callee.strip_prefix("self::") {
                if let Some(k) = ctx.defs_qualified.get(stripped) {
                    return Resolution { label: short(), tag: "same_file", target: Some(k.clone()), hint: None };
                }
            }
            Resolution { label: short(), tag: "path_unresolved", target: None, hint: Some(callee.into()) }
        }
        "field_expression" => {
            let method = func
                .child_by_field_name("field")
                .map(|f| txt(&f, ctx.src).to_string())
                .unwrap_or_else(|| short());
            let receiver = func
                .child_by_field_name("value")
                .map(|v| txt(&v, ctx.src).to_string())
                .unwrap_or_default();
            if receiver == "self" && !scope.is_empty() {
                let q = format!("{}::{method}", scope.join("::"));
                if let Some(k) = ctx.defs_qualified.get(&q) {
                    return Resolution { label: method, tag: "self_method", target: Some(k.clone()), hint: None };
                }
            }
            Resolution {
                label: method,
                tag: "method_unresolved",
                target: None,
                hint: Some(receiver.chars().take(32).collect()),
            }
        }
        _ => Resolution {
            label: callee.chars().take(32).collect(),
            tag: "dynamic",
            target: None,
            hint: None,
        },
    }
}

// --- use-tree flattening -------------------------------------------------

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

// --- small helpers --------------------------------------------------------

fn is_item(kind: &str) -> bool {
    matches!(
        kind,
        "mod_item"
            | "function_item"
            | "function_signature_item"
            | "struct_item"
            | "union_item"
            | "enum_item"
            | "trait_item"
            | "impl_item"
            | "use_declaration"
            | "const_item"
            | "static_item"
            | "type_item"
            | "associated_type"
            | "macro_definition"
    )
}

fn unique_simple(ctx: &Ctx<'_, '_>, name: &str) -> Option<NodeKey> {
    let v = ctx.defs_simple.get(name)?;
    if v.len() == 1 { Some(v[0].clone()) } else { None }
}

fn add_edge(ctx: &mut Ctx<'_, '_>, kind: EdgeKind, source: NodeKey, target: NodeKey, span: Option<Span>) {
    let key = EdgeKey { kind, source: source.clone(), target: target.clone(), ordinal: 0 };
    ctx.graph.edges.insert(key, EdgeSpec { kind, source, target, span, weight: 1 });
}

fn visibility_of(n: Node, src: &[u8]) -> Visibility {
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

/// Contiguous `///` block above a sibling (fields, variants).
fn prev_doc(n: Node, src: &[u8]) -> Option<String> {
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

fn txt<'a>(n: &Node, src: &'a [u8]) -> &'a str {
    n.utf8_text(src).unwrap_or("")
}

fn span_of(file: &Path, n: Node) -> Span {
    Span {
        file: file.into(),
        start_byte: n.start_byte() as u32,
        end_byte: n.end_byte() as u32,
        start: Point { row: n.start_position().row as u32, col: n.start_position().column as u32 },
        end: Point { row: n.end_position().row as u32, col: n.end_position().column as u32 },
    }
}

fn dummy_span() -> Span {
    Span {
        file: PathBuf::new(),
        start_byte: 0,
        end_byte: 0,
        start: Point { row: 0, col: 0 },
        end: Point { row: 0, col: 0 },
    }
}

// --- tests: the fixture doubles as the spec for what extraction sees ------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SourceFile;

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
    fn resolves_same_file_calls() {
        let g = extract(FIXTURE);
        let calls: Vec<_> = g.edges.values().filter(|e| e.kind == EdgeKind::Calls).collect();
        assert_eq!(calls.len(), 4, "{calls:#?}");

        // helper() from Thing::new resolves even though helper is defined later
        let new = def_key(&g, "Thing::new");
        let helper = def_key(&g, "helper");
        let site = NodeKey::Anchored {
            ancestor: Box::new(new),
            ast_kind: "call_expression".into(),
            ordinal: 0,
        };
        assert!(calls.iter().any(|e| e.source == site && e.target == helper));

        // self.log() inside bump → Thing::log
        let log = def_key(&g, "Thing::log");
        assert!(calls.iter().any(|e| e.target == log));

        // Thing::new() scoped path from top_level
        let new2 = def_key(&g, "Thing::new");
        assert!(calls.iter().any(|e| e.target == new2));

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

    /// The repo renders itself: extract this very file.
    #[test]
    fn dogfoods_own_source() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/rust.rs");
        let text = std::fs::read_to_string(&path).unwrap();
        let file = SourceFile { path: path.clone(), lang: Lang::Rust, text };
        let g = RustExtractor.extract(&file).unwrap();

        def_key(&g, "RustExtractor");
        def_key(&g, "walk_items");
        assert!(g.nodes.len() > 60, "suspiciously thin self-render");

        let sites = g.nodes.values().filter(|n| n.kind == NodeKind::CallSite).count();
        let calls = g.edges.values().filter(|e| e.kind == EdgeKind::Calls).count();
        eprintln!(
            "self-render of rust.rs: {} nodes ({} call sites), {} edges ({} resolved calls), {} imports",
            g.nodes.len(), sites, g.edges.len(), calls, g.imports.len()
        );
    }
}
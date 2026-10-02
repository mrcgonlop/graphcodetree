//! The shared tree walker: grammar-agnostic, driven by a [`LangProfile`].
//!
//! Two passes per file. `walk_items` registers every definition (so forward
//! references resolve) and queues body jobs; pass two resolves call sites
//! against the fully-registered def tables. This file contains **no**
//! tree-sitter kind strings: every grammar-dependent branch is a
//! [`LangProfile`] call, so a new language is a new profile, not an edit here.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use cg_ir::{
    EdgeKey, EdgeKind, EdgeSpec, ModDecl, NodeAttrs, NodeKey, NodeKind, NodeSpec, Point, Span,
};
use tree_sitter::Node;

use crate::profile::{BindingCapture, BodyRole, CalleeShape, DocAction, ItemClass, LangProfile};
use crate::text::first_paragraph;
use crate::{ExtractError, FileGraph, SourceFile};

/// Per-file extraction state. `used` guarantees unique `Symbol` keys within a
/// file (e.g. an inherent and a trait impl with the same method name bump the
/// disambiguator); the two `defs_*` tables are what pass two resolves against.
struct Ctx<'a, 't> {
    profile: &'static LangProfile,
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

/// Parse one file with the profile's grammar and walk it into a `FileGraph`.
pub(crate) fn extract(
    profile: &'static LangProfile,
    file: &SourceFile,
) -> Result<FileGraph, ExtractError> {
    if profile.lang != file.lang {
        return Err(ExtractError::LangMismatch);
    }
    let language: tree_sitter::Language = (profile.grammar)();
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&language).map_err(|_| ExtractError::LanguageInit)?;
    let tree = parser.parse(&file.text, None).ok_or(ExtractError::ParseFailed)?;

    let file_key = NodeKey::Symbol {
        lang: profile.lang,
        file: file.path.clone(),
        qualified_name: String::new(),
        kind: NodeKind::File,
        disambiguator: 0,
    };
    let mut graph = FileGraph::new(&file.path, profile.lang, crate::hash_text(&file.text));
    graph.nodes.insert(
        file_key.clone(),
        NodeSpec {
            kind: NodeKind::File,
            label: file
                .path
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default(),
            ast_kind: profile.root_ast_kind.into(),
            span: Some(span_of(&file.path, tree.root_node())),
            is_definition: false,
            attrs: NodeAttrs::default(),
        },
    );

    let mut ctx = Ctx {
        profile,
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

    walk_items(&mut ctx, tree.root_node(), &mut Vec::new(), &file_key, 0);

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

/// Walks one item container, emitting defs + `Contains` edges and queueing
/// body jobs. Returns the direct definitional children (impl wires them into
/// `Type—Defines→member` edges).
fn walk_items<'a>(
    ctx: &mut Ctx<'a, 'a>,
    container: Node<'a>,
    scope: &mut Vec<String>,
    parent: &NodeKey,
    depth: u32,
) -> Vec<NodeKey> {
    let profile = ctx.profile;
    let mut emitted = Vec::new();
    let mut pending_docs: Vec<String> = Vec::new();
    let mut cursor = container.walk();

    for child in container.named_children(&mut cursor) {
        // Leading doc comments / attributes accumulate before a definition.
        match (profile.doc_comment)(child, ctx.src) {
            DocAction::Comment(Some(line)) => {
                pending_docs.push(line);
                continue;
            }
            DocAction::Comment(None) => continue,
            DocAction::NotComment => {}
        }
        let doc = first_paragraph(&pending_docs);
        pending_docs.clear();

        match (profile.classify)(child.kind()) {
            ItemClass::Transparent => {}

            ItemClass::Import => {
                let src = ctx.src;
                let before = ctx.graph.imports.len();
                (profile.imports)(child, &mut ctx.graph.imports, src);
                for r in &mut ctx.graph.imports[before..] {
                    r.span = span_of(&ctx.file, child);
                    if !r.glob {
                        let name = r
                            .alias
                            .clone()
                            .unwrap_or_else(|| r.path.last().cloned().unwrap_or_default());
                        ctx.simple_imports.insert(name, r.path.join(profile.qual_sep));
                    }
                }
            }

            ItemClass::Def { kind, body } => {
                let Some(name_n) = child.child_by_field_name(profile.name_field) else {
                    continue;
                };
                let name = txt(&name_n, ctx.src).to_string();
                let kind = promoted_kind(ctx, parent, kind);
                let key = emit_def(ctx, parent, scope, child, kind, &name, doc, depth);
                emitted.push(key.clone());
                handle_body(ctx, child, &key, scope, &name, body, depth);
            }

            ItemClass::Impl => {
                let Some(impl_info) = profile.impl_info else { continue };
                let Some(info) = impl_info(child, ctx.src) else { continue };
                let key = emit_def(
                    ctx,
                    parent,
                    scope,
                    child,
                    NodeKind::ImplBlock,
                    &info.label,
                    doc,
                    depth,
                );
                emitted.push(key.clone());
                if let (Some(t), Some(node)) = (&info.trait_name, ctx.graph.nodes.get_mut(&key)) {
                    node.attrs.extra.insert("impl_trait".into(), t.clone().into());
                }
                if let Some(body) = (profile.body_of)(child) {
                    scope.push(info.type_name.clone());
                    let members = walk_items(ctx, body, scope, &key, depth + 1);
                    scope.pop();
                    ctx.defines_jobs.push((info.type_name, members));
                }
            }
        }
    }
    emitted
}

/// A `Function` inside an impl/trait/class becomes a `Method`; the profile's
/// `method_parents` table says which parents promote.
fn promoted_kind(ctx: &Ctx<'_, '_>, parent: &NodeKey, kind: NodeKind) -> NodeKind {
    if kind != NodeKind::Function {
        return kind;
    }
    match ctx.graph.nodes.get(parent).map(|n| n.kind) {
        Some(pk) if ctx.profile.method_parents.contains(&pk) => NodeKind::Method,
        _ => kind,
    }
}

/// Applies a [`BodyRole`] to a just-emitted definition.
fn handle_body<'a>(
    ctx: &mut Ctx<'a, 'a>,
    node: Node<'a>,
    key: &NodeKey,
    scope: &mut Vec<String>,
    name: &str,
    role: BodyRole,
    depth: u32,
) {
    let profile = ctx.profile;
    match role {
        BodyRole::None => {}

        BodyRole::Calls => {
            if let Some(body) = (profile.body_of)(node) {
                ctx.call_jobs.push((body, key.clone(), scope.clone()));
            }
        }

        BodyRole::Scope => {
            if let Some(body) = (profile.body_of)(node) {
                scope.push(name.to_string());
                walk_items(ctx, body, scope, key, depth + 1);
                scope.pop();
            } else if let Some(extern_name) = profile.mod_decl_name.and_then(|f| f(node, ctx.src)) {
                // `mod foo;` — no inline body: record the declaration for the
                // resolver and mark the node as living in another file.
                let span = span_of(&ctx.file, node);
                ctx.graph.mod_decls.push(ModDecl { name: extern_name, span });
                if let Some(n) = ctx.graph.nodes.get_mut(key) {
                    n.attrs.extra.insert("external_file".into(), true.into());
                }
            }
        }

        BodyRole::Members(table) => {
            if let Some(body) = (profile.body_of)(node) {
                let mut mcur = body.walk();
                for m in body.named_children(&mut mcur) {
                    let Some((_, mk)) = table.iter().find(|(k, _)| *k == m.kind()) else {
                        continue;
                    };
                    let Some(mname_n) = m.child_by_field_name(profile.name_field) else {
                        continue;
                    };
                    let mname = txt(&mname_n, ctx.src).to_string();
                    let mdoc = (profile.prev_doc)(m, ctx.src);
                    scope.push(name.to_string());
                    emit_def(ctx, key, scope, m, *mk, &mname, mdoc, depth + 1);
                    scope.pop();
                }
            }
        }
    }
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
    depth: u32,
) -> NodeKey {
    let profile = ctx.profile;
    let qualified = if scope.is_empty() {
        name.to_string()
    } else {
        format!("{}{}{name}", scope.join(profile.qual_sep), profile.qual_sep)
    };
    // Collisions (inherent + trait impl with same method name) bump the
    // disambiguator instead of overwriting.
    let mut disambiguator = 0u32;
    let key = loop {
        let k = NodeKey::Symbol {
            lang: profile.lang,
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
            signature: (profile.signature)(node, ctx.src),
            visibility: (profile.visibility)(node, ctx.src),
            doc,
            extra: {
                let mut m = BTreeMap::new();
                m.insert("depth".into(), serde_json::json!(depth));
                m
            },
        },
    };
    ctx.defs_qualified.insert(qualified, key.clone());
    if profile.simple_resolvable.contains(&kind) {
        ctx.defs_simple.entry(name.to_string()).or_default().push(key.clone());
    }
    ctx.graph.nodes.insert(key.clone(), spec);
    add_edge(ctx, EdgeKind::Contains, parent.clone(), key.clone(), None);
    key
}

/// DFS for call sites. Nested items are skipped (their calls belong to them);
/// nested *items* in fn bodies are a known v1 gap — rare in practice.
///
/// Maintains a binding context so data-flow edges can be emitted: when a `let`
/// binding or `=` assignment captures a call result, subsequent calls that
/// pass that variable as an argument get a `flows_from` extra pointing back to
/// the producing call's ordinal.
fn extract_calls(ctx: &mut Ctx<'_, '_>, root: Node, ancestor: &NodeKey, scope: &[String]) {
    let profile = ctx.profile;
    let mut flat: Vec<tree_sitter::Node> = Vec::new();
    {
        let mut walk_stack = vec![root];
        while let Some(n) = walk_stack.pop() {
            if n != root && profile.item_kinds.contains(&n.kind()) {
                continue;
            }
            flat.push(n);
            let mut cur = n.walk();
            let children: Vec<_> = n.named_children(&mut cur).collect();
            for c in children.into_iter().rev() {
                walk_stack.push(c);
            }
        }
    }

    let mut ordinal = 0u32;
    let mut bindings: HashMap<String, u32> = HashMap::new();
    let mut pending_bindings: Vec<String> = Vec::new();

    flat.sort_by_key(|n| n.start_byte());
    for &n in &flat {
        if profile.call_kinds.contains(&n.kind()) {
            if !pending_bindings.is_empty() {
                for name in pending_bindings.drain(..) {
                    bindings.insert(name, ordinal);
                }
            }
            emit_callsite(ctx, ancestor, scope, ordinal, n, &bindings);
            ordinal += 1;
        } else {
            match (profile.binding)(n, ctx.src) {
                BindingCapture::NotBinding | BindingCapture::Leave => {}
                BindingCapture::Bind(names) => pending_bindings = names,
                BindingCapture::Reset => pending_bindings.clear(),
            }
        }
    }
}

/// Emits one `CallSite` node + its `Contains`/`Calls` edges, annotating
/// `flows_from` when arguments reference previously-bound call results.
fn emit_callsite(
    ctx: &mut Ctx<'_, '_>,
    ancestor: &NodeKey,
    scope: &[String],
    ordinal: u32,
    call: Node,
    bindings: &HashMap<String, u32>,
) {
    let profile = ctx.profile;
    let Some(func) = (profile.call_target)(call) else { return };

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

    // Track data flow: which arguments reference previously-bound variables.
    if !bindings.is_empty() {
        let mut flows = Vec::new();
        if let Some(args) = call.child_by_field_name(profile.args_field) {
            let mut cur = args.walk();
            for (i, arg) in args.named_children(&mut cur).enumerate() {
                if let Some(name) = (profile.ident_name)(arg, ctx.src) {
                    if let Some(&producer_ordinal) = bindings.get(&name) {
                        flows.push(format!("{i}->{producer_ordinal}"));
                    }
                }
            }
        }
        if !flows.is_empty() {
            extra.insert("flows_from".into(), flows.join(",").into());
        }
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

/// Resolve a callee syntactically, same-file only. The profile's
/// [`CalleeShape`] decision replaces what would otherwise be a match over
/// grammar kind strings here.
fn resolve_callee(ctx: &Ctx<'_, '_>, scope: &[String], func: Node, callee: &str) -> Resolution {
    let profile = ctx.profile;
    let sep = profile.qual_sep;
    let short = || callee.rsplit(sep).next().unwrap_or(callee).to_string();
    match (profile.callee_shape)(func, ctx.src) {
        CalleeShape::Simple => {
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
        CalleeShape::Path => {
            if let Some(k) = ctx.defs_qualified.get(callee) {
                return Resolution { label: short(), tag: "same_file", target: Some(k.clone()), hint: None };
            }
            for root in profile.path_root_strip {
                if let Some(stripped) = callee.strip_prefix(&format!("{root}{sep}")) {
                    if let Some(k) = ctx.defs_qualified.get(stripped) {
                        return Resolution {
                            label: short(),
                            tag: "same_file",
                            target: Some(k.clone()),
                            hint: None,
                        };
                    }
                }
            }
            Resolution { label: short(), tag: "path_unresolved", target: None, hint: Some(callee.into()) }
        }
        CalleeShape::Method { receiver, method } => {
            if profile.self_receiver == Some(receiver.as_str()) && !scope.is_empty() {
                let q = format!("{}{sep}{method}", scope.join(sep));
                if let Some(k) = ctx.defs_qualified.get(&q) {
                    return Resolution {
                        label: method,
                        tag: "self_method",
                        target: Some(k.clone()),
                        hint: None,
                    };
                }
            }
            Resolution {
                label: method,
                tag: "method_unresolved",
                target: None,
                hint: Some(receiver.chars().take(32).collect()),
            }
        }
        CalleeShape::Dynamic => Resolution {
            label: callee.chars().take(32).collect(),
            tag: "dynamic",
            target: None,
            hint: None,
        },
    }
}

// --- small helpers --------------------------------------------------------

fn unique_simple(ctx: &Ctx<'_, '_>, name: &str) -> Option<NodeKey> {
    let v = ctx.defs_simple.get(name)?;
    if v.len() == 1 {
        Some(v[0].clone())
    } else {
        None
    }
}

fn add_edge(ctx: &mut Ctx<'_, '_>, kind: EdgeKind, source: NodeKey, target: NodeKey, span: Option<Span>) {
    let key = EdgeKey { kind, source: source.clone(), target: target.clone(), ordinal: 0 };
    ctx.graph.edges.insert(key, EdgeSpec { kind, span, weight: 1 });
}

pub(crate) fn txt<'a>(n: &Node, src: &'a [u8]) -> &'a str {
    n.utf8_text(src).unwrap_or("")
}

pub(crate) fn span_of(file: &Path, n: Node) -> Span {
    Span {
        file: file.into(),
        start_byte: n.start_byte() as u32,
        end_byte: n.end_byte() as u32,
        start: Point { row: n.start_position().row as u32, col: n.start_position().column as u32 },
        end: Point { row: n.end_position().row as u32, col: n.end_position().column as u32 },
    }
}

pub(crate) fn dummy_span() -> Span {
    Span {
        file: PathBuf::new(),
        start_byte: 0,
        end_byte: 0,
        start: Point { row: 0, col: 0 },
        end: Point { row: 0, col: 0 },
    }
}

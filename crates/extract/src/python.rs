//! The Python language profile.
//!
//! Sibling of [`crate::rust`]: the mapping from `tree-sitter-python` kinds onto
//! the shared walker's vocabulary ([`LangProfile`]) plus the handful of helpers
//! only Python needs. The walk itself lives in [`crate::walk`] and carries no
//! grammar strings, so this file is the whole extractor for the language.
//!
//! The four-way classifier, as a `kind -> ItemClass` map:
//!
//! | role        | kinds                                                        |
//! |-------------|--------------------------------------------------------------|
//! | `Def`       | `function_definition` → `Function`, `class_definition` → `Class` |
//! | `Import`    | `import_statement`, `import_from_statement`                   |
//! | `Transparent` | everything else — `if`/`for`/`while`/`with`/`try`, expressions, `lambda`, comprehensions, comments, and `ERROR` under recovery |
//!
//! Python specifics this profile owns:
//!
//! - **decorators** — `@deco def f` is a `decorated_definition` wrapping the
//!   definition, and only the inner node carries the `name` field, so the
//!   wrapper is unwrapped ([`python_unwrap_def`]) and the decorator source is
//!   recorded as `extra.decorators`.
//! - **docstrings** — PEP 257: the doc is the first statement of a suite when
//!   that statement is a bare string, for the module, a class or a function
//!   ([`python_docstring`], `owned_doc`). `#` comments are *not* docs.
//! - **members** — a class body's assignments are `Field`s (behind their
//!   `expression_statement`), and a `Class` `Defines` its methods.
//! - **imports** — one record per imported name; a relative import keeps its dot
//!   run as a leading `"."`/`".."` segment, which is what the resolver splits on.
//!
//! Resolution stays syntactic and same-file (see `walk::resolve_callee`):
//!
//! | call            | tag                  |
//! |-----------------|----------------------|
//! | `helper()`      | `same_file`          |
//! | `Shape("x")`    | `same_file` (a class is a def) |
//! | `self.area()`   | `self_method` inside the class |
//! | `obj.method()`  | `method_unresolved`, receiver in `hint` |
//! | `imported_name()` | `imported`, path in `hint` |
//! | `f()()`         | `dynamic`            |
//!
//! Deliberately skipped (no nodes, never wrong ones): comprehensions,
//! `lambda`, `async`/`await` wrappers (walked *through*), and — the same v1 gap
//! Rust has — structures nested inside a function body.

use cg_ir::{ImportRecord, Lang, NodeKind, Visibility};
use tree_sitter::Node;

use crate::profile::{BindingCapture, BodyRole, CalleeShape, DocAction, ItemClass, LangProfile};
use crate::text::{collapse_ws, first_paragraph};
use crate::walk::{dummy_span, txt};

/// The Python language profile.
pub static PYTHON: LangProfile = LangProfile {
    lang: Lang::Python,
    extensions: &["py"],
    grammar: python_grammar,
    root_ast_kind: "module",
    name_field: "name",
    qual_sep: ".",

    classify: python_classify,
    doc_comment: python_doc_comment,
    prev_doc: python_prev_doc,
    signature: python_signature,
    visibility: python_visibility,
    body_of: python_body_of,
    item_kinds: PYTHON_ITEM_KINDS,
    simple_resolvable: PYTHON_SIMPLE_RESOLVABLE,
    method_parents: &[NodeKind::Class],
    member_name: python_member_name,
    owned_doc: Some(python_docstring),
    unwrap_def: Some(python_unwrap_def),

    call_kinds: PYTHON_CALL_KINDS,
    call_target: python_call_target,
    args_field: "arguments",
    callee_shape: python_callee_shape,
    path_root_strip: &[],
    self_receiver: Some("self"),
    binding: python_binding,
    ident_name: python_ident_name,
    imports: python_imports,

    impl_info: None,
    mod_decl_name: None,
    def_extra: Some(python_def_extra),
};

fn python_grammar() -> tree_sitter::Language {
    tree_sitter_python::LANGUAGE.into()
}

// --- kind tables (the only place these strings live) ----------------------

/// Kinds skipped inside a body's call walk: their own calls belong to them.
/// `decorated_definition` is here so a decorator's arguments are not counted as
/// calls of the enclosing body.
static PYTHON_ITEM_KINDS: &[&str] = &[
    "function_definition",
    "class_definition",
    "decorated_definition",
    "import_statement",
    "import_from_statement",
];

/// Definition kinds that take part in same-file simple-name resolution.
/// `Method`/`Field` are excluded, so a bare `helper()` prefers the module-level
/// function over a method of the same name — the rule Rust uses.
static PYTHON_SIMPLE_RESOLVABLE: &[NodeKind] = &[NodeKind::Function, NodeKind::Class];

/// Class bodies: an attribute is an `expression_statement` wrapping an
/// `assignment` (`attr = 1`, `attr: int` and `attr: int = 1` are all one).
static PYTHON_CLASS_MEMBERS: &[(&str, NodeKind)] = &[("expression_statement", NodeKind::Field)];

/// Call-site kinds: Python has exactly one call form.
static PYTHON_CALL_KINDS: &[&str] = &["call"];

// --- classify -------------------------------------------------------------

fn python_classify(kind: &str) -> ItemClass {
    use ItemClass::{Def, Import, Transparent};
    match kind {
        "function_definition" => Def {
            kind: NodeKind::Function,
            body: BodyRole::Calls,
        },
        // A class body holds methods (definitions, so the class `Defines` them)
        // and attributes (emitted as `Field`s).
        "class_definition" => Def {
            kind: NodeKind::Class,
            body: BodyRole::ScopeMembers(PYTHON_CLASS_MEMBERS),
        },
        // Unreachable: `unwrap_def` has already replaced the wrapper with the
        // definition it wraps.
        "decorated_definition" => Transparent,
        "import_statement" | "import_from_statement" => Import,
        _ => Transparent,
    }
}

// --- decorators, docs, signatures, members --------------------------------

/// `@deco` + `def`/`class` parses as one `decorated_definition` whose
/// `definition` field is the decorated definition. The decorators are metadata,
/// so the inner node is what gets classified, named and emitted.
fn python_unwrap_def(n: Node) -> Option<Node> {
    if n.kind() != "decorated_definition" {
        return None;
    }
    n.child_by_field_name("definition")
}

/// The decorator sources above a definition, `@` stripped, in source order.
/// The emitted node is the inner definition, so this reaches the wrapper
/// through its parent.
fn python_def_extra(n: Node, src: &[u8]) -> Vec<(String, serde_json::Value)> {
    let Some(parent) = n.parent() else {
        return Vec::new();
    };
    if parent.kind() != "decorated_definition" {
        return Vec::new();
    }
    let mut cur = parent.walk();
    let decorators: Vec<String> = parent
        .named_children(&mut cur)
        .filter(|c| c.kind() == "decorator")
        .map(|c| txt(&c, src).trim_start_matches('@').trim().to_string())
        .collect();
    if decorators.is_empty() {
        return Vec::new();
    }
    vec![("decorators".into(), serde_json::json!(decorators))]
}

/// Python has no doc comments: `#` annotates code, it does not document the
/// definition below it. Docs are docstrings — see [`python_docstring`].
fn python_doc_comment(_n: Node, _src: &[u8]) -> DocAction {
    DocAction::NotComment
}

/// No sibling carries a doc: class attributes have no docstring form, and the
/// `#` comments above one are not docs by PEP 257.
fn python_prev_doc(_n: Node, _src: &[u8]) -> Option<String> {
    None
}

/// PEP 257: the docstring is the first statement of a suite when that statement
/// is a bare string. A module's suite is the `module` node itself; a class's or
/// function's is its `body`. Any other first statement means there is no doc —
/// which is what keeps a docstring from also becoming a node.
fn python_docstring(n: Node, src: &[u8]) -> Option<String> {
    let suite = n
        .child_by_field_name("body")
        .or_else(|| (n.kind() == "module").then_some(n))?;
    let stmt = suite.named_child(0)?;
    if stmt.kind() != "expression_statement" {
        return None;
    }
    let string = stmt.named_child(0)?;
    if string.kind() != "string" {
        return None;
    }
    // `"""\nSummary.\n"""` is the common shape and `first_paragraph` stops at
    // the first blank line, so drop leading blank lines before asking.
    let lines: Vec<String> = docstring_body(string, src)
        .lines()
        .skip_while(|l| l.trim().is_empty())
        .map(str::to_string)
        .collect();
    first_paragraph(&lines)
}

/// `r"""Text"""` → `Text`: drop an optional string prefix and the quotes that
/// delimit the body.
fn docstring_body(string: Node, src: &[u8]) -> String {
    let raw = txt(&string, src).trim_start_matches(|c: char| c.is_ascii_alphabetic());
    for quote in ["\"\"\"", "'''", "\"", "'"] {
        if let Some(body) = raw.strip_prefix(quote).and_then(|b| b.strip_suffix(quote)) {
            return body.to_string();
        }
    }
    raw.to_string()
}

/// `async def fetch(self):` / `class Shape(Base):` — the header up to the body,
/// so a decorator (outside the unwrapped node) never appears in it and the body
/// never does. Class attributes sign in full (`attr: int = 1`).
fn python_signature(n: Node, src: &[u8]) -> Option<String> {
    let start = n.start_byte();
    let end = n
        .child_by_field_name("body")
        .map(|b| b.start_byte())
        .unwrap_or(n.end_byte());
    if start >= end || end > src.len() {
        return None;
    }
    let raw = std::str::from_utf8(&src[start..end]).ok()?.trim();
    // The colon that opens the suite is not part of the header a reader wants.
    let raw = raw.strip_suffix(':').unwrap_or(raw).trim_end();
    if raw.is_empty() {
        None
    } else {
        Some(collapse_ws(raw))
    }
}

/// Python's naming convention, not a keyword: `__x` (but not a dunder) is
/// private, `_x` is module-local (D2), everything else is public. A method's
/// `self`-prefix does not matter, so the name is read from the definition or
/// from the member assignment behind it.
fn python_visibility(n: Node, src: &[u8]) -> Visibility {
    match python_member_name(n, src) {
        Some(name) => visibility_from_name(&name),
        None => Visibility::Private,
    }
}

/// `__x` → `private`, `_x` → `module`, `x`/`__x__` → `public`.
fn visibility_from_name(name: &str) -> Visibility {
    // A dunder (`__init__`) is the public protocol, not an internal name, so it
    // must be tested before the single underscore.
    let dunder = name.len() > 4 && name.starts_with("__") && name.ends_with("__");
    if dunder {
        Visibility::Public
    } else if name.starts_with("__") {
        Visibility::Private
    } else if name.starts_with('_') {
        Visibility::Module
    } else {
        Visibility::Public
    }
}

/// A definition's suite: Python has no separate value expression, so a `def`
/// and a `class` both keep their statements in `body`.
fn python_body_of(n: Node) -> Option<Node> {
    n.child_by_field_name("body")
}

/// The name a definition or a class-body statement binds. A definition reads
/// its `name` field; an attribute statement is an `assignment` (`attr = 1`,
/// `attr: int`, `attr: int = 1`) whose `left` is the name, either directly
/// (`expression_statement` → `assignment`) or as the node itself. Anything with
/// no such target — a docstring, a bare call, a nested class — is not a member.
fn python_member_name(n: Node, src: &[u8]) -> Option<String> {
    if let Some(name) = n.child_by_field_name("name") {
        return Some(txt(&name, src).to_string());
    }
    let assignment = if n.kind() == "assignment" {
        n
    } else {
        n.named_child(0).filter(|c| c.kind() == "assignment")?
    };
    let left = assignment.child_by_field_name("left")?;
    (left.kind() == "identifier").then(|| txt(&left, src).to_string())
}

// --- call sites, data flow, imports ---------------------------------------

/// Every call names its callee in the `function` field.
fn python_call_target(call: Node) -> Option<Node> {
    call.child_by_field_name("function")
}

/// `foo(...)` → `Simple`. `a.b(...)` → `Method` with the receiver, which is how
/// `self.helper()` resolves as `self_method` and how `pkg.mod.fn()` keeps its
/// receiver in `hint` (tag `method_unresolved` — Python has no `::`-style path
/// call, so a dotted callee is always a member access). Anything computed —
/// `f()()`, `(lambda: 1)()` — → `Dynamic`.
fn python_callee_shape(func: Node, src: &[u8]) -> CalleeShape {
    match func.kind() {
        "identifier" => CalleeShape::Simple,
        "attribute" => {
            let (Some(object), Some(attribute)) = (
                func.child_by_field_name("object"),
                func.child_by_field_name("attribute"),
            ) else {
                return CalleeShape::Dynamic;
            };
            CalleeShape::Method {
                receiver: txt(&object, src).to_string(),
                method: txt(&attribute, src).to_string(),
            }
        }
        _ => CalleeShape::Dynamic,
    }
}

/// Data-flow capture: an `assignment` whose value is a call binds its targets.
/// `s = t = helper()` nests the assignment in `right`, so the chain is followed
/// to the innermost value and every target along it is bound (the inner
/// assignments leave the tracker alone, so one statement binds once). Tuple
/// targets bind each name, as Rust's do. `a += f()` is deliberately not a
/// binding: the augmented form has no plain producer.
fn python_binding(n: Node, src: &[u8]) -> BindingCapture {
    if n.kind() != "assignment" {
        return BindingCapture::NotBinding;
    }
    if n.parent().is_some_and(|p| p.kind() == "assignment") {
        return BindingCapture::Leave;
    }
    let mut names = Vec::new();
    let mut current = n;
    loop {
        let Some(left) = current.child_by_field_name("left") else {
            return BindingCapture::Leave;
        };
        names.extend(python_bound_names(left, src));
        match current.child_by_field_name("right") {
            Some(right) if right.kind() == "assignment" => current = right,
            Some(right) => {
                let produces = PYTHON_CALL_KINDS.contains(&right.kind()) && !names.is_empty();
                return if produces {
                    BindingCapture::Bind(names)
                } else {
                    BindingCapture::Reset
                };
            }
            None => return BindingCapture::Leave,
        }
    }
}

/// The names an assignment target binds: one `identifier` (or the text of an
/// `attribute`, as Rust does for `self.field`), or the leaves of a
/// `p, *rest = ...` / `[a, b] = ...` pattern.
fn python_bound_names(target: Node, src: &[u8]) -> Vec<String> {
    match target.kind() {
        "identifier" | "attribute" => vec![txt(&target, src).to_string()],
        "list_splat_pattern" | "dictionary_splat_pattern" => target
            .named_child(0)
            .map(|inner| python_bound_names(inner, src))
            .unwrap_or_default(),
        "pattern_list" | "tuple_pattern" | "list_pattern" => {
            let mut cur = target.walk();
            target
                .named_children(&mut cur)
                .flat_map(|c| python_bound_names(c, src))
                .collect()
        }
        _ => Vec::new(),
    }
}

/// The variable an argument references, for argument-level data flow: a bare
/// identifier, the object of `x.field`, the value of a keyword argument
/// (`consume(x, self=1)` passes `1`, not `self`), or the element of a splat.
fn python_ident_name(n: Node, src: &[u8]) -> Option<String> {
    match n.kind() {
        "identifier" => Some(txt(&n, src).to_string()),
        "attribute" => n
            .child_by_field_name("object")
            .and_then(|o| python_ident_name(o, src)),
        "keyword_argument" => n
            .child_by_field_name("value")
            .and_then(|v| python_ident_name(v, src)),
        "list_splat" | "dictionary_splat" | "list_splat_pattern" | "dictionary_splat_pattern" => {
            n.named_child(0).and_then(|c| python_ident_name(c, src))
        }
        _ => None,
    }
}

/// `import os.path as osp, sys` / `from collections import OrderedDict as OD`
/// / `from ..pkg import (a, b as c)` / `from . import sibling` /
/// `from pkg.mod import *` → resolver records. One record per imported name:
/// the path is what that name is imported from, and a relative import keeps its
/// dot run as its own `"."`/`".."` leading segment.
fn python_imports(n: Node, out: &mut Vec<ImportRecord>, src: &[u8]) {
    match n.kind() {
        "import_statement" => {
            let mut cur = n.walk();
            for name in n.children_by_field_name("name", &mut cur) {
                push_import(name, Vec::new(), out, src);
            }
        }
        "import_from_statement" => {
            let base = n
                .child_by_field_name("module_name")
                .map(|m| import_path(m, src))
                .unwrap_or_default();
            if child_of_kind(n, "wildcard_import").is_some() {
                out.push(import_record(base, None, true));
                return;
            }
            let mut cur = n.walk();
            for name in n.children_by_field_name("name", &mut cur) {
                push_import(name, base.clone(), out, src);
            }
        }
        _ => {}
    }
}

/// One imported name appended to `prefix` (a `from ... import` base):
/// `dotted_name` (`os.path`) or `aliased_import` (`os.path as osp`).
fn push_import(name: Node, prefix: Vec<String>, out: &mut Vec<ImportRecord>, src: &[u8]) {
    let mut path = prefix;
    match name.kind() {
        "aliased_import" => {
            if let Some(inner) = name.child_by_field_name("name") {
                path.extend(import_path(inner, src));
            }
            let alias = name
                .child_by_field_name("alias")
                .map(|a| txt(&a, src).to_string());
            out.push(import_record(path, alias, false));
        }
        _ => {
            path.extend(import_path(name, src));
            out.push(import_record(path, None, false));
        }
    }
}

fn import_record(path: Vec<String>, alias: Option<String>, glob: bool) -> ImportRecord {
    ImportRecord {
        path,
        alias,
        glob,
        span: dummy_span(), // the walker overwrites it with the statement's span
    }
}

/// The segments a name is imported from: a `dotted_name` splits on `.`, and a
/// `relative_import` keeps its dot run as a leading segment
/// (`..pkg` → `["..", "pkg"]`, `from . import x` → `["."]`).
fn import_path(n: Node, src: &[u8]) -> Vec<String> {
    if n.kind() != "relative_import" {
        return dotted_segments(n, src);
    }
    let mut path = Vec::new();
    if let Some(dots) = child_of_kind(n, "import_prefix") {
        path.push(txt(&dots, src).to_string());
    }
    if let Some(rest) = child_of_kind(n, "dotted_name") {
        path.extend(dotted_segments(rest, src));
    }
    path
}

/// `a.b.c` → `["a", "b", "c"]`; a lone `identifier` → `["a"]`.
fn dotted_segments(n: Node, src: &[u8]) -> Vec<String> {
    txt(&n, src).split('.').map(str::to_string).collect()
}

/// The first direct named child of the given kind, if any.
fn child_of_kind<'a>(n: Node<'a>, kind: &str) -> Option<Node<'a>> {
    let mut cur = n.walk();
    let found = n.named_children(&mut cur).find(|c| c.kind() == kind);
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::ProfileExtractor;
    use crate::{diff, Extractor, FileGraph, KeyOp, SourceFile};
    use cg_ir::{EdgeKey, EdgeKind, GraphNode, NodeKey, NodeSpec};
    use std::collections::{BTreeMap, BTreeSet};
    use std::path::PathBuf;

    /// One file exercising every construct the profile claims to handle:
    /// module/class docstrings, a decorated method, class attributes (public and
    /// underscore-private), a dunder, all four import shapes, and calls that are
    /// simple / self-method / unresolved-method / imported.
    const FIXTURE: &str = r#"
"""Module summary.

More detail.
"""
import os.path
from collections import OrderedDict as OD
from . import sibling
from ..pkg import helper as h2

CONFIG = 3


class Shape:
    """A 2-D shape."""

    sides = 3
    _hidden: int = 0

    def __init__(self, name: str) -> None:
        self.name = name

    def area(self) -> int:
        return self._compute() + local_fn()

    @property
    def label(self) -> str:
        return self.name

    def _compute(self) -> int:
        return 1


def local_fn() -> int:
    return 2


def __secret() -> None:
    pass


def top() -> None:
    shape = Shape("sq")
    shape.area()
    local_fn()
    h2()
    os.path.join("a", "b")
    sibling()
"#;

    fn extract(src: &str) -> FileGraph {
        extract_as("src/fixture.py", src)
    }

    fn extract_as(path: &str, src: &str) -> FileGraph {
        let file = SourceFile {
            path: PathBuf::from(path),
            lang: Lang::Python,
            text: src.to_string(),
        };
        ProfileExtractor(&PYTHON).extract(&file).expect("extract")
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

    /// `(ancestor, ordinal)` for an anchored key, if it is one.
    fn anchored_parts(k: &NodeKey) -> Option<(&NodeKey, u32)> {
        match k {
            NodeKey::Anchored {
                ancestor, ordinal, ..
            } => Some((ancestor, *ordinal)),
            _ => None,
        }
    }

    fn file_node(g: &FileGraph) -> &NodeSpec {
        g.nodes
            .values()
            .find(|n| n.kind == NodeKind::File)
            .expect("file node")
    }

    fn sites(g: &FileGraph) -> Vec<&NodeSpec> {
        g.nodes
            .values()
            .filter(|n| n.kind == NodeKind::CallSite)
            .collect()
    }

    /// The call site that recorded a `callee`/`resolution` pair.
    fn site<'a>(g: &'a FileGraph, callee: &str, tag: &str) -> Option<&'a NodeSpec> {
        sites(g).into_iter().find(|s| {
            s.attrs.extra.get("callee").and_then(|v| v.as_str()) == Some(callee)
                && s.attrs.extra.get("resolution").and_then(|v| v.as_str()) == Some(tag)
        })
    }

    #[test]
    fn extracts_python_structure() {
        let g = extract(FIXTURE);
        assert_eq!(
            g.nodes.len(),
            19,
            "node census changed: {:#?}",
            g.nodes.keys().collect::<Vec<_>>()
        );
        assert_eq!(
            g.edges.len(),
            26,
            "edge census changed: {:#?}",
            g.edges.keys().collect::<Vec<_>>()
        );

        // The file node's ast_kind is the grammar's root kind, and the module
        // docstring lands on it.
        assert_eq!(file_node(&g).ast_kind, "module");
        assert_eq!(file_node(&g).attrs.doc.as_deref(), Some("Module summary."));

        // Docstrings: owned by the class too, and never a node of their own.
        assert_eq!(node(&g, "Shape").attrs.doc.as_deref(), Some("A 2-D shape."));
        assert!(
            !g.nodes.values().any(|n| n.label.contains("2-D shape")),
            "a docstring must not be emitted as a node"
        );

        // Signatures are the header, without decorators and without the colon.
        assert_eq!(
            node(&g, "Shape.__init__").attrs.signature.as_deref(),
            Some("def __init__(self, name: str) -> None")
        );
        assert_eq!(
            node(&g, "Shape.label").attrs.signature.as_deref(),
            Some("def label(self) -> str")
        );
        // Decorators are metadata on the definition they decorate.
        assert_eq!(
            node(&g, "Shape.label").attrs.extra.get("decorators"),
            Some(&serde_json::json!(["property"]))
        );

        // Visibility is name-based (D2); `__init__` is a plain public Method.
        assert_eq!(node(&g, "Shape.__init__").kind, NodeKind::Method);
        assert_eq!(
            node(&g, "Shape.__init__").attrs.visibility,
            Visibility::Public
        );
        assert_eq!(
            node(&g, "Shape._compute").attrs.visibility,
            Visibility::Module
        );
        assert_eq!(
            node(&g, "Shape._hidden").attrs.visibility,
            Visibility::Module
        );
        assert_eq!(node(&g, "Shape.sides").attrs.visibility, Visibility::Public);
        assert_eq!(node(&g, "__secret").attrs.visibility, Visibility::Private);

        // Nested names are qualified with the class, `qual_sep`-joined.
        for q in [
            "Shape.sides",
            "Shape._hidden",
            "Shape.__init__",
            "Shape.area",
            "Shape.label",
            "Shape._compute",
            "local_fn",
            "top",
        ] {
            def_key(&g, q);
        }

        // Imports: one record per imported name, relative dots kept as segments.
        assert_eq!(g.imports.len(), 4, "{:?}", g.imports);
        assert!(g
            .imports
            .iter()
            .any(|r| r.path == ["os", "path"] && r.alias.is_none()));
        assert!(g
            .imports
            .iter()
            .any(|r| r.path == ["collections", "OrderedDict"] && r.alias.as_deref() == Some("OD")));
        assert!(g
            .imports
            .iter()
            .any(|r| r.path == [".", "sibling"] && r.alias.is_none()));
        assert!(g
            .imports
            .iter()
            .any(|r| r.path == ["..", "pkg", "helper"] && r.alias.as_deref() == Some("h2")));

        // Namespace edges: the class Defines its methods, and only them.
        let shape = def_key(&g, "Shape");
        for m in [
            "Shape.__init__",
            "Shape.area",
            "Shape.label",
            "Shape._compute",
        ] {
            let member = def_key(&g, m);
            assert!(
                g.edges.keys().any(|k| k.kind == EdgeKind::Defines
                    && k.source == shape
                    && k.target == member),
                "Shape should Define {m}"
            );
        }
        for f in ["Shape.sides", "Shape._hidden"] {
            let field = def_key(&g, f);
            assert!(
                !g.edges
                    .keys()
                    .any(|k| k.kind == EdgeKind::Defines && k.target == field),
                "attributes are Contains-only, like Rust's struct fields"
            );
            assert!(
                g.edges.keys().any(|k| k.kind == EdgeKind::Contains
                    && k.source == shape
                    && k.target == field),
                "Shape should Contain {f}"
            );
        }
    }

    #[test]
    fn resolves_same_file_calls_and_records_the_rest() {
        let g = extract(FIXTURE);
        let calls: Vec<_> = g
            .edges
            .iter()
            .filter(|(k, _)| k.kind == EdgeKind::Calls)
            .collect();
        assert_eq!(calls.len(), 4, "{calls:#?}");

        // self.method() inside the class body resolves without types.
        let area = def_key(&g, "Shape.area");
        let compute = def_key(&g, "Shape._compute");
        let self_site = NodeKey::Anchored {
            ancestor: Box::new(area.clone()),
            ast_kind: "call".into(),
            ordinal: 0,
        };
        assert!(calls
            .iter()
            .any(|(k, _)| k.source == self_site && k.target == compute));
        assert_eq!(
            site(&g, "_compute", "self_method").unwrap().label,
            "_compute"
        );

        // A later definition resolves: `local_fn()` is called before it is read.
        let local = def_key(&g, "local_fn");
        let later_site = NodeKey::Anchored {
            ancestor: Box::new(area),
            ast_kind: "call".into(),
            ordinal: 1,
        };
        assert!(calls
            .iter()
            .any(|(k, _)| k.source == later_site && k.target == local));

        // A class is a definition: `Shape("sq")` is a same-file call.
        let shape = def_key(&g, "Shape");
        assert!(calls.iter().any(|(k, _)| k.target == shape));

        // Unresolved, but recorded with the receiver as a hint for cg-resolve.
        assert_eq!(
            site(&g, "area", "method_unresolved").unwrap().attrs.extra["hint"],
            "shape"
        );
        assert_eq!(
            site(&g, "join", "method_unresolved").unwrap().attrs.extra["hint"],
            "os.path"
        );
        // Imported names carry the import path instead. The path is the record's
        // segments joined with `qual_sep`, so a relative import's dot run reads
        // as a doubled dot (`from . import x` → `..x`) — the segments in
        // `g.imports` above are what the resolver consumes.
        assert_eq!(
            site(&g, "h2", "imported").unwrap().attrs.extra["hint"],
            "...pkg.helper"
        );
        assert_eq!(
            site(&g, "sibling", "imported").unwrap().attrs.extra["hint"],
            "..sibling"
        );
        // One site per call, decorators included (they are metadata, not calls).
        assert_eq!(sites(&g).len(), 8);
    }

    #[test]
    fn classifies_computed_callees_as_dynamic() {
        // A computed callee has no nameable target: recorded, never resolved.
        let g = extract("def outer() -> None:\n    (lambda: 1)()\n");
        let callee = sites(&g)
            .into_iter()
            .find(|s| s.attrs.extra.get("resolution").and_then(|v| v.as_str()) == Some("dynamic"))
            .expect("a computed callee is dynamic");
        assert!(callee.attrs.extra.contains_key("callee"));

        let outer = def_key(&g, "outer");
        let site_key = NodeKey::Anchored {
            ancestor: Box::new(outer),
            ast_kind: "call".into(),
            ordinal: 0,
        };
        assert!(!g
            .edges
            .keys()
            .any(|k| k.kind == EdgeKind::Calls && k.source == site_key));
    }

    #[test]
    fn flattens_every_import_shape() {
        let src = r#"
import a.b as ab, c
from pkg import (a,
                 b as c)
from mod import *
from . import sibling
from ..pkg import helper as h2


def use() -> None:
    a()
    h2()
"#;
        let g = extract(src);
        let shape = |path: &[&str]| {
            g.imports
                .iter()
                .find(|r| r.path == path)
                .unwrap_or_else(|| panic!("missing import {path:?} in {:?}", g.imports))
        };

        // `import a.b as ab` binds the alias; `import c` binds its leaf name.
        assert_eq!(shape(&["a", "b"]).alias.as_deref(), Some("ab"));
        assert!(!shape(&["a", "b"]).glob);
        assert_eq!(shape(&["c"]).alias, None);
        // A parenthesised `from ... import (...)` flattens per name.
        assert_eq!(g.imports.iter().filter(|r| r.path[0] == "pkg").count(), 2);
        assert_eq!(shape(&["pkg", "b"]).alias.as_deref(), Some("c"));
        // A wildcard is recorded as a glob and contributes no simple-name hint.
        let glob = shape(&["mod"]);
        assert!(glob.glob && glob.alias.is_none());
        // Relative imports keep their dot run as a leading segment.
        assert_eq!(shape(&[".", "sibling"]).path, [".", "sibling"]);
        assert_eq!(shape(&["..", "pkg", "helper"]).alias.as_deref(), Some("h2"));

        // Hints: the bare `a` imported from `pkg` resolves to `pkg.a`; the glob
        // leaves `a` unresolved rather than guessing.
        assert_eq!(
            site(&g, "a", "imported").unwrap().attrs.extra["hint"],
            "pkg.a"
        );
        assert_eq!(
            site(&g, "h2", "imported").unwrap().attrs.extra["hint"],
            "...pkg.helper"
        );
    }

    #[test]
    fn tracks_data_flow_across_bindings() {
        let src = r#"
def flow() -> None:
    x = make(1)
    use(x)
    y, z = make(2)
    use(y, z)
    a = b = make(3)
    use(a, b)
    c = 5
    use(c)
"#;
        let g = extract(src);

        // The producer's ordinal is the *call* the target was bound to, and the
        // trace shows producer calls carrying no `flows_from` and consumers
        // carrying one: 0=make(1) 1=use(x) 2=make(2) 3=use(y,z) 4=make(3)
        // 5=use(a,b) 6=use(c).
        let flow = def_key(&g, "flow");
        let mut trace: Vec<(u32, Option<String>)> = g
            .nodes
            .iter()
            .filter_map(|(k, n)| {
                let (ancestor, ordinal) = anchored_parts(k)?;
                (ancestor == &flow && n.kind == NodeKind::CallSite).then(|| {
                    (
                        ordinal,
                        n.attrs
                            .extra
                            .get("flows_from")
                            .and_then(|v| v.as_str())
                            .map(str::to_string),
                    )
                })
            })
            .collect();
        trace.sort_by_key(|(o, _)| *o);

        let flows: Vec<Option<&str>> = trace.iter().map(|(_, f)| f.as_deref()).collect();
        assert_eq!(
            flows,
            vec![
                None,
                Some("0->0"),
                None,
                Some("0->2,1->2"),
                None,
                Some("0->4,1->4"),
                None
            ],
            "{trace:#?}"
        );
    }

    #[test]
    fn keys_are_stable_under_body_edits() {
        let before = extract(FIXTURE);
        let edited = FIXTURE.replace(
            "def local_fn() -> int:\n    return 2",
            "def local_fn() -> int:\n    # noop\n    return 2",
        );
        let after = extract(&edited);
        let ops = diff(&before, &after);

        // Identity survives; only specs (spans) change.
        assert!(!ops.is_empty());
        assert!(
            ops.iter()
                .all(|op| !matches!(op, KeyOp::RemoveNode { .. } | KeyOp::RemoveEdge { .. })),
            "no identity churn expected: {ops:#?}"
        );

        let callsites = |g: &FileGraph| {
            g.nodes
                .iter()
                .filter(|(_, n)| n.kind == NodeKind::CallSite)
                .map(|(k, _)| k.clone())
                .collect::<std::collections::BTreeSet<_>>()
        };
        assert_eq!(
            callsites(&before),
            callsites(&after),
            "anchored keys renumbered"
        );
    }

    /// Indentation grammars swallow broken code into `ERROR` nodes; the walker
    /// stays transparent on them, so a syntax error costs the broken item and
    /// nothing else.
    #[test]
    fn error_recovery_stays_transparent() {
        let src = "def broken(:\n    pass\n\n\ndef still_ok() -> int:\n    return 1\n";
        let g = extract(src);

        // The good definition after the garbage still lands, signature and all.
        let good = node(&g, "still_ok");
        assert_eq!(good.kind, NodeKind::Function);
        assert_eq!(
            good.attrs.signature.as_deref(),
            Some("def still_ok() -> int")
        );

        // `pass` and `return 1` are expressions, not calls, and no node is named
        // after raw source: recovery never fabricates a definition from garbage.
        assert!(sites(&g).is_empty(), "{:#?}", sites(&g).len());
        for n in g.nodes.values() {
            assert!(
                !n.label.contains('(') && !n.label.contains(' '),
                "recovery leaked source text as a node label: {:?}",
                n.label
            );
        }
    }

    /// The registry is per extension, so one repo's `.py` and `.rs` files each
    /// get their own grammar, and a mismatched pair fails loudly instead of
    /// producing confident nonsense.
    #[test]
    fn python_and_rust_profiles_do_not_interchange() {
        assert_eq!(
            crate::for_extension("py").map(|p| p.lang),
            Some(Lang::Python)
        );
        assert_eq!(crate::for_extension("rs").map(|p| p.lang), Some(Lang::Rust));

        let py = SourceFile {
            path: PathBuf::from("a.py"),
            lang: Lang::Python,
            text: "def f():\n    pass\n".into(),
        };
        let wrong = ProfileExtractor(&crate::rust::RUST).extract(&py);
        assert!(matches!(wrong, Err(crate::ExtractError::LangMismatch)));

        let rs = SourceFile {
            path: PathBuf::from("a.rs"),
            lang: Lang::Rust,
            text: "fn f() {}\n".into(),
        };
        let wrong = ProfileExtractor(&PYTHON).extract(&rs);
        assert!(matches!(wrong, Err(crate::ExtractError::LangMismatch)));
    }

    // ─── the fixture tree: one directory, two languages, one snapshot ────────

    /// `tests/fixtures/`: the tree
    /// `codegraph.exe enrich crates\extract\tests\fixtures` renders. It holds
    /// a Python-only directory (`python/`) and a Rust one (`rust/`), so the
    /// parent is the mixed case and each child is the single-language case.
    fn fixture_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
    }

    /// Every fixture file paired with the profile its extension selects — the
    /// same extension dispatch the CLI's walker uses. Sorted, so a failure
    /// reports the same file every run.
    fn fixture_manifest() -> Vec<(PathBuf, &'static LangProfile)> {
        fn walk(dir: &std::path::Path, out: &mut Vec<PathBuf>) {
            let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
                .unwrap_or_else(|e| panic!("read_dir {}: {e}", dir.display()))
                .map(|e| e.expect("dir entry").path())
                .collect();
            entries.sort();
            for path in entries {
                if path.is_dir() {
                    walk(&path, out);
                } else {
                    out.push(path);
                }
            }
        }
        let mut files = Vec::new();
        walk(&fixture_root(), &mut files);
        files
            .into_iter()
            .filter_map(|path| {
                let ext = path.extension()?.to_str()?;
                let profile = crate::for_extension(ext)?;
                Some((path, profile))
            })
            .collect()
    }

    /// Keys no path down the hierarchy reaches from the file node. The UI
    /// (`details.js`) nests on `contains`/`defines`, so a node that no such
    /// path reaches is a node the renderer would drop — the walk must never
    /// produce one.
    fn orphans(g: &FileGraph) -> Vec<String> {
        let hierarchy = |k: &EdgeKey| matches!(k.kind, EdgeKind::Contains | EdgeKind::Defines);
        // The roots are the file nodes: everything a file contributes hangs
        // off one of them.
        let mut reached: BTreeSet<&NodeKey> = g
            .nodes
            .iter()
            .filter(|(_, n)| n.kind == NodeKind::File)
            .map(|(k, _)| k)
            .collect();
        let mut frontier: Vec<&NodeKey> = reached.iter().copied().collect();
        assert_eq!(
            frontier.len(),
            1,
            "one file node per file: {}",
            g.file.display()
        );
        while let Some(k) = frontier.pop() {
            for key in g
                .edges
                .keys()
                .filter(|key| hierarchy(key) && &key.source == k)
            {
                if reached.insert(&key.target) {
                    frontier.push(&key.target);
                }
            }
        }
        g.nodes
            .keys()
            .filter(|k| !reached.contains(k))
            .map(|k| match k {
                NodeKey::Symbol { qualified_name, .. } => qualified_name.clone(),
                other => format!("{other:?}"),
            })
            .collect()
    }

    /// A `Calls` edge whose target is a definition in this same file: the
    /// intra-file resolution both profiles promise.
    fn same_file_call(g: &FileGraph) -> bool {
        g.edges.keys().any(|k| {
            k.kind == EdgeKind::Calls && g.nodes.get(&k.target).is_some_and(|n| n.is_definition)
        })
    }

    /// Phase 3 ships one snapshot per *directory*, not per language. A tree
    /// holding both `.py` and `.rs` routes each file to its own grammar and
    /// then flattens into one graph in which
    ///
    /// 1. every node's `key.lang` is the language of the file it came from;
    /// 2. no key is shared across languages — `Shape.describe` and
    ///    `Widget::label` each keep their own language's separator;
    /// 3. each file's hierarchy is connected: no orphan symbols;
    /// 4. a same-file call resolves inside its own file, in both languages;
    /// 5. the Rust half is untouched by the presence of Python — the mixed
    ///    snapshot's Rust nodes and edges are exactly the Rust-only ones.
    ///
    /// The fixtures are real files under `tests/fixtures/`, so this is a
    /// dogfood: it also fails if a fixture stops parsing.
    #[test]
    fn one_directory_two_languages_flattens_without_collisions() {
        let manifest = fixture_manifest();
        let langs: Vec<Lang> = manifest.iter().map(|(_, p)| p.lang).collect();
        assert!(
            langs.contains(&Lang::Python),
            "no Python fixture: {langs:?}"
        );
        assert!(langs.contains(&Lang::Rust), "no Rust fixture: {langs:?}");

        let root = fixture_root();
        let mut graphs = Vec::new();
        let mut expected: BTreeMap<PathBuf, Lang> = BTreeMap::new();
        for (path, profile) in &manifest {
            let rel = path
                .strip_prefix(&root)
                .expect("fixture under tests/fixtures")
                .to_path_buf();
            let text = std::fs::read_to_string(path)
                .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
            let file = SourceFile {
                path: rel.clone(),
                lang: profile.lang,
                text,
            };
            let graph = ProfileExtractor(profile)
                .extract(&file)
                .expect("extract fixture");
            let defs = graph.nodes.values().filter(|n| n.is_definition).count();
            assert!(defs >= 2, "{} extracted almost nothing", rel.display());
            let orphans = orphans(&graph);
            assert!(
                orphans.is_empty(),
                "{} has orphans: {orphans:?}",
                rel.display()
            );
            assert!(
                same_file_call(&graph),
                "{} resolved no same-file call",
                rel.display()
            );
            expected.insert(rel, profile.lang);
            graphs.push(graph);
        }
        let snapshot = crate::flatten(graphs.clone());
        let defs: usize = graphs
            .iter()
            .map(|g| g.nodes.values().filter(|n| n.is_definition).count())
            .sum();
        assert_eq!(
            snapshot.nodes.len(),
            defs,
            "flatten deduplicated distinct keys"
        );
        assert_eq!(snapshot.file_count, graphs.len());

        let mut seen: BTreeMap<String, Lang> = BTreeMap::new();
        for node in &snapshot.nodes {
            let NodeKey::Symbol {
                lang,
                file,
                qualified_name,
                ..
            } = &node.key
            else {
                panic!("call sites must not survive flatten: {:?}", node.key);
            };
            assert_eq!(
                Some(lang),
                expected.get(file),
                "{qualified_name} ({})",
                file.display()
            );
            match lang {
                Lang::Python => assert!(!qualified_name.contains("::"), "{qualified_name}"),
                Lang::Rust => assert!(!qualified_name.contains('.'), "{qualified_name}"),
                other => panic!("fixture tree grew a {other:?} file"),
            }
            if let Some(previous) = seen.insert(qualified_name.clone(), *lang) {
                assert_eq!(
                    previous, *lang,
                    "key {qualified_name} is shared across languages"
                );
            }
        }

        // (5) Rust alone vs. Rust inside the batch: same nodes, same edges.
        let rust_graphs: Vec<FileGraph> = graphs
            .iter()
            .filter(|g| g.lang == Lang::Rust)
            .cloned()
            .collect();
        let rust_only = crate::flatten(rust_graphs);
        let mixed: Vec<&GraphNode> = snapshot
            .nodes
            .iter()
            .filter(|n| {
                matches!(
                    &n.key,
                    NodeKey::Symbol {
                        lang: Lang::Rust,
                        ..
                    }
                )
            })
            .collect();
        assert_eq!(mixed.len(), rust_only.nodes.len());
        for node in &rust_only.nodes {
            let same = mixed.iter().find(|n| n.key == node.key).unwrap_or_else(|| {
                panic!("Rust node missing from the mixed snapshot: {:?}", node.key)
            });
            assert_eq!(*same, node, "Python perturbed a Rust node");
        }
        for edge in &rust_only.edges {
            assert!(
                snapshot.edges.contains(edge),
                "Rust edge vanished from the mixed snapshot: {edge:?}"
            );
        }
    }
}

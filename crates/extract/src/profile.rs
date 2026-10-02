//! Language profiles: the seam that makes extraction language-parameterised.
//!
//! The walker in [`crate::walk`] holds **no grammar kind strings**. Every
//! decision that depends on a tree-sitter grammar is a function pointer (or a
//! small table) on [`LangProfile`]; the walker only sequences them. Adding a
//! language is therefore:
//!
//!   1. a `static <LANG>: LangProfile` mapping that grammar's kinds to IR
//!      kinds (see `rust.rs` for the worked example),
//!   2. the handful of language-only helper fns it names,
//!   3. one entry in [`PROFILES`].
//!
//! No shared module changes. See docs/NEXT-SESSION.md for the procedure that
//! grows this list (Python, then JavaScript/TypeScript).
//!
//! Types here are deliberately plain data + free functions: a profile is a
//! `static`, so it can hold only function pointers and `&'static` tables.

use cg_ir::{ImportRecord, Lang, NodeKind, Visibility};
use tree_sitter::Node;

use crate::{ExtractError, Extractor, FileGraph, SourceFile};

/// What a grammar's node kind means to the shared walker.
///
/// The four-way classifier from the IR design, made language-independent:
/// every kind that maps to `Transparent` produces no node — never a wrong one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ItemClass {
    /// A named definition: emit a node + a `Contains` edge from the parent,
    /// then handle its body per the [`BodyRole`].
    Def { kind: NodeKind, body: BodyRole },
    /// A Rust-style `impl` block: type/trait fields, member recursion and
    /// `Defines` edges. Only produced by profiles that set
    /// [`LangProfile::impl_info`].
    Impl,
    /// A file-level import declaration — no node, feeds `FileGraph.imports`.
    Import,
    /// Anything else: no node, and the body is not descended into.
    Transparent,
}

/// What the walker does with a definition's body once the definition node
/// exists.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BodyRole {
    /// No body handling (type aliases, macros).
    None,
    /// Recurse into the body with the item's name pushed onto the scope
    /// (modules, traits, classes).
    Scope,
    /// Recurse with the name in scope, linking the body's direct children
    /// whose kind appears in the table as members (struct fields, enum
    /// variants).
    Members(&'static [(&'static str, NodeKind)]),
    /// Queue the body for call-site extraction (functions, consts, statics).
    Calls,
}

/// What a child node is, from the perspective of leading-doc accumulation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DocAction {
    /// Not a comment/attribute — classify the node normally.
    NotComment,
    /// Consume the node; append `text` to the pending doc buffer if present.
    /// `Comment(None)` consumes the node but leaves the buffer alone
    /// (Rust attributes, block comments).
    Comment(Option<String>),
}

/// What a statement does to the data-flow binding tracker.
///
/// The walker keeps a map of `variable → ordinal of the call that produced
/// it`; a call that passes such a variable gets a `flows_from` annotation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BindingCapture {
    /// Not a binding statement.
    NotBinding,
    /// Bind the call's result to these names.
    Bind(Vec<String>),
    /// A binding statement whose right-hand side is not a call: reset.
    Reset,
    /// Binding-shaped, but nothing to record — leave the tracker as-is
    /// (malformed `let`/assignment under error recovery).
    Leave,
}

/// The shape of a call's callee expression, for syntactic resolution.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CalleeShape {
    /// A bare name (`foo`, `Thing`) — resolve same-file/imported simple name.
    Simple,
    /// A qualified path (`Thing::new`, `a.b.c`) — resolve qualified name.
    Path,
    /// A method on a receiver (`self.helper()`, `obj.run()`).
    Method { receiver: String, method: String },
    /// Anything else (closures, forms with no nameable callee): `dynamic`.
    Dynamic,
}

/// The language-specific parts of an `impl` block, extracted by
/// [`LangProfile::impl_info`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImplInfo {
    /// Node label: `Trait for Type` or `impl Type`.
    pub label: String,
    /// The implementing type — pushed onto the member scope and the target of
    /// `Defines` edges.
    pub type_name: String,
    /// The trait being implemented, if any (`impl_trait` attribute).
    pub trait_name: Option<String>,
}

/// Everything the shared walker needs to know about one grammar.
///
/// Fields are grouped roughly in the order the walker consults them:
/// identity → definition machinery → call/dependency machinery → optional
/// per-language extras.
pub struct LangProfile {
    // ── identity ──────────────────────────────────────────────────────
    pub lang: Lang,
    /// Extensions without the dot (`&["rs"]`), for CLI file discovery.
    pub extensions: &'static [&'static str],
    /// Pins a grammar version (kind names drift between releases).
    pub grammar: fn() -> tree_sitter::Language,
    /// The root node's kind, recorded as the file node's `ast_kind`.
    pub root_ast_kind: &'static str,
    /// Field name carrying a definition's name (`"name"`).
    pub name_field: &'static str,
    /// Separator joined between scope segments in a qualified name (`"::"`).
    pub qual_sep: &'static str,

    // ── definition machinery ──────────────────────────────────────────
    /// Grammar kind → what the walker should do with it.
    pub classify: fn(&str) -> ItemClass,
    /// Leading-doc accumulation (doc comments, attributes).
    pub doc_comment: fn(Node, &[u8]) -> DocAction,
    /// Doc block *above* a sibling (fields, variants).
    pub prev_doc: fn(Node, &[u8]) -> Option<String>,
    /// Source text of a definition minus leading attributes, up to the body.
    pub signature: fn(Node, &[u8]) -> Option<String>,
    /// Declared visibility of a definition.
    pub visibility: fn(Node, &[u8]) -> Visibility,
    /// The definition's body/value child, if it has one.
    pub body_of: fn(Node) -> Option<Node>,
    /// Kinds skipped when walking a body for calls (nested definitions).
    pub item_kinds: &'static [&'static str],
    /// Definition kinds that take part in same-file simple-name resolution.
    pub simple_resolvable: &'static [NodeKind],
    /// Parent kinds under which a `Function` definition becomes a `Method`.
    pub method_parents: &'static [NodeKind],

    // ── call / dependency machinery ───────────────────────────────────
    /// Grammar kinds that are call sites (`call_expression`, ...).
    pub call_kinds: &'static [&'static str],
    /// The callee expression of a call node (`function` / `macro` field).
    pub call_target: fn(Node) -> Option<Node>,
    /// Field name of a call's argument list (`"arguments"`).
    pub args_field: &'static str,
    /// Classify a callee expression for syntactic resolution.
    pub callee_shape: fn(Node, &[u8]) -> CalleeShape,
    /// Leading path segments that are contextual and stripped during lookup
    /// (Rust: `self` in `self::helper`).
    pub path_root_strip: &'static [&'static str],
    /// The receiver name that means "the enclosing type" (`self`), if any.
    pub self_receiver: Option<&'static str>,
    /// What a statement does to the binding tracker.
    pub binding: fn(Node, &[u8]) -> BindingCapture,
    /// Unwrap `&x`, `*x`, `x.field` to the underlying identifier name.
    pub ident_name: fn(Node, &[u8]) -> Option<String>,
    /// Flatten an import declaration into [`ImportRecord`]s.
    pub imports: fn(Node, &mut Vec<ImportRecord>, &[u8]),

    // ── optional per-language extras ──────────────────────────────────
    /// `impl`-block shape; `None` for languages without one.
    pub impl_info: Option<fn(Node, &[u8]) -> Option<ImplInfo>>,
    /// Name of a body-less external module declaration (`mod foo;`).
    pub mod_decl_name: Option<fn(Node, &[u8]) -> Option<String>>,
}

/// The registry the CLI and tests iterate. Adding a language is one line here.
pub static PROFILES: &[&LangProfile] = &[&crate::rust::RUST];

/// Every known profile, in registration order.
pub fn all() -> &'static [&'static LangProfile] {
    PROFILES
}

/// The profile for a language, if one is registered.
pub fn for_lang(l: Lang) -> Option<&'static LangProfile> {
    all().iter().find(|p| p.lang == l).copied()
}

/// The profile for a bare file extension (`"rs"`, no dot).
pub fn for_extension(ext: &str) -> Option<&'static LangProfile> {
    all().iter().find(|p| p.extensions.contains(&ext)).copied()
}

/// An [`Extractor`] driven entirely by a [`LangProfile`]. The CLI picks one per
/// file from the file's extension; the store/enricher only ever see the trait.
pub struct ProfileExtractor(pub &'static LangProfile);

impl Extractor for ProfileExtractor {
    fn lang(&self) -> Lang {
        self.0.lang
    }

    fn extract(&self, file: &SourceFile) -> Result<FileGraph, ExtractError> {
        crate::walk::extract(self.0, file)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rust::RUST;

    #[test]
    fn registry_resolves_rust_by_lang_and_extension() {
        let by_ext = for_extension("rs").expect("`rs` is registered");
        assert_eq!(by_ext.lang, Lang::Rust);
        let by_lang = for_lang(Lang::Rust).expect("Rust profile is registered");
        assert!(
            std::ptr::eq(by_ext, by_lang),
            "both lookups must return the same profile"
        );
        assert!(all().iter().any(|p| std::ptr::eq(*p, &RUST)));
    }

    #[test]
    fn unregistered_languages_and_extensions_are_absent_not_panics() {
        // Adding Python is a new profile module + one line in `PROFILES`;
        // until then these lookups must return `None`, never panic.
        assert!(for_lang(Lang::Python).is_none());
        assert!(for_extension("py").is_none());
        assert!(for_extension("").is_none());
        // No partial matching: `rss` must not hit the `rs` profile.
        assert!(for_extension("rss").is_none());
    }
}

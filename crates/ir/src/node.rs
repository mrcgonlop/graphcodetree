use crate::{NodeId, Span};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The abstract, cross-language vocabulary the renderer thinks in. A few
/// hundred tree-sitter grammar kinds collapse into this small set; the
/// original grammar kind is preserved in `Node::ast_kind` for round-trip
/// fidelity when compiling edit intents back to concrete syntax.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    File,
    Module,
    Struct,
    /// A class: Python `class`, JS/TS `class`, Java/C++ `class`. Distinct from
    /// `Struct` because a class is a nominal, inheritable container and the
    /// renderer colours by kind (decision D1 in docs/NEXT-SESSION.md).
    Class,
    Enum,
    EnumVariant,
    Trait,
    Interface,
    ImplBlock,
    Function,
    Method,
    Field,
    Constant,
    Static,
    TypeAlias,
    Macro,
    /// Synthetic anonymous node for a call site (uses an `Anchored` key).
    CallSite,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Visibility {
    #[default]
    Private,
    /// Visible to the enclosing package/crate/module.
    Crate,
    /// Python's `_name` convention: private to the module, not the "crate"
    /// (decision D2 in docs/NEXT-SESSION.md).
    Module,
    /// TS/Java/C++ `protected`.
    Protected,
    Public,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct NodeAttrs {
    /// Human/LLM-facing signature, e.g. "fn extract(src: &str) -> GraphDelta".
    /// Carries most of the orienting value per token in text maps.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(default)]
    pub visibility: Visibility,
    /// First doc-comment paragraph; enough for maps and tooltips.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>,
    /// Extension point for semantic-layer enrichers (type info, macro
    /// expansion data, per-language extras). Promote entries to typed
    /// fields once a payload stabilizes across languages.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Node {
    pub id: NodeId,
    pub kind: NodeKind,
    /// Short display label (unqualified name).
    pub label: String,
    /// Original tree-sitter node kind ("function_item", "call_expression").
    pub ast_kind: String,
    /// `None` only for synthetic/inferred nodes (e.g. external crate stubs).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub span: Option<Span>,
    pub is_definition: bool,
    #[serde(default)]
    pub attrs: NodeAttrs,
}
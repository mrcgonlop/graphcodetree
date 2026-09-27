use crate::{EdgeKind, Lang, NodeKind};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Compact runtime identity, interned per store. This is what appears on
/// the wire and inside the client's normalized store.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NodeId(pub u32);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EdgeId(pub u32);

/// Stable identity that survives edits and re-runs. The interner assigns
/// `NodeId`s from `NodeKey`s; the key is what lets re-extraction after an
/// edit recognize "same function, new body" and emit an upsert instead of
/// remove+add.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "key", rename_all = "snake_case")]
pub enum NodeKey {
    /// Named definition. Survives body edits; a rename shows as remove+add
    /// unless the resolver patches it with rename tracking.
    Symbol {
        lang: Lang,
        file: PathBuf,
        /// e.g. "ir::extract::parse_query"
        qualified_name: String,
        kind: NodeKind,
        /// Breaks ties on qualified-name collisions (multiple impl blocks, etc.)
        #[serde(default)]
        disambiguator: u32,
    },
    /// Anonymous construct (call site, expression): anchored to the nearest
    /// stable ancestor + ordinal, so edits elsewhere in the file don't
    /// renumber the world.
    Anchored {
        ancestor: Box<NodeKey>,
        /// Original tree-sitter kind, e.g. "call_expression".
        ast_kind: String,
        ordinal: u32,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct EdgeKey {
    pub kind: EdgeKind,
    pub source: NodeKey,
    pub target: NodeKey,
    /// Multiple edges of the same kind between the same pair
    /// (e.g. two call sites to one callee).
    pub ordinal: u32,
    //#[serde(default)]
    //pub nth: usize,
}
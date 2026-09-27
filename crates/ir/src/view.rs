use crate::{EdgeKind, NodeId, NodeKind};
use serde::{Deserialize, Serialize};

/// A lens over the canonical store. The browser scene and the LLM text map
/// are both projections under a ViewSpec; a lens is also a subscription
/// filter on the delta stream, and `expand(node)` is how the LLM and the
/// UI both implement semantic zoom.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewSpec {
    /// Empty = all kinds.
    #[serde(default)]
    pub node_kinds: Vec<NodeKind>,
    #[serde(default)]
    pub edge_kinds: Vec<EdgeKind>,
    /// Zoomed-in subtree root; None = whole repo.
    pub root: Option<NodeId>,
    /// Aggregate everything below this kind into weighted summary edges.
    pub collapse_below: Option<NodeKind>,
    /// Path glob / predicate, kept as a string so the filter grammar can
    /// grow without protocol changes.
    pub filter: Option<String>,
}
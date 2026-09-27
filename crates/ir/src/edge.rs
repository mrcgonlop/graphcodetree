use crate::{EdgeId, NodeId, Span};
use serde::{Deserialize, Serialize};

/// Relational vocabulary. `Contains`/`Defines` form the hierarchy tree
/// (rendered as nesting, never force-layout); the rest cut across it
/// (rendered as arcs).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    Contains,
    Defines,
    Imports,
    References,
    Calls,
    Inherits,
    Implements,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Edge {
    pub id: EdgeId,
    pub kind: EdgeKind,
    pub source: NodeId,
    pub target: NodeId,
    /// e.g. the call-site span for a `Calls` edge; used by rename/move fixups.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub span: Option<Span>,
    /// >1 when edges are rolled up by view collapse ("auth → db: 14 calls").
    #[serde(default = "one")]
    pub weight: u32,
}

fn one() -> u32 {
    1
}
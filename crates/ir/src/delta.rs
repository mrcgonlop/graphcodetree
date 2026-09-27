use crate::{Edge, EdgeId, Node, NodeId, Version};
use serde::{Deserialize, Serialize};

/// The only thing that crosses the wire after handshake. Initial load is a
/// chunked sequence of deltas bracketed by `Begin/EndSnapshot`; live updates
/// are small deltas. One code path for both.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GraphDelta {
    pub base_version: Version,
    pub version: Version,
    pub ops: Vec<GraphOp>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum GraphOp {
    BeginSnapshot,
    EndSnapshot,
    UpsertNode(Node),
    RemoveNode {
        id: NodeId,
    },
    UpsertEdge(Edge),
    RemoveEdge {
        id: EdgeId,
    },
}
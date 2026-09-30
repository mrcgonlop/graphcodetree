use crate::{Edge, EdgeId, EdgeKey, EdgeKind, Node, NodeId, NodeAttrs, NodeKey, NodeKind, Span, Version};
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

/// A node with stable identity and no runtime ID. The store mints `NodeId`s.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NodeSpec {
    pub kind: NodeKind,
    pub label: String,
    /// Original tree-sitter kind ("function_item") — round-trip fidelity.
    pub ast_kind: String,
    pub span: Option<Span>,
    pub is_definition: bool,
    pub attrs: NodeAttrs,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EdgeSpec {
    pub kind: EdgeKind,
    pub span: Option<Span>,
    pub weight: u32,
}

/// The interner-free counterpart of `GraphOp`. The store translates these
/// by interning keys; op order from `diff` is apply-safe (upsert nodes →
/// upsert edges → remove edges → remove nodes, so edges never dangle).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum KeyOp {
    UpsertNode { key: NodeKey, spec: NodeSpec },
    RemoveNode { key: NodeKey },
    UpsertEdge { key: EdgeKey, spec: EdgeSpec },
    RemoveEdge { key: EdgeKey },
}
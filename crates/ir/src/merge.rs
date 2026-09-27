//! One-shot graph snapshot types for static visualization.
//!
//! Types live in `cg-ir` (no runtime deps) so the CLI binary and the web
//! demo share the same JSON schema. The actual merging logic is in
//! `cg-extract` which owns [`FileGraph`] and [`NodeSpec`]/[`EdgeSpec`].

use crate::{EdgeKind, NodeAttrs, NodeKey, NodeKind, Span};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// A definition-level node in the flattened snapshot.
///
/// Only `is_definition: true` nodes are included — call sites (which use
/// `Anchored` keys) are preserved only as edge endpoints, not as visual
/// nodes, to keep the graph readable.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GraphNode {
    pub key: NodeKey,
    pub kind: NodeKind,
    pub label: String,
    pub ast_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub span: Option<Span>,
    pub attrs: NodeAttrs,
    /// Short file path for display (e.g. `src/main.rs`).
    pub file: PathBuf,
}

/// An edge in the flattened snapshot.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GraphEdge {
    pub kind: EdgeKind,
    pub source: NodeKey,
    pub target: NodeKey,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub span: Option<Span>,
    pub weight: u32,
}

/// The entire snapshot — everything the static visualizer needs.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    /// All definitions across all files, deduplicated by `NodeKey`.
    pub nodes: Vec<GraphNode>,
    /// All edges across all files.
    pub edges: Vec<GraphEdge>,
    /// Total files processed.
    pub file_count: usize,
    /// Summary statistics.
    pub stats: SnapshotStats,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SnapshotStats {
    pub total_nodes: usize,
    pub total_edges: usize,
    pub function_count: usize,
    pub struct_count: usize,
    pub trait_count: usize,
    pub impl_count: usize,
    pub calls_edge_count: usize,
    pub contains_edge_count: usize,
}

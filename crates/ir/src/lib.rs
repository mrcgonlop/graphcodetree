//! Canonical intermediate representation for the code graph.
//!
//! Single source of truth shared by extraction (tree-sitter), the store,
//! the browser client, and the LLM tool API. JSON is the wire format.
//! Adding a feature = adding a variant + an extractor query + an enricher
//! + a UI affordance. Keep this crate dependency-free.

mod delta;
mod edge;
mod id;
mod intent;
mod merge;
mod node;
mod view;

pub use delta::{EdgeSpec, GraphDelta, GraphOp, KeyOp, NodeSpec};
pub use edge::{Edge, EdgeKind};
pub use id::{EdgeId, EdgeKey, NodeId, NodeKey};
pub use intent::{EditIntent, EditRequest, IntentError, IntentOutcome, TextEdit, WorkspaceEdit};
pub use merge::{GraphEdge, GraphNode, Snapshot, SnapshotStats};
pub use node::{Node, NodeAttrs, NodeKind, Visibility};
pub use view::ViewSpec;

/// Record of a single import/use declaration.
/// Stored per-file for cross-file resolution in cg-resolve and cg-enrich.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ImportRecord {
    /// Path segments, e.g. `["crate", "foo", "bar"]`
    pub path: Vec<String>,
    /// Optional local alias, e.g. `use foo as bar` → alias="bar"
    pub alias: Option<String>,
    /// Glob import, e.g. `use foo::*`
    pub glob: bool,
    pub span: Span,
}

/// Declaration of a submodule, e.g. `mod foo;`
/// cg-enrich resolves these to sibling files to join the module tree.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModDecl {
    pub name: String,
    pub span: Span,
}

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Monotonic store version. Every delta carries the version it was built
/// against (`base_version`) and the version it produces (`version`), giving
/// clients optimistic-concurrency detection and the server a way to reject
/// stale edit intents instead of silently misapplying them.
pub type Version = u64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Lang {
    Rust,
    Python,
    TypeScript,
    Tsx,
    JavaScript,
    Go,
    C,
    Cpp,
    Java,
}

/// Row/column, zero-based, matching tree-sitter's `Point`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Point {
    pub row: u32,
    pub col: u32,
}

/// Source provenance for a node or edge. This is the layer that makes
/// graph→code intents compilable into text edits, and cursor↔selection
/// sync between graph and code pane.
///
/// Production note: intern `file` to a `FileId(u32)` + path table to shrink
/// the wire format; `PathBuf` keeps the schema self-contained for now.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Span {
    /// Repo-relative path.
    pub file: PathBuf,
    pub start_byte: u32,
    pub end_byte: u32,
    pub start: Point,
    pub end: Point,
}

// src/lib.rs, appended
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delta_round_trips_as_tagged_json() {
        let delta = GraphDelta {
            base_version: 41,
            version: 42,
            ops: vec![
                GraphOp::UpsertNode(Node {
                    id: NodeId(7),
                    kind: NodeKind::Function,
                    label: "extract".into(),
                    ast_kind: "function_item".into(),
                    span: Some(Span {
                        file: "src/ir/extract.rs".into(),
                        start_byte: 1020,
                        end_byte: 1450,
                        start: Point { row: 43, col: 0 },
                        end: Point { row: 61, col: 1 },
                    }),
                    is_definition: true,
                    attrs: NodeAttrs {
                        signature: Some("fn extract(src: &str) -> GraphDelta".into()),
                        ..Default::default()
                    },
                }),
                GraphOp::UpsertEdge(Edge {
                    id: EdgeId(3),
                    kind: EdgeKind::Calls,
                    source: NodeId(4),
                    target: NodeId(7),
                    span: None,
                    weight: 1,
                }),
            ],
        };

        let json = serde_json::to_string_pretty(&delta).unwrap();
        let back: GraphDelta = serde_json::from_str(&json).unwrap();
        assert_eq!(delta, back);
        // tagged representation keeps the schema greppable in logs/devtools
        assert!(json.contains("\"op\": \"upsert_node\""));
    }
}
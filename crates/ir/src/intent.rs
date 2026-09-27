use crate::{EdgeKind, NodeId, Span, Version};
use serde::{Deserialize, Serialize};

/// The server validates an intent against the legality table, compiles it
/// to text edits via stored spans, applies them to files, and lets the
/// re-parse delta flow back to all clients. Source files stay the single
/// source of truth; the graph is always a derived view.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "intent", rename_all = "snake_case")]
pub enum EditIntent {
    RenameSymbol { target: NodeId, new_name: String },
    /// Drag-and-drop: move an item to another module/file.
    MoveNode { node: NodeId, new_parent: NodeId },
    /// Edge-drag, e.g. fn→fn with kind=Calls inserts a call expression
    /// (plus an import if needed).
    AddEdge { kind: EdgeKind, source: NodeId, target: NodeId },
    RemoveNode { node: NodeId },
    /// Remove the construct that created the edge (a call, an import).
    RemoveEdge { kind: EdgeKind, source: NodeId, target: NodeId },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EditRequest {
    pub intent: EditIntent,
    pub base_version: Version,
    /// If true, return compiled edits for human/agent review without applying.
    /// This is the sandbox layer for LLM-submitted intents.
    #[serde(default)]
    pub dry_run: bool,
}

/// A single text replacement, located via the node's stored provenance.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TextEdit {
    pub span: Span,
    pub replacement: String,
}

/// Same idea as LSP's WorkspaceEdit: the compiled, file-level result of an intent.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceEdit {
    pub edits: Vec<TextEdit>,
    /// What the compiler thinks it's doing, for review UIs / agent confirmation.
    pub summary: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum IntentOutcome {
    /// Applied to disk; the resulting delta arrives on the normal stream.
    Applied { version: Version },
    /// dry_run=true: edits ready for review.
    Pending { edits: WorkspaceEdit },
    Rejected { error: IntentError },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(tag = "error", rename_all = "snake_case")]
pub enum IntentError {
    #[error("stale base version {base_version}, store is at {current}")]
    StaleVersion { base_version: Version, current: Version },
    #[error("unknown node id {id}")]
    UnknownNode { id: u32 },
    #[error("intent not legal: {reason}")]
    Illegal { reason: String },
    #[error("cannot compile to text edits: {reason}")]
    Uncompilable { reason: String },
}
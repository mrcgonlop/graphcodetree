//! Versioned in-memory graph. The derived view of the source tree.

pub struct GraphStore {
    version: Version,
    nodes: HashMap<NodeId, Node>,
    edges: HashMap<EdgeId, Edge>,
    intern: Interner, // NodeKey <-> NodeId, EdgeKey <-> EdgeId (lasso-style)
    contains: HashMap<NodeId, Vec<NodeId>>,
    by_kind: HashMap<NodeKind, Vec<NodeId>>,
}

impl GraphStore {
    /// Apply a verified delta; bumps version. Server-side only.
    pub fn apply(&mut self, delta: &GraphDelta) -> Result<(), StoreError>;
    /// Re-render a lens as a BeginSnapshot..EndSnapshot delta stream.
    pub fn snapshot(&self, view: &ViewSpec) -> GraphDelta;
    pub fn node(&self, id: NodeId) -> Option<&Node>;
    pub fn neighborhood(&self, id: NodeId, depth: u8) -> Vec<Edge>;
}
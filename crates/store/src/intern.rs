//! Bidirectional key↔ID interning for NodeKey/EdgeKey → NodeId/EdgeId.
//!
//! Keys are stable across re-extraction and survives edits — identity churn
//! only happens on genuine delete/rename. The interner is append-only:
//! IDs are never recycled (monotonic allocation) so they are safe to hold
//! across delta applications.

use cg_ir::{EdgeId, EdgeKey, NodeId, NodeKey};
use std::collections::HashMap;

/// Monotonic interner for graph keys.
///
/// Key behaviors:
/// - `intern_node(key)` returns existing or allocates a new `NodeId`
/// - `intern_edge(key)` same for edges
/// - `lookup_node(id)` / `lookup_edge(id)` reverse-lookup the key
/// - IDs are never recycled; a removed node's ID is dead but not reused
#[derive(Debug, Clone)]
pub struct Interner {
    node_by_key: HashMap<NodeKey, NodeId>,
    node_by_id: Vec<Option<NodeKey>>,
    edge_by_key: HashMap<EdgeKey, EdgeId>,
    edge_by_id: Vec<Option<EdgeKey>>,
    next_node_id: u32,
    next_edge_id: u32,
}

impl Interner {
    pub fn new() -> Self {
        Self {
            node_by_key: HashMap::new(),
            node_by_id: Vec::new(),
            edge_by_key: HashMap::new(),
            edge_by_id: Vec::new(),
            next_node_id: 1, // 0 is reserved for null/invalid
            next_edge_id: 1,
        }
    }

    /// Intern a node key, returning its stable NodeId.
    pub fn intern_node(&mut self, key: &NodeKey) -> NodeId {
        if let Some(&id) = self.node_by_key.get(key) {
            return id;
        }
        let id = NodeId(self.next_node_id);
        self.next_node_id += 1;
        let idx = id.0 as usize;
        if idx >= self.node_by_id.len() {
            self.node_by_id.resize_with(idx + 1, || None);
        }
        self.node_by_id[idx] = Some(key.clone());
        self.node_by_key.insert(key.clone(), id);
        id
    }

    /// Intern an edge key, returning its stable EdgeId.
    pub fn intern_edge(&mut self, key: &EdgeKey) -> EdgeId {
        if let Some(&id) = self.edge_by_key.get(key) {
            return id;
        }
        let id = EdgeId(self.next_edge_id);
        self.next_edge_id += 1;
        let idx = id.0 as usize;
        if idx >= self.edge_by_id.len() {
            self.edge_by_id.resize_with(idx + 1, || None);
        }
        self.edge_by_id[idx] = Some(key.clone());
        self.edge_by_key.insert(key.clone(), id);
        id
    }

    /// Reverse-lookup the key for a given node ID.
    pub fn lookup_node(&self, id: NodeId) -> Option<&NodeKey> {
        self.node_by_id.get(id.0 as usize).and_then(|o| o.as_ref())
    }

    /// Reverse-lookup the key for a given edge ID.
    pub fn lookup_edge(&self, id: EdgeId) -> Option<&EdgeKey> {
        self.edge_by_id.get(id.0 as usize).and_then(|o| o.as_ref())
    }

    /// Find a node ID by key (without interning).
    pub fn node_id(&self, key: &NodeKey) -> Option<NodeId> {
        self.node_by_key.get(key).copied()
    }

    /// Find an edge ID by key (without interning).
    pub fn edge_id(&self, key: &EdgeKey) -> Option<EdgeId> {
        self.edge_by_key.get(key).copied()
    }

    /// Number of interned nodes.
    pub fn node_count(&self) -> usize {
        self.node_by_key.len()
    }

    /// Number of interned edges.
    pub fn edge_count(&self) -> usize {
        self.edge_by_key.len()
    }

    /// Remove a node by key (called when a NodeKey-based removal comes in).
    /// The ID is not recycled, but the mappings are cleared.
    pub fn remove_node(&mut self, key: &NodeKey) {
        if let Some(id) = self.node_by_key.remove(key) {
            let idx = id.0 as usize;
            if idx < self.node_by_id.len() {
                self.node_by_id[idx] = None;
            }
        }
    }

    /// Remove an edge by key.
    pub fn remove_edge(&mut self, key: &EdgeKey) {
        if let Some(id) = self.edge_by_key.remove(key) {
            let idx = id.0 as usize;
            if idx < self.edge_by_id.len() {
                self.edge_by_id[idx] = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cg_ir::NodeKind;

    fn sample_key(i: u32) -> NodeKey {
        NodeKey::Symbol {
            lang: cg_ir::Lang::Rust,
            file: "src/lib.rs".into(),
            qualified_name: format!("fn_{}", i),
            kind: NodeKind::Function,
            disambiguator: 0,
        }
    }

    #[test]
    fn intern_and_lookup() {
        let mut int = Interner::new();
        let k1 = sample_key(1);
        let k2 = sample_key(2);

        let id1a = int.intern_node(&k1);
        let id1b = int.intern_node(&k1);
        assert_eq!(id1a, id1b, "same key → same id");

        let id2 = int.intern_node(&k2);
        assert_ne!(id1a, id2, "different keys → different ids");

        assert_eq!(int.lookup_node(id1a), Some(&k1));
        assert_eq!(int.lookup_node(id2), Some(&k2));
    }

    #[test]
    fn remove_and_dont_recycle() {
        let mut int = Interner::new();
        let k1 = sample_key(1);
        let id = int.intern_node(&k1);
        let next = int.intern_node(&sample_key(2));
        assert!(next.0 > id.0, "monotonic even after remove");
        int.remove_node(&k1);
        assert!(int.node_id(&k1).is_none(), "removed key gone");
        assert!(int.lookup_node(id).is_none(), "removed id gone");
        // Re-insert with different disambiguator
        let k1b = NodeKey::Symbol {
            lang: cg_ir::Lang::Rust,
            file: "src/lib.rs".into(),
            qualified_name: "fn_1".into(),
            kind: NodeKind::Function,
            disambiguator: 1,
        };
        let id_new = int.intern_node(&k1b);
        assert_ne!(id, id_new, "re-insert gets new id");
    }
}

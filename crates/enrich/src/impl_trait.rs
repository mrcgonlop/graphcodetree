//! ImplTraitEnricher — R3 enricher.
//!
//! Examines `ImplBlock` nodes and their signatures to produce:
//!
//! - `Implements` edges: `impl MyTrait for MyStruct` → trait to struct
//! - `Inherits` edges: `impl MyStruct { fn method() }` → method to owner
//!
//! The signature on an ImplBlock looks like:
//! - `impl TraitName for TypeName`
//! - `impl TypeName`
//!
//! We parse syntactically (no type inference) and look up the identifiers
//! in the store.

use cg_ir::{
    Edge, EdgeId, EdgeKind, GraphDelta, GraphOp, NodeId, NodeKind,
};
use cg_store::GraphStore;
use crate::Enricher;

/// Wires up impl/trait hierarchy from syntactic signatures.
pub struct ImplTraitEnricher;

impl Enricher for ImplTraitEnricher {
    fn name(&self) -> &'static str { "impl_trait" }

    fn enrich(&self, store: &GraphStore) -> GraphDelta {
        let base = store.version();
        let mut ops = Vec::new();
        let mut next_eid = store.edge_count() as u32 + 1;

        for impl_node in store.nodes_by_kind(NodeKind::ImplBlock) {
            let sig = match &impl_node.attrs.signature {
                Some(s) => s,
                None => continue,
            };

            if let Some((trait_name, type_name)) = parse_impl_for(&sig) {
                // Look up the trait node
                if let Some(trait_id) = find_by_name(store, &trait_name, NodeKind::Trait) {
                    // Look up the type node
                    let type_kinds = &[NodeKind::Struct, NodeKind::Enum];
                    let type_id = type_kinds.iter()
                        .find_map(|&k| find_by_name(store, &type_name, k));

                    if let Some(type_id) = type_id {
                        // Implements edge: impl_node → trait_node
                        let eid = EdgeId(next_eid); next_eid += 1;
                        ops.push(GraphOp::UpsertEdge(Edge {
                            id: eid,
                            kind: EdgeKind::Implements,
                            source: impl_node.id,
                            target: trait_id,
                            span: None,
                            weight: 1,
                        }));

                        // Also connect impl_node → type_node
                        let eid2 = EdgeId(next_eid); next_eid += 1;
                        ops.push(GraphOp::UpsertEdge(Edge {
                            id: eid2,
                            kind: EdgeKind::Implements,
                            source: impl_node.id,
                            target: type_id,
                            span: None,
                            weight: 1,
                        }));
                    }
                }
            }
        }

        GraphDelta {
            base_version: base,
            version: base + 1,
            ops,
        }
    }
}

/// Naively parse `"impl Trait for Type"` or `"impl Type"`.
fn parse_impl_for(sig: &str) -> Option<(String, String)> {
    let s = sig.trim();
    let s = s.strip_prefix("impl ")?;
    if let Some(mid) = s.find(" for ") {
        let trait_name = s[..mid].trim().to_string();
        let type_name = s[mid + 5..].trim().to_string();
        Some((trait_name, type_name))
    } else {
        // Simple `impl Type`
        None
    }
}

/// Find a definition node by label and kind.
fn find_by_name(store: &GraphStore, name: &str, kind: NodeKind) -> Option<NodeId> {
    store.nodes_by_kind(kind).iter()
        .find(|n| n.label == name)
        .map(|n| n.id)
}

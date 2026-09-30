//! DataFlowEnricher — models data flow between definitions.
//!
//! Uses `flows_from` annotations on CallSite nodes that were added by the
//! extractor when one call's return value is passed as an argument to another.
//!
//! For example, in `run_enrich`:
//!
//! ```ignore
//! let ops = extract_delta(&extractor, &file, prev).1; // ops (second tuple element)
//! store.ingest(ops);
//! ```
//!
//! The call site for `ingest(ops)` gets `flows_from: "0->..."`, meaning argument
//! 0 came from the call site that produced `ops`.  The enricher then creates a
//! `DataFlow` edge from `extract_delta` to `ingest`.
//!
//! # Limitations
//!
//! - Only intra-function data flow (within the same body) is tracked.
//! - Only simple `let`/`=` bindings where the RHS is a direct call are
//!   currently supported; method-chain data flow and field access are v2.

use cg_ir::{
    Edge, EdgeId, EdgeKind, GraphDelta, GraphOp, NodeId, NodeKind,
};
use cg_store::GraphStore;
use crate::Enricher;

/// Enriches the graph with `DataFlow` edges between definitions.
pub struct DataFlowEnricher;

impl Enricher for DataFlowEnricher {
    fn name(&self) -> &'static str { "data_flow" }

    fn enrich(&self, store: &GraphStore) -> GraphDelta {
        let base = store.version();
        let mut ops = Vec::new();
        let mut next_eid = store.edge_count() as u32 + 1;

        // Walk all definition nodes that have call sites as children.
        for def_node in store.all_nodes() {
            if !def_node.is_definition {
                continue;
            }
            // Collect call sites under this definition, keyed by ordinal.
            let mut calls_by_ord: std::collections::HashMap<u32, (&cg_ir::Node, NodeId)> =
                std::collections::HashMap::new();
            for edge in store.edges_from(def_node.id) {
                if edge.kind != EdgeKind::Contains {
                    continue;
                }
                if let Some(child) = store.node(edge.target) {
                    if child.kind == NodeKind::CallSite {
                        // Extract ordinal from the Anchored key.
                        if let Some(cg_ir::NodeKey::Anchored { ordinal, .. }) =
                            store.lookup_node_key(child.id)
                        {
                            calls_by_ord.insert(*ordinal, (child, child.id));
                        }
                    }
                }
            }

            if calls_by_ord.is_empty() {
                continue;
            }

            // For each call site with `flows_from`, resolve the producer and
            // consumer callees and create a DataFlow edge.
            for (_ord, (call_site, call_id)) in &calls_by_ord {
                let flows_from = call_site.attrs.extra.get("flows_from")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if flows_from.is_empty() {
                    continue;
                }

                // Find the callee definition that this call site targets.
                let consumer_callee = resolve_call_target(store, *call_id);

                for entry in flows_from.split(',') {
                    // entry format: "{arg_index}->{producer_ordinal}"
                    let parts: Vec<&str> = entry.split("->").collect();
                    if parts.len() != 2 {
                        continue;
                    }
                    let producer_ord: u32 = match parts[1].parse() {
                        Ok(n) => n,
                        Err(_) => continue,
                    };

                    // Find the producer call site and its target definition.
                    if let Some((_producer, producer_id)) = calls_by_ord.get(&producer_ord) {
                        let producer_callee = resolve_call_target(store, *producer_id);
                        if let (Some(src), Some(dst)) = (producer_callee, consumer_callee) {
                            if src != dst {
                                let eid = EdgeId(next_eid);
                                next_eid += 1;
                                ops.push(GraphOp::UpsertEdge(Edge {
                                    id: eid,
                                    kind: EdgeKind::DataFlow,
                                    source: src,
                                    target: dst,
                                    span: None,
                                    weight: 1,
                                }));
                            }
                        }
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

/// Given a call-site node ID, find the definition it calls.
/// First checks the interner for a direct Calls edge, then checks
/// the extra.callee field for a fallback.
fn resolve_call_target(store: &GraphStore, call_id: NodeId) -> Option<NodeId> {
    // Look for a Calls edge from this call site.
    for edge in store.edges_from(call_id) {
        if edge.kind == EdgeKind::Calls {
            return Some(edge.target);
        }
    }
    // Also check edges_to in case the edge direction is reversed.
    for edge in store.edges_to(call_id) {
        if edge.kind == EdgeKind::Calls {
            return Some(edge.source);
        }
    }
    None
}

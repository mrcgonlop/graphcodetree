//! CallGraphEnricher — R2 enricher.
//!
//! Walks CallSite nodes that were tagged `"imported"` or `"path_unresolved"`
//! by the extractor and attempts to resolve them against the store's global
//! definition index.
//!
//! Resolution strategy:
//!
//! 1. **Imported calls**: The call site's `extra.path` hint contains the
//!    import path (e.g. `"crate::foo::bar::baz"`). Strip the crate prefix
//!    and do a qualified-name lookup.
//! 2. **Path-unresolved calls**: The hint is a full path like
//!    `"crate::foo::bar::new"`. Try qualified-name lookup directly.
//! 3. **Unresolved simple names**: Try `lookup_qualified` with the callee
//!    name alone.

use cg_ir::{
    Edge, EdgeId, EdgeKind, GraphDelta, GraphOp, NodeId, NodeKind,
};
use cg_store::GraphStore;
use crate::Enricher;

/// Resolves cross-file call sites to their definition nodes.
pub struct CallGraphEnricher;

impl Enricher for CallGraphEnricher {
    fn name(&self) -> &'static str { "call_graph" }

    fn enrich(&self, store: &GraphStore) -> GraphDelta {
        let base = store.version();
        let mut ops = Vec::new();
        let mut next_eid = store.edge_count() as u32 + 1;

        for call_site in store.nodes_by_kind(NodeKind::CallSite) {
            let resolution = call_site.attrs.extra.get("resolution")
                .and_then(|v| v.as_str()).unwrap_or("");
            let hint = call_site.attrs.extra.get("path")
                .and_then(|v| v.as_str()).unwrap_or("");

            let target = match resolution {
                "imported" => resolve_imported(store, hint, call_site),
                "path_unresolved" => resolve_path(store, hint),
                "unresolved" => resolve_simple(store, &call_site.label),
                _ => None,
            };

            if let Some(target_id) = target {
                let eid = EdgeId(next_eid);
                next_eid += 1;
                ops.push(GraphOp::UpsertEdge(Edge {
                    id: eid,
                    kind: EdgeKind::Calls,
                    source: call_site.id,
                    target: target_id,
                    span: None,
                    weight: 1,
                }));
            }
        }

        GraphDelta {
            base_version: base,
            version: base + 1,
            ops,
        }
    }
}

/// Resolve an `"imported"` call: hint is the import path like
/// `"crate::foo::bar::Baz"`. The last segment is the callee name;
/// the preceding segments are the import path.
fn resolve_imported(store: &GraphStore, hint: &str, _site: &cg_ir::Node) -> Option<NodeId> {
    let qn = strip_crate_prefix(hint);
    let results = store.lookup_qualified(&qn);
    if !results.is_empty() {
        return Some(results[0].0);
    }
    // Try just the last path segment (the callee name)
    if let Some(name) = qn.rsplit("::").next() {
        let results = store.lookup_qualified(name);
        if results.len() == 1 {
            return Some(results[0].0);
        }
    }
    None
}

/// Resolve a `"path_unresolved"` call: hint is a full path like
/// `"crate::foo::bar::new"`.
fn resolve_path(store: &GraphStore, hint: &str) -> Option<NodeId> {
    let qn = strip_crate_prefix(hint);
    let results = store.lookup_qualified(&qn);
    if !results.is_empty() {
        return Some(results[0].0);
    }
    None
}

/// Resolve an `"unresolved"` call: try to find a single definition
/// matching the callee name.
fn resolve_simple(store: &GraphStore, callee: &str) -> Option<NodeId> {
    let results = store.lookup_qualified(callee);
    if results.len() == 1 {
        return Some(results[0].0);
    }
    None
}

/// Strip leading `crate::`, `self::`, `super::` segments from a path.
fn strip_crate_prefix(path: &str) -> String {
    path.trim_start_matches("crate::")
        .trim_start_matches("self::")
        .trim_start_matches("super::")
        .to_string()
}

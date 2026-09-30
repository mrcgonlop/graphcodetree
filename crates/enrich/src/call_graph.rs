//! CallGraphEnricher — R2 enricher.
//!
//! Walks CallSite nodes tagged by the extractor and attempts to resolve
//! them against the store's global definition index.
//!
//! Resolution strategy by tag:
//!
//! | Tag                | Strategy |
//! |--------------------|----------|
//! | `"imported"`       | `extra.hint` contains the import path (e.g. `"crate::foo::Bar"`). Strip the crate prefix and try qualified-name lookup. |
//! | `"path_unresolved"`| `extra.hint` is a full path like `"crate::foo::bar::new"`. Try qualified-name lookup directly. |
//! | `"unresolved"`     | Try `lookup_qualified` with the callee name alone. |
//! | `"method_unresolved"` | Receiver type in `extra.hint`; try to find a method impl'd for that type anywhere in the store. |
//! | `"self_method"`    | Resolved same-file by the extractor — already wired, skip. |
//! | `"same_file"`      | Already wired by extractor — skip. |
//! | `"dynamic"`        | Closures, macros — skip. |

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
            // The extractor writes "hint"; the enricher reads "hint".
            let hint = call_site.attrs.extra.get("hint")
                .and_then(|v| v.as_str()).unwrap_or("");

            let target = match resolution {
                // Already wired by the extractor — skip.
                "same_file" | "self_method" | "dynamic" => None,

                // Imported call: hint is e.g. "crate::foo::Bar::baz".
                "imported" => resolve_imported(store, hint),

                // Scoped path that wasn't resolved: hint is e.g. "crate::foo::bar::new".
                "path_unresolved" => resolve_path(store, hint),

                // Simple name: try lookup by label.
                "unresolved" => resolve_simple(store, &call_site.label),

                // Method call on a receiver: hint is the receiver type name.
                // Look for a method with this name in any impl block.
                "method_unresolved" => resolve_method(store, &call_site.label, hint),

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
fn resolve_imported(store: &GraphStore, hint: &str) -> Option<NodeId> {
    if hint.is_empty() {
        return None;
    }
    let qn = strip_crate_prefix(hint);
    // First try the full qualified name.
    let results = store.lookup_qualified(&qn);
    if !results.is_empty() {
        return Some(results[0].0);
    }
    // Then try just the last path segment (the callee name).
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
    if hint.is_empty() {
        return None;
    }
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

/// Resolve a `"method_unresolved"` call: `receiver.method_name()` where
/// `method_name` is `call_site.label` and `hint` is a short receiver-type
/// name (up to 32 chars).  Search all `ImplBlock` nodes in the store for
/// a method with this name.
fn resolve_method(store: &GraphStore, method_name: &str, hint: &str) -> Option<NodeId> {
    if method_name.is_empty() {
        return None;
    }
    // Strategy 1: search all impl blocks for a method matching the name.
    // Uses `Contains` edges from the impl block to find its children.
    for impl_node in store.nodes_by_kind(NodeKind::ImplBlock) {
        for edge in store.edges_from(impl_node.id) {
            if edge.kind != EdgeKind::Contains {
                continue;
            }
            let child_id = edge.target;
            if let Some(child) = store.node(child_id) {
                if child.label == method_name
                    && matches!(child.kind, NodeKind::Method | NodeKind::Function)
                {
                    return Some(child_id);
                }
            }
        }
    }

    // Strategy 2: if hint contains a type name, try
    // `store.lookup_qualified("{type}::{method}")`.
    if !hint.is_empty() {
        let candidate = format!("{}::{}", hint, method_name);
        let results = store.lookup_qualified(&candidate);
        if !results.is_empty() {
            return Some(results[0].0);
        }
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

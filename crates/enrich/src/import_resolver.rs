//! ImportResolver — R1 enricher.
//!
//! Consumes `ImportRecord` and `ModDecl` metadata from ingested files and
//! produces:
//!
//! - `Imports` edges from the source file to the target definition
//! - `Contains` edges joining module trees (e.g., `mod foo;` → parent module)
//!
//! This is purely syntactic: no type information, no `use crate::...`
//! resolution against external crates. The resolver only wires up local
//! module declarations and import records that can be mapped to nodes
//! already in the store.

use std::path::Path;

use cg_ir::{
    Edge, EdgeId, EdgeKind, GraphDelta, GraphOp, NodeId, NodeKey, NodeKind,
};
use cg_store::GraphStore;
use crate::Enricher;

/// Resolves local `mod` declarations and unconnected import records into
/// `Imports` / `Contains` edges.
pub struct ImportResolver;

impl Enricher for ImportResolver {
    fn name(&self) -> &'static str { "import_resolver" }

    fn enrich(&self, store: &GraphStore) -> GraphDelta {
        let base = store.version();
        let mut ops = Vec::new();
        // Start edge IDs safely past any existing edge count so we don't
        // collide with IDs already assigned by store.to_snapshot().
        let mut next_eid = store.edge_count() as u32 + 1;
        let file_nodes = store.nodes_by_kind(NodeKind::File);

        // ── Phase 1: resolve mod declarations ────────────────────────
        // Walk all File nodes, find their mod_decls, and create Contains
        // edges to the target module file node.
        for file_node in &file_nodes {
            let file_key = store.interner().lookup_node(file_node.id);
            let file_path = match file_key {
                Some(NodeKey::Symbol { file, .. }) => file,
                _ => continue,
            };
            let Some(decls) = store.mod_decls_for(file_path) else { continue };
            let parent_dir = file_path.parent().unwrap_or(std::path::Path::new(""));

            for decl in decls {
                // Rust module resolution:
                //   mod foo;  →  {parent}/foo.rs  OR  {parent}/foo/mod.rs
                let candidate1 = parent_dir.join(&decl.name).with_extension("rs");
                let candidate2 = parent_dir.join(&decl.name).join("mod.rs");

                let target = find_module_node(store, &candidate1)
                    .or_else(|| find_module_node(store, &candidate2));

                if let Some(target_id) = target {
                    let eid = EdgeId(next_eid);
                    next_eid += 1;
                    ops.push(GraphOp::UpsertEdge(Edge {
                        id: eid,
                        kind: EdgeKind::Contains,
                        source: file_node.id,
                        target: target_id,
                        span: Some(decl.span.clone()),
                        weight: 1,
                    }));
                }
            }
        }

        // ── Phase 2: resolve import records ──────────────────────────
        // For each file's import records, try to find the target node
        // by reconstructing the qualified name from the import path.
        for file_node in &file_nodes {
            let file_key = store.interner().lookup_node(file_node.id);
            let file_path = match file_key {
                Some(NodeKey::Symbol { file, .. }) => file,
                _ => continue,
            };
            let Some(imports) = store.imports_for(file_path) else { continue };

            for imp in imports {
                let qn = import_path_to_qualified(&imp.path);
                if qn.is_empty() {
                    continue;
                }
                let targets = store.lookup_qualified(&qn);
                if targets.is_empty() && qn.contains("::") {
                    // Partial match: try the last segment as a simple name.
                    if let Some(last) = qn.rsplit("::").next() {
                        if last.len() > 1 {
                            let fallback = store.lookup_qualified(last);
                            if fallback.len() == 1 {
                                let eid = EdgeId(next_eid);
                                next_eid += 1;
                                ops.push(GraphOp::UpsertEdge(Edge {
                                    id: eid,
                                    kind: EdgeKind::Imports,
                                    source: file_node.id,
                                    target: fallback[0].0,
                                    span: Some(imp.span.clone()),
                                    weight: 1,
                                }));
                            }
                        }
                    }
                }
                for (target_id, _) in &targets {
                    let eid = EdgeId(next_eid);
                    next_eid += 1;
                    ops.push(GraphOp::UpsertEdge(Edge {
                        id: eid,
                        kind: EdgeKind::Imports,
                        source: file_node.id,
                        target: *target_id,
                        span: Some(imp.span.clone()),
                        weight: 1,
                    }));
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

/// Convert an import path vector into a qualified name string.
/// Strips leading "crate" and "self" since those are contextual.
fn import_path_to_qualified(path: &[String]) -> String {
    path.iter()
        .skip_while(|s| s.as_str() == "crate" || s.as_str() == "self" || s.as_str() == "super")
        .cloned()
        .collect::<Vec<_>>()
        .join("::")
}

/// Find a node whose key matches the given path (trying Module, then File).
fn find_module_node(store: &GraphStore, path: &Path) -> Option<NodeId> {
    // Normalize path separators to what the store uses.
    let normalized: std::path::PathBuf = path.components().collect();

    let key = NodeKey::Symbol {
        lang: cg_ir::Lang::Rust,
        file: normalized.clone(),
        qualified_name: String::new(),
        kind: NodeKind::Module,
        disambiguator: 0,
    };
    store.lookup_node(&key)
        .or_else(|| {
            let fk = NodeKey::Symbol {
                lang: cg_ir::Lang::Rust,
                file: normalized,
                qualified_name: String::new(),
                kind: NodeKind::File,
                disambiguator: 0,
            };
            store.lookup_node(&fk)
        })
}

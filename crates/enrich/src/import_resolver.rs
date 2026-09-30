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

        // Phase 1: resolve mod declarations
        // Walk all File nodes, find their mod_decls, and create Contains
        // edges to the target module file node.
        for file_node in store.nodes_by_kind(NodeKind::File) {
            let file_key = store.interner().lookup_node(file_node.id);
            let file_path = match file_key {
                Some(NodeKey::Symbol { file, .. }) => file,
                _ => continue,
            };
            let Some(decls) = store.mod_decls_for(file_path) else { continue };
            let parent_dir = file_path.parent().unwrap_or(std::path::Path::new(""));

            for decl in decls {
                // Try to find a sibling file matching the module name
                let sibling_file = parent_dir.join(&decl.name).with_extension("rs");
                let mod_path = parent_dir.join(format!("{}.rs", decl.name));

                // Check each possibility
                let target = find_module_node(store, &sibling_file)
                    .or_else(|| find_module_node(store, &mod_path));

                if let Some(target_id) = target {
                    let eid = EdgeId(store.edge_count() as u32 + 1);
                    // Ensure the next ID doesn't collide; store.apply() inserts fresh
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

        // Phase 2: resolve import records to qualified-name lookups
        // For each file's import records, try to find the target node
        // by reconstructing the qualified name from the import path.
        for file_node in store.nodes_by_kind(NodeKind::File) {
            let file_key = store.interner().lookup_node(file_node.id);
            let file_path = match file_key {
                Some(NodeKey::Symbol { file, .. }) => file,
                _ => continue,
            };
            let Some(imports) = store.imports_for(file_path) else { continue };

            // Build the qualified name from the import path
            // e.g. ["crate", "foo", "bar"] → "foo::bar" (strip "crate")
            for imp in imports {
                let qn = import_path_to_qualified(&imp.path);
                let targets = store.lookup_qualified(&qn);
                for (target_id, _) in &targets {
                    let eid = EdgeId(store.edge_count() as u32 + 1);
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

/// Find a File node whose key matches the given path.
fn find_module_node(store: &GraphStore, path: &std::path::Path) -> Option<NodeId> {
    let key = NodeKey::Symbol {
        lang: cg_ir::Lang::Rust,
        file: path.to_path_buf(),
        qualified_name: String::new(),
        kind: NodeKind::Module,
        disambiguator: 0,
    };
    store.lookup_node(&key)
        .or_else(|| {
            // Also try as a regular file
            let fk = NodeKey::Symbol {
                lang: cg_ir::Lang::Rust,
                file: path.to_path_buf(),
                qualified_name: String::new(),
                kind: NodeKind::File,
                disambiguator: 0,
            };
            store.lookup_node(&fk)
        })
}

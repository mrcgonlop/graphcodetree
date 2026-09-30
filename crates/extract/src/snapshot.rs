//! Merge per-file [`FileGraph`]s into a single [`Snapshot`] for static
//! visualization.
//!
//! The snapshot types (`GraphNode`, `GraphEdge`, `Snapshot`, `SnapshotStats`)
//! live in `cg-ir` so the web demo depends only on `cg-ir` for its JSON
//! schema. This function owns the merge logic because it needs access to
//! [`NodeSpec::is_definition`] and [`EdgeSpec`].

use std::collections::BTreeMap;

use cg_ir::{EdgeKind, GraphEdge, GraphNode, NodeKey, NodeKind, Snapshot, SnapshotStats};

use crate::{FileGraph};

/// Flatten one or more per-file `FileGraph`s into a single `Snapshot`.
///
/// Deduplicates definitions by `NodeKey` (first-encountered wins), preserves
/// all edges, and computes summary statistics.
pub fn flatten(graphs: impl IntoIterator<Item = FileGraph>) -> Snapshot {
    let mut node_map: BTreeMap<NodeKey, GraphNode> = BTreeMap::new();
    let mut edges = Vec::new();
    let mut file_count = 0usize;

    for fg in graphs {
        file_count += 1;
        for (key, spec) in fg.nodes {
            if spec.is_definition {
                node_map.entry(key.clone()).or_insert(GraphNode {
                    key,
                    kind: spec.kind,
                    label: spec.label,
                    ast_kind: spec.ast_kind,
                    span: spec.span,
                    attrs: spec.attrs,
                    file: fg.file.clone(),
                });
            }
        }
        for (key, spec) in fg.edges {
            edges.push(GraphEdge {
                kind: key.kind,
                source: key.source,
                target: key.target,
                span: spec.span,
                weight: spec.weight,
            });
        }
    }

    let mut function_count = 0;
    let mut struct_count = 0;
    let mut trait_count = 0;
    let mut impl_count = 0;
    let mut calls_edge_count = 0;
    let mut contains_edge_count = 0;

    for node in node_map.values() {
        match node.kind {
            NodeKind::Function | NodeKind::Method => function_count += 1,
            NodeKind::Struct => struct_count += 1,
            NodeKind::Trait => trait_count += 1,
            NodeKind::ImplBlock => impl_count += 1,
            _ => {}
        }
    }
    for edge in &edges {
        match edge.kind {
            EdgeKind::Calls => calls_edge_count += 1,
            EdgeKind::Contains => contains_edge_count += 1,
            _ => {}
        }
    }

    let total_nodes = node_map.len();
    let total_edges = edges.len();

    Snapshot {
        nodes: node_map.into_values().collect(),
        edges,
        file_count,
        stats: SnapshotStats {
            total_nodes,
            total_edges,
            function_count,
            struct_count,
            trait_count,
            impl_count,
            calls_edge_count,
            contains_edge_count,
            impl_edge_count: 0,
            data_flow_edge_count: 0,
        },
    }
}

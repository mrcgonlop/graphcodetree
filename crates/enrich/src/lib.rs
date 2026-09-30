//! # cg-enrich
//!
//! Store-centric enrichment layer. Each enricher is a stateless `Enricher`
//! that queries the [`GraphStore`] and returns a [`GraphDelta`] of new
//! edges/nodes. The host runs them after extraction and applies their
//! deltas back into the store for broadcasting.
//!
//! # Iteration plan
//!
//! | Step | Enricher | What it adds |
//! |------|----------|-------------|
//! | R1   | `ImportResolver` | `Imports` edges + `Contains` for module hierarchy |
//! | R2   | `CallGraphEnricher` | Cross-file `Calls` edges via import+qualified lookup |
//! | R3   | `ImplTraitEnricher` | `Implements`/`Inherits` edges from impl blocks |
//! | R4+  | Type resolver | Method dispatch, dataflow, generics |

mod import_resolver;
mod call_graph;
mod impl_trait;

pub use import_resolver::ImportResolver;
pub use call_graph::CallGraphEnricher;
pub use impl_trait::ImplTraitEnricher;

use cg_ir::GraphDelta;
use cg_store::GraphStore;

/// A stateless, idempotent enrichment pass.
///
/// `enrich` receives a snapshot of the store and returns a delta of
/// *new* nodes/edges that are then applied back. The enricher must not
/// mutate the store itself.
pub trait Enricher: Send + Sync {
    /// Human-readable name (for logging / debugging).
    fn name(&self) -> &'static str;

    /// Produce additive ops. The caller applies them atomically.
    fn enrich(&self, store: &GraphStore) -> GraphDelta;
}

/// Run an enrichment pipeline: apply each enricher in sequence, returning
/// the combined delta.
pub fn run_pipeline<'a>(
    store: &GraphStore,
    enrichers: impl IntoIterator<Item = &'a dyn Enricher>,
) -> Vec<GraphDelta> {
    let mut deltas = Vec::new();
    for enricher in enrichers {
        let delta = enricher.enrich(store);
        if !delta.ops.is_empty() {
            tracing::info!(
                "enricher {} produced {} ops (version {} -> {})",
                enricher.name(),
                delta.ops.len(),
                delta.base_version,
                delta.version,
            );
        }
        deltas.push(delta);
    }
    deltas
}

#[cfg(test)]
mod tests {
    use super::*;
    use cg_ir::GraphDelta;

    #[test]
    fn enricher_trait_baseline() {
        struct Noop;
        impl Enricher for Noop {
            fn name(&self) -> &'static str { "noop" }
            fn enrich(&self, _store: &GraphStore) -> GraphDelta {
                GraphDelta { base_version: 0, version: 0, ops: vec![] }
            }
        }
        let store = GraphStore::new();
        let deltas = run_pipeline(&store, [&Noop as &dyn Enricher]);
        assert!(deltas[0].ops.is_empty());
    }
}

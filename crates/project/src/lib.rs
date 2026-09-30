pub enum DetailLevel { Modules, Definitions, Bodies }

/// Aider-style map, but with inline [n:ID]s so agents can reference nodes
/// unambiguously in expand()/EditIntent calls. Deterministic ordering,
/// stable per-module chunks (prompt-cache friendly).
pub fn render_map(store: &GraphStore, view: &ViewSpec, level: DetailLevel, budget: usize) -> String;

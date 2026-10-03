//! # cg-extract
//!
//! Pure tree-sitter → IR extraction: no interning, no store, no I/O.
//!
//! ```text
//! edit → (server) tree.edit + reparse
//!      → extract_delta(extractor, file, prev)
//!      → Vec<KeyOp>                    // keyed, interner-free
//!      → (cg-store) intern keys → GraphDelta → broadcast
//! ```
//!
//! Two passes per file: (1) register every definition so forward references
//! resolve, (2) walk bodies for call sites. Resolution here is deliberately
//! shallow — same-file defs, `self` methods, import bookkeeping. Cross-file
//! resolution (crate paths, `mod foo;` joining, method receivers) consumes
//! [`FileGraph::imports`] / [`FileGraph::mod_decls`] over in cg-resolve.
//!
//! Deliberately *no* external stub nodes: an unresolved name is recorded on
//! the call site, not materialized as a node the resolver would later have
//! to re-key.

//! The extractor crate is a shared, language-agnostic walker (`walk`) driven
//! by per-language profiles (`profile`). Adding a language is a new profile
//! module plus one line in `profile::PROFILES`; the walker, the store and the
//! enrichers never change.
//!
//! Deliberately *no* external stub nodes: an unresolved name is recorded on
//! the call site, not materialized as a node the resolver would later have
//! to re-key.

mod profile;
mod python;
mod rust;
mod snapshot;
mod text;
mod walk;

pub use profile::{
    all, for_extension, for_lang, BindingCapture, BodyRole, CalleeShape, DocAction, ImplInfo,
    ItemClass, LangProfile, ProfileExtractor,
};
pub use rust::RustExtractor;
pub use snapshot::flatten;

use cg_ir::{EdgeKey, EdgeSpec, ImportRecord, KeyOp, Lang, ModDecl, NodeKey, NodeSpec};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct SourceFile {
    /// Repo-relative; becomes the `file` component of every NodeKey.
    pub path: PathBuf,
    pub lang: Lang,
    pub text: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ExtractError {
    #[error("failed to initialize tree-sitter language")]
    LanguageInit,
    #[error("tree-sitter returned no tree")]
    ParseFailed,
    #[error("extractor does not match file language")]
    LangMismatch,
}

pub trait Extractor: Send + Sync {
    fn lang(&self) -> Lang;
    fn extract(&self, file: &SourceFile) -> Result<FileGraph, ExtractError>;
}

/// Everything one file contributes to the graph, keyed and self-contained.
/// `imports`/`mod_decls` are the contract with cg-resolve.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FileGraph {
    pub file: PathBuf,
    pub lang: Lang,
    pub content_hash: u64,
    pub nodes: BTreeMap<NodeKey, NodeSpec>,
    pub edges: BTreeMap<EdgeKey, EdgeSpec>,
    pub imports: Vec<ImportRecord>,
    /// `mod foo;` declarations — resolver maps these to sibling files.
    pub mod_decls: Vec<ModDecl>,
}

impl FileGraph {
    pub fn new(file: &Path, lang: Lang, content_hash: u64) -> Self {
        Self {
            file: file.into(),
            lang,
            content_hash,
            nodes: BTreeMap::new(),
            edges: BTreeMap::new(),
            imports: Vec::new(),
            mod_decls: Vec::new(),
        }
    }
    pub fn empty(file: &Path, lang: Lang) -> Self {
        Self::new(file, lang, 0)
    }
}

// ImportRecord and ModDecl are defined in cg-ir and re-exported from there.

/// Keyed set difference. Identity churn (remove+add) only happens when a
/// construct is genuinely deleted or renamed; span/attr changes are upserts.
pub fn diff(old: &FileGraph, new: &FileGraph) -> Vec<KeyOp> {
    let mut ops = Vec::new();
    for (k, spec) in &new.nodes {
        if old.nodes.get(k) != Some(spec) {
            ops.push(KeyOp::UpsertNode { key: k.clone(), spec: spec.clone() });
        }
    }
    for (k, spec) in &new.edges {
        if old.edges.get(k) != Some(spec) {
            ops.push(KeyOp::UpsertEdge { key: k.clone(), spec: spec.clone() });
        }
    }
    for k in old.edges.keys().filter(|k| !new.edges.contains_key(*k)) {
        ops.push(KeyOp::RemoveEdge { key: k.clone() });
    }
    for k in old.nodes.keys().filter(|k| !new.nodes.contains_key(*k)) {
        ops.push(KeyOp::RemoveNode { key: k.clone() });
    }
    ops
}

/// The incremental entry point. v1 re-extracts the whole file and diffs —
/// tree-sitter's reparse is already incremental and keyed diffing keeps the
/// emitted ops minimal. Scoped re-extraction (tree-sitter changed ranges →
/// nearest stable ancestor) is an optimization layered on later; it changes
/// performance, never the output.
pub fn extract_delta(
    extractor: &dyn Extractor,
    file: &SourceFile,
    prev: Option<&FileGraph>,
) -> Result<(FileGraph, Vec<KeyOp>), ExtractError> {
    let new = extractor.extract(file)?;
    let ops = match prev {
        Some(old) if old.content_hash == new.content_hash => Vec::new(),
        Some(old) => diff(old, &new),
        None => diff(&FileGraph::empty(&file.path, file.lang), &new),
    };
    Ok((new, ops))
}

pub fn hash_text(text: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}
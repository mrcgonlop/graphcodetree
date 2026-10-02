//! `codegraph` — CLI for the code graph toolchain.
//!
//! # Subcommands
//!
//! | Command     | Description                                           |
//! |-------------|-------------------------------------------------------|
//! | `snapshot`  | One-shot static snapshot (extract-only, no store).    |
//! | `enrich`    | Full pipeline: extract → ingest → enrich → snapshot.  |
//!
//! # Usage
//!
//! ```bash
//! # Old-style snapshot (no cross-file enrichment)
//! codegraph snapshot . > snapshot.json
//!
//! # Full pipeline with enrichment
//! codegraph enrich . > graph.json
//!
//! # Write directly to the web demo location
//! codegraph enrich . --output web/demo/graph.json
//! ```
//!
//! Then open `web/demo/index.html` in a browser to explore the graph.

use std::io::Write;
use std::path::PathBuf;

use clap::Parser;
use cg_extract::{
    diff, for_extension, Extractor, FileGraph, LangProfile, ProfileExtractor, SourceFile,
};
use cg_ir::Snapshot;
use walkdir::WalkDir;

// ─── CLI Definition ───────────────────────────────────────────────────────────

#[derive(Parser)]
#[command(name = "codegraph", about = "Code graph toolchain")]
enum Cli {
    /// Extract a flat, one-shot snapshot of a codebase (extract-only, no
    /// store, no enrichment).
    Snapshot {
        /// Directory to scan (default: current dir).
        #[arg(default_value = ".")]
        dir: PathBuf,

        /// Write JSON to this file instead of stdout.
        #[arg(short, long)]
        output: Option<PathBuf>,
    },

    /// Run the full pipeline: extract → store → enrich → snapshot.
    ///
    /// Walks a directory, extracts every recognised source file (language
    /// chosen by extension — see `cg_extract::for_extension`), ingests into an
    /// in-memory graph store, runs the enrichment pipeline (import resolution,
    /// call graph, impl-trait links), and exports the enriched snapshot.
    Enrich {
        /// Directory to scan (default: current dir).
        #[arg(default_value = ".")]
        dir: PathBuf,

        /// Write JSON to this file instead of stdout.
        /// Use this on Windows to avoid UTF-16 redirection from `>`.
        #[arg(short, long)]
        output: Option<PathBuf>,

        /// Also write a copy to `web/demo/graph.json` for the browser demo.
        #[arg(long)]
        demo: bool,
    },
}

fn main() {
    let cli = Cli::parse();

    match cli {
        Cli::Snapshot { dir, output } => {
            let snapshot = run_snapshot(&dir).unwrap_or_else(|e| {
                eprintln!("error: {e}");
                std::process::exit(1);
            });
            write_json("snapshot", output, &snapshot);
        }
        Cli::Enrich { dir, output, demo } => {
            let snapshot = run_enrich(&dir).unwrap_or_else(|e| {
                eprintln!("error: {e}");
                std::process::exit(1);
            });
            write_json("enrich", output, &snapshot);

            if demo {
                let demo_path = PathBuf::from(
                    std::env::var("CARGO_MANIFEST_DIR")
                        .unwrap_or_else(|_| ".".into()),
                )
                .parent()
                .map(|p| p.join("web").join("demo").join("graph.json"))
                .unwrap_or_else(|| PathBuf::from("web/demo/graph.json"));

                let file = std::fs::File::create(&demo_path).unwrap_or_else(|e| {
                    eprintln!("error: cannot create {}: {e}", demo_path.display());
                    std::process::exit(1);
                });
                let mut writer = std::io::BufWriter::new(file);
                serde_json::to_writer_pretty(&mut writer, &snapshot).expect("write JSON");
                eprintln!("📦 demo graph written to {}", demo_path.display());
            }
        }
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn write_json(_cmd: &str, output: Option<PathBuf>, snapshot: &Snapshot) {
    let mut writer: Box<dyn Write> = match &output {
        Some(path) => {
            let file = std::fs::File::create(path).unwrap_or_else(|e| {
                eprintln!("error: cannot create {}: {e}", path.display());
                std::process::exit(1);
            });
            Box::new(std::io::BufWriter::new(file))
        }
        None => Box::new(std::io::stdout().lock()),
    };
    serde_json::to_writer_pretty(&mut writer, snapshot).expect("write JSON");

    eprintln!(
        "📊 {} files · {} definitions · {} edges \
         ({} functions, {} structs, {} traits, {} impls, {} calls, {} contains)",
        snapshot.file_count,
        snapshot.stats.total_nodes,
        snapshot.stats.total_edges,
        snapshot.stats.function_count,
        snapshot.stats.struct_count,
        snapshot.stats.trait_count,
        snapshot.stats.impl_count,
        snapshot.stats.calls_edge_count,
        snapshot.stats.contains_edge_count,
    );
}

/// Directory names never worth walking: VCS noise, build output and vendored
/// deps. `target`/`node_modules`/`vendor` predate language support; the rest
/// are the usual Python/JS noise that would otherwise drown a mixed-repo walk.
const SKIP_DIRS: &[&str] = &[
    "target",
    "node_modules",
    "vendor",
    "dist",
    "build",
    "coverage",
    "__pycache__",
    ".venv",
    "venv",
];

/// Collect every source file under `dir` whose extension a language profile
/// recognises, paired with that file's profile (reused by both commands).
///
/// The language of a file comes from its extension via
/// [`cg_extract::for_extension`], so adding a language to the registry is all
/// it takes for the CLI to walk it.
fn collect_source_files(dir: &PathBuf) -> Vec<(PathBuf, &'static LangProfile, String)> {
    let mut files = Vec::new();
    for entry in WalkDir::new(dir)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            if e.file_type().is_dir() {
                let name = e.file_name().to_string_lossy();
                return !(name.starts_with('.') || SKIP_DIRS.contains(&name.as_ref()));
            }
            true
        })
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
            continue;
        };
        let Some(profile) = for_extension(ext) else {
            continue;
        };
        let text = std::fs::read_to_string(path).unwrap_or_else(|e| {
            eprintln!("warning: read {}: {e}", path.display());
            String::new()
        });
        if !text.is_empty() {
            files.push((path.to_path_buf(), profile, text));
        }
    }
    files
}

// ─── Snapshot (old pipeline) ──────────────────────────────────────────────────

fn run_snapshot(dir: &PathBuf) -> Result<Snapshot, Box<dyn std::error::Error>> {
    let mut graphs = Vec::new();

    for (path, profile, text) in collect_source_files(dir) {
        let file = SourceFile {
            path,
            lang: profile.lang,
            text,
        };
        let fg = ProfileExtractor(profile).extract(&file)?;
        graphs.push(fg);
    }

    Ok(cg_extract::flatten(graphs))
}

// ─── Enrich (full pipeline) ───────────────────────────────────────────────────

fn run_enrich(dir: &PathBuf) -> Result<Snapshot, Box<dyn std::error::Error>> {
    use cg_store::GraphStore;

    let mut store = GraphStore::new();
    let mut version: u64 = 0;
    let mut file_count: usize = 0;

    // Phase 1: extract + ingest every file
    for (path, profile, text) in collect_source_files(dir) {
        file_count += 1;
        let file = SourceFile {
            path: path.clone(),
            lang: profile.lang,
            text,
        };
        let fg = ProfileExtractor(profile).extract(&file)?;

        // Convert the full FileGraph to KeyOps via diff(empty, fg).
        let ops = diff(&FileGraph::empty(&fg.file, fg.lang), &fg);
        let imports = fg.imports;
        let mods = fg.mod_decls;

        // Ingest into store.
        let delta = store.ingest(
            version,
            &ops,
            &[(path.clone(), imports)],
            &[(path, mods)],
        )?;
        version = delta.version;
    }

    // Phase 2: enrich + apply — each enricher sees the latest store version
    let enrichers: [&dyn cg_enrich::Enricher; 4] = [
        &cg_enrich::ImportResolver,
        &cg_enrich::CallGraphEnricher,
        &cg_enrich::ImplTraitEnricher,
        &cg_enrich::DataFlowEnricher,
    ];
    for enricher in &enrichers {
        let delta = enricher.enrich(&store);
        if !delta.ops.is_empty() {
            store.apply(&delta)?;
        }
    }

    // Phase 3: export snapshot
    let mut snapshot = store.to_snapshot();
    snapshot.file_count = file_count;

    Ok(snapshot)
}

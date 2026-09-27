//! `codegraph snapshot` — one-shot static graph export.
//!
//! Walks a directory, extracts every `.rs` file, merges definitions and
//! edges into a single [`Snapshot`], and writes pretty JSON to stdout.
//!
//! # Usage
//!
//! ```bash
//! codegraph snapshot [directory] > graph.json
//! ```
//!
//! Then open `web/demo/index.html` in a browser, which fetches `graph.json`
//! and renders the graph with Cytoscape.js.

use std::io::Write;
use std::path::PathBuf;

use clap::Parser;
use cg_extract::{flatten, Extractor, RustExtractor, SourceFile};
use cg_ir::{Lang, Snapshot};

#[derive(Parser)]
#[command(name = "codegraph", about = "Code graph toolchain")]
enum Cli {
    /// Extract a flat, one-shot snapshot of a Rust codebase.
    Snapshot {
        /// Directory to scan for `.rs` files (default: current dir).
        #[arg(default_value = ".")]
        dir: PathBuf,

        /// Write JSON to this file instead of stdout.
        /// Use this on Windows to avoid UTF-16 redirection from `>`.
        #[arg(short, long)]
        output: Option<PathBuf>,
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

            // Write to file or stdout — use a BufWriter for UTF-8 safety.
            let mut writer: Box<dyn Write> = match &output {
                Some(path) => {
                    let file = std::fs::File::create(path)
                        .unwrap_or_else(|e| {
                            eprintln!("error: cannot create {}: {e}", path.display());
                            std::process::exit(1);
                        });
                    Box::new(std::io::BufWriter::new(file))
                }
                None => Box::new(std::io::stdout().lock()),
            };
            serde_json::to_writer_pretty(&mut writer, &snapshot)
                .expect("write JSON");
            // Print stats to stderr so the user sees them even when piping.
            eprintln!(
                "📊 {} files · {} definitions · {} edges \
                 ({} functions, {} structs, {} calls, {} contains)",
                snapshot.file_count,
                snapshot.stats.total_nodes,
                snapshot.stats.total_edges,
                snapshot.stats.function_count,
                snapshot.stats.struct_count,
                snapshot.stats.calls_edge_count,
                snapshot.stats.contains_edge_count,
            );
        }
    }
}

fn run_snapshot(dir: &PathBuf) -> Result<Snapshot, Box<dyn std::error::Error>> {
    let extractor = RustExtractor;
    let mut graphs = Vec::new();

    for entry in walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_entry(|e| {
            // Always include the root; skip hidden dirs and build artifacts.
            if e.depth() == 0 {
                return true;
            }
            if e.file_type().is_dir() {
                let name = e.file_name().to_string_lossy();
                return !(name.starts_with('.')
                    || name == "target"
                    || name == "node_modules"
                    || name == "vendor");
            }
            true
        })
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if path.extension().map(|ext| ext == "rs").unwrap_or(false) {
            let text = std::fs::read_to_string(path)
                .map_err(|e| format!("read {}: {e}", path.display()))?;
            let file = SourceFile {
                path: path.to_path_buf(),
                lang: Lang::Rust,
                text,
            };
            let fg = extractor.extract(&file)?;
            graphs.push(fg);
        }
    }

    Ok(flatten(graphs))
}

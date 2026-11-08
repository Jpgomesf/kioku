//! Retrieval evaluation: graded queries over a note corpus, scored with
//! standard IR metrics so ranking changes are judged on evidence.
//!
//! A dataset is a JSON manifest plus a JSONL file of queries. With a `corpus`
//! directory the harness imports it into isolated storage; without one it runs
//! read-only against an existing domain, so you can evaluate your own notes.
//! Evaluation never records consumption or runs maintenance, so it doesn't
//! change the state it measures.

mod dataset;
mod graph;
mod metrics;
mod report;
mod run;
mod scale;
mod storage;
mod synthetic;

pub use dataset::{Dataset, Query};
pub use graph::{
    Ablation, GraphReport, HubExposure, LinkStats, NoteExposure, SlotPrecision, dropped_links,
    link_stats, shuffled_links,
};
pub use metrics::{
    Interval, QueryResult, Summary, hit_at_1, ndcg_at_k, recall_at_k, reciprocal_rank,
};
pub use report::{Gates, check_thresholds, render_markdown};
pub use run::{
    Calibration, Comparison, ContextReport, EvalOptions, Report, VariantReport, prepare, run,
};
pub use scale::{PathReport, ScaleOptions, ScaleReport, grow, is_prepared, measure, render_scale};
pub use storage::{isolate_storage, isolated_name, reuse_storage};
pub use synthetic::GENERATOR;

use crate::config::Lexical;
use crate::rank::RankOptions;

/// Ranking variants compared by every run, each with where it scores BM25
/// (`None` follows `MEMORY_LEXICAL`). `hybrid+graph` is what MCP clients get
/// by default (`graph_mode = "rerank"`); the last runs it with BM25 in Qdrant.
pub const VARIANTS: [(&str, RankOptions, Option<Lexical>); 4] = [
    ("vector", RankOptions::VECTOR, None),
    ("hybrid", RankOptions::HYBRID, None),
    ("hybrid+graph", RankOptions::HYBRID_GRAPH, None),
    (
        QDRANT_VARIANT,
        RankOptions::HYBRID_GRAPH,
        Some(Lexical::Qdrant),
    ),
];

/// The default ranking with BM25 scored in Qdrant.
const QDRANT_VARIANT: &str = "hybrid+graph, BM25 in Qdrant";

const DEFAULT_VARIANT: &str = "hybrid+graph";

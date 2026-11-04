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
mod storage;

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
pub use storage::{isolate_storage, isolated_name};

use crate::rank::RankOptions;

/// Ranking variants compared by every run. `hybrid+graph` is what MCP clients
/// get by default (`graph_mode = "rerank"`).
pub const VARIANTS: [(&str, RankOptions); 3] = [
    ("vector", RankOptions::VECTOR),
    ("hybrid", RankOptions::HYBRID),
    ("hybrid+graph", RankOptions::HYBRID_GRAPH),
];

const DEFAULT_VARIANT: &str = "hybrid+graph";

//! Scale benchmark: a dataset's graded queries over its domain grown with
//! synthetic distractor notes ([`super::synthetic`]), timed while the server
//! is warm and as the first query of a new process, which is what a
//! short-lived client such as a hook gets.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::time::Instant;

use anyhow::{Context, Result, ensure};
use serde::Serialize;
use serde_json::Value;

use crate::app::{App, SearchRequest};
use crate::config::Config;
use crate::graph;
use crate::model::NoteInput;
use crate::rank::RankOptions;

use super::metrics::Summary;
use super::run::score;
use super::synthetic::{self, GENERATOR};
use super::{Dataset, Query, QueryResult};

/// Notes embedded and saved per batch while growing the domain.
const GROW_BATCH: usize = 512;
/// The `memory_settings` key naming what an isolated database was grown for.
const MARKER: &str = "eval_scale";

pub struct ScaleOptions {
    pub k: usize,
    /// Warm passes over every query; the percentiles pool all of them.
    pub repeats: usize,
}

#[derive(Debug, Serialize)]
pub struct ScaleReport {
    pub dataset: String,
    pub domain: String,
    pub notes: usize,
    pub distractors: usize,
    pub k: usize,
    pub embedding_model: String,
    pub generator: &'static str,
    /// Seconds this run spent growing the storage; absent when it reused it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prepare_seconds: Option<f64>,
    pub paths: Vec<PathReport>,
}

/// One way of running the queries: warm, or the first query of a new process.
#[derive(Debug, Serialize)]
pub struct PathReport {
    pub name: String,
    pub summary: Summary,
    pub samples: usize,
    pub p50_ms: f64,
    pub p95_ms: f64,
    /// Mean milliseconds per search stage, as `kioku search --explain` names them.
    pub stages: BTreeMap<String, f64>,
    /// For a new process, the median time to connect before its first query.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub startup_p50_ms: Option<f64>,
    /// Queries ranked differently than in the first warm pass. Ranking is
    /// deterministic, so anything here is a bug.
    pub changed_rankings: Vec<String>,
    pub queries: Vec<QueryResult>,
}

/// What `memory_settings` records for storage grown to `notes` notes.
pub fn marker(dataset: &Dataset, notes: usize) -> String {
    format!("{GENERATOR}:{}:{notes}", dataset.name)
}

/// Whether the connected storage was grown for `notes` notes of `dataset`.
pub async fn is_prepared(app: &App, dataset: &Dataset, notes: usize) -> Result<bool> {
    Ok(app.store.setting(MARKER).await?.as_deref() == Some(marker(dataset, notes).as_str()))
}

/// Add distractors to the dataset's freshly imported domain until it holds
/// `notes` notes, rebuild its links, and record the marker. Returns how many
/// distractors were added.
pub async fn grow(app: &App, dataset: &Dataset, notes: usize) -> Result<usize> {
    let mut all = app.store.notes(Some(&dataset.domain), true).await?;
    ensure!(
        notes >= all.len(),
        "--scale must be at least the dataset's own {} notes",
        all.len()
    );
    let distractors = notes - all.len();
    let started = Instant::now();
    for start in (0..distractors).step_by(GROW_BATCH) {
        let inputs: Vec<NoteInput> = (start..(start + GROW_BATCH).min(distractors))
            .map(|index| synthetic::distractor(&dataset.domain, index))
            .collect();
        all.extend(app.save_unlinked(&inputs).await?);
        let done = start + inputs.len();
        if done % 10_240 < GROW_BATCH || done == distractors {
            eprintln!(
                "grew {} to {done} distractors in {:.0} s",
                dataset.domain,
                started.elapsed().as_secs_f64()
            );
        }
    }
    let edges = graph::resolve_edges(&all);
    app.store.replace_edges(&dataset.domain, &edges).await?;
    app.store
        .set_setting(MARKER, &marker(dataset, notes))
        .await?;
    Ok(distractors)
}

/// Run every query warm (`repeats` passes after one warm-up pass), then once
/// each as the first query of a new connection to the same storage.
pub async fn measure(
    config: &Config,
    app: &App,
    dataset: &Dataset,
    options: &ScaleOptions,
) -> Result<Vec<PathReport>> {
    let domain = dataset.domain.as_str();
    let mut reference: Vec<QueryResult> = Vec::new();
    for query in &dataset.queries {
        reference.push(search(app, domain, query, options.k).await?.0);
    }
    let mut warm = Samples::default();
    for pass in 0..options.repeats.max(1) {
        for (query, expected) in dataset.queries.iter().zip(&reference) {
            let (result, stages) = search(app, domain, query, options.k).await?;
            warm.add(result, stages, expected, pass == 0);
        }
    }
    let mut cold = Samples::default();
    let mut startups = Vec::new();
    for (query, expected) in dataset.queries.iter().zip(&reference) {
        let started = Instant::now();
        let fresh = App::connect(config.clone()).await?;
        startups.push(elapsed_ms(started));
        let searched = search(&fresh, domain, query, options.k).await;
        fresh.store.close().await;
        let (result, stages) = searched?;
        cold.add(result, stages, expected, true);
    }
    Ok(vec![
        warm.report("warm", None),
        cold.report(
            "first query in a new process",
            Some(percentile(startups, 0.5)),
        ),
    ])
}

/// Results and stage times of one path, pooled over its passes. Quality
/// comes from the first pass.
#[derive(Default)]
struct Samples {
    first: Vec<QueryResult>,
    latencies: Vec<f64>,
    stages: BTreeMap<String, Vec<f64>>,
    changed: Vec<String>,
}

impl Samples {
    fn add(
        &mut self,
        result: QueryResult,
        stages: BTreeMap<String, f64>,
        expected: &QueryResult,
        first_pass: bool,
    ) {
        if result.ranked != expected.ranked && !self.changed.contains(&result.id) {
            self.changed.push(result.id.clone());
        }
        self.latencies.push(result.latency_ms);
        for (stage, ms) in stages {
            self.stages.entry(stage).or_default().push(ms);
        }
        if first_pass {
            self.first.push(result);
        }
    }

    fn report(self, name: &str, startup_p50_ms: Option<f64>) -> PathReport {
        let rows: Vec<&QueryResult> = self.first.iter().collect();
        PathReport {
            name: name.to_owned(),
            summary: Summary::of(&rows),
            samples: self.latencies.len(),
            p50_ms: percentile(self.latencies.clone(), 0.5),
            p95_ms: percentile(self.latencies, 0.95),
            stages: self
                .stages
                .into_iter()
                .map(|(stage, values)| {
                    let mean = values.iter().sum::<f64>() / values.len().max(1) as f64;
                    (stage, mean)
                })
                .collect(),
            startup_p50_ms,
            changed_rankings: self.changed,
            queries: self.first,
        }
    }
}

/// One query as MCP clients run it by default, with its stage times.
async fn search(
    app: &App,
    domain: &str,
    query: &Query,
    k: usize,
) -> Result<(QueryResult, BTreeMap<String, f64>)> {
    let started = Instant::now();
    let results = app
        .search(&SearchRequest {
            query: &query.query,
            domain: Some(domain),
            domains: None,
            limit: k,
            include_legacy: query.include_legacy,
            ranking: RankOptions::HYBRID_GRAPH,
            edges: None,
            viewer: None,
        })
        .await
        .with_context(|| format!("query {} failed", query.id))?;
    let latency = elapsed_ms(started);
    let stages = match serde_json::to_value(&results.stats)? {
        Value::Object(fields) => fields
            .into_iter()
            .filter_map(|(name, value)| {
                Some((name.strip_suffix("_ms")?.to_owned(), value.as_f64()?))
            })
            .collect(),
        _ => BTreeMap::new(),
    };
    Ok((score(query, &results.hits, k, latency), stages))
}

fn elapsed_ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

/// The same nearest-rank rule as [`Summary`]'s percentiles.
fn percentile(mut values: Vec<f64>, p: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(f64::total_cmp);
    values[((values.len() - 1) as f64 * p).round() as usize]
}

/// Render a scale report as Markdown.
pub fn render_scale(report: &ScaleReport) -> String {
    let mut out = String::new();
    let k = report.k;
    let _ = writeln!(
        out,
        "Scale: dataset `{}` grown to {} notes ({} synthetic, `{}`), k = {k}, embeddings `{}`{}\n",
        report.dataset,
        report.notes,
        report.distractors,
        report.generator,
        report.embedding_model,
        report
            .prepare_seconds
            .map(|s| format!(", grown in {s:.0} s"))
            .unwrap_or_default()
    );
    let _ = writeln!(
        out,
        "| path | recall@{k} | nDCG@{k} | MRR | samples | p50 ms | p95 ms | mean ms per stage | changed rankings |\n|---|---|---|---|---|---|---|---|---|"
    );
    for path in &report.paths {
        let mut stages: Vec<String> = path
            .stages
            .iter()
            .map(|(stage, ms)| format!("{stage} {ms:.1}"))
            .collect();
        if let Some(startup) = path.startup_p50_ms {
            stages.insert(0, format!("startup p50 {startup:.1}"));
        }
        let _ = writeln!(
            out,
            "| {} | {:.3} | {:.3} | {:.3} | {} | {:.1} | {:.1} | {} | {} |",
            path.name,
            path.summary.recall,
            path.summary.ndcg,
            path.summary.mrr,
            path.samples,
            path.p50_ms,
            path.p95_ms,
            stages.join(", "),
            path.changed_rankings.len()
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentiles_use_the_nearest_rank() {
        let values: Vec<f64> = (1..=20).map(f64::from).collect();
        assert_eq!(percentile(values.clone(), 0.5), 11.0);
        assert_eq!(percentile(values, 0.95), 19.0);
        assert_eq!(percentile(Vec::new(), 0.5), 0.0);
    }
}

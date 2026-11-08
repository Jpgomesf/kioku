//! Running every ranking variant over a dataset and comparing them.

use std::collections::BTreeMap;
use std::time::Instant;

use anyhow::{Context, Result, bail, ensure};
use serde::Serialize;

use crate::app::{App, ContextRequest, SearchHit, SearchRequest};
use crate::config::Lexical;
use crate::model::{Edge, NoteInput};
use crate::rank::{MatchKind, RankOptions};

use super::graph::{
    Ablation, GraphReport, dropped_links, hub_exposure, link_stats, shuffled_links, slot_precision,
};
use super::metrics::Interval;
use super::{
    DEFAULT_VARIANT, Dataset, QDRANT_VARIANT, Query, QueryResult, Summary, VARIANTS, hit_at_1,
    ndcg_at_k, recall_at_k, reciprocal_rank,
};

/// Seeds for each ablation; results are averaged per query across them.
const ABLATION_SEEDS: [u64; 5] = [1, 2, 3, 4, 5];
/// Fixed seed for bootstrap intervals, so the same run gives the same report.
const BOOTSTRAP_SEED: u64 = 20_261_104;

#[derive(Debug, Serialize)]
pub struct VariantReport {
    pub name: String,
    pub overall: Summary,
    /// Bootstrap interval for mean nDCG over graded queries.
    pub ndcg_ci: Interval,
    /// Mean nDCG of the per-category means, so large easy categories do not
    /// dominate the average.
    pub macro_ndcg: f64,
    pub by_category: BTreeMap<String, Summary>,
    pub queries: Vec<QueryResult>,
}

/// Paired per-query comparison of nDCG against another variant.
#[derive(Debug, Serialize)]
pub struct Comparison {
    pub variant: String,
    pub baseline: String,
    pub wins: usize,
    pub losses: usize,
    pub ties: usize,
    /// Mean per-query nDCG difference (variant minus baseline) with a paired
    /// bootstrap interval. Treat it as real only when the interval excludes 0.
    pub delta: Interval,
}

#[derive(Debug, Serialize)]
pub struct ContextReport {
    pub variant: String,
    pub budget_utf8_bytes: usize,
    pub checked: usize,
    pub sufficient: usize,
    pub failures: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct Report {
    pub dataset: String,
    pub domain: String,
    pub k: usize,
    pub embedding_model: String,
    pub variants: Vec<VariantReport>,
    pub comparisons: Vec<Comparison>,
    /// Whether context packs hold every expected fact, per budget.
    pub context: Vec<ContextReport>,
    pub graph: GraphReport,
    /// Highest dense similarity for unanswerable queries versus the lowest
    /// top-1 similarity for answerable ones. Overlap means a similarity
    /// threshold alone cannot decide when to answer "nothing found".
    pub abstention_calibration: Option<Calibration>,
}

#[derive(Debug, Serialize)]
pub struct Calibration {
    pub max_unanswerable_top_dense: f64,
    pub min_answerable_top_dense: f64,
    pub separable: bool,
}

impl Report {
    pub fn variant(&self, name: &str) -> Option<&VariantReport> {
        self.variants.iter().find(|v| v.name == name)
    }

    pub fn default_variant(&self) -> Option<&VariantReport> {
        self.variant(DEFAULT_VARIANT)
    }
}

pub struct EvalOptions {
    pub k: usize,
    pub context_budgets: Vec<usize>,
}

/// Prepare the dataset's domain: import the corpus and retire the listed keys.
pub async fn prepare(app: &App, dataset: &Dataset) -> Result<()> {
    let Some(corpus) = &dataset.corpus else {
        return Ok(());
    };
    let report = app.ingest(corpus, &dataset.domain).await?;
    if let Some(first) = report.failed.first() {
        bail!(
            "{} corpus file(s) could not be imported, so the results would not be comparable (first: {}: {})",
            report.failed.len(),
            first.path,
            first.reason
        );
    }
    for key in &dataset.retire {
        let id = NoteInput::id_for(&dataset.domain, key);
        app.set_legacy(id, true, Some(&dataset.domain))
            .await
            .with_context(|| format!("cannot retire {key}"))?;
    }
    Ok(())
}

pub async fn run(app: &App, dataset: &Dataset, options: &EvalOptions) -> Result<Report> {
    ensure!((1..=20).contains(&options.k), "k must be between 1 and 20");
    let mut variants = Vec::new();
    for (name, ranking, lexical) in VARIANTS {
        let results = run_queries(app, dataset, options, ranking, None, lexical).await?;
        variants.push(variant_report(name, results));
    }

    let comparisons = [
        ("hybrid", "vector"),
        (DEFAULT_VARIANT, "vector"),
        (DEFAULT_VARIANT, "hybrid"),
        (QDRANT_VARIANT, DEFAULT_VARIANT),
    ]
    .iter()
    .filter_map(|(variant, baseline)| {
        let variant = variants.iter().find(|v| v.name == *variant)?;
        let baseline = variants.iter().find(|v| v.name == *baseline)?;
        Some(compare(variant, baseline))
    })
    .collect();
    let mut context = Vec::new();
    for budget in &options.context_budgets {
        context.push(context_sufficiency(app, dataset, *budget).await?);
    }
    let calibration = calibrate(variants.iter().find(|v| v.name == "vector"));
    let graph = graph_report(app, dataset, options, &variants).await?;
    Ok(Report {
        dataset: dataset.name.clone(),
        domain: dataset.domain.clone(),
        k: options.k,
        embedding_model: app.config.embedding_model.clone(),
        variants,
        comparisons,
        context,
        graph,
        abstention_calibration: calibration,
    })
}

/// Rank every query once with `ranking`, optionally replacing the stored links.
async fn run_queries(
    app: &App,
    dataset: &Dataset,
    options: &EvalOptions,
    ranking: RankOptions,
    edges: Option<&[Edge]>,
    lexical: Option<Lexical>,
) -> Result<Vec<QueryResult>> {
    let mut results = Vec::new();
    for query in &dataset.queries {
        let started = Instant::now();
        let hits = app
            .search(&SearchRequest {
                query: &query.query,
                domain: Some(&dataset.domain),
                domains: None,
                limit: options.k,
                include_legacy: query.include_legacy,
                ranking,
                edges,
                viewer: None,
                lexical,
            })
            .await
            .with_context(|| format!("query {} failed", query.id))?
            .hits;
        let latency_ms = started.elapsed().as_secs_f64() * 1000.0;
        results.push(score(query, &hits, options.k, latency_ms));
    }
    Ok(results)
}

/// Score one query's results against its graded notes.
pub(super) fn score(query: &Query, hits: &[SearchHit], k: usize, latency_ms: f64) -> QueryResult {
    let ranked: Vec<String> = hits.iter().map(|h| h.key.clone()).collect();
    let graded = !query.relevant.is_empty();
    QueryResult {
        id: query.id.clone(),
        category: query.category.clone(),
        linked: hits
            .iter()
            .filter(|h| h.kind == MatchKind::Link)
            .map(|h| h.key.clone())
            .collect(),
        recall: graded.then(|| recall_at_k(&ranked, &query.relevant, k)),
        reciprocal_rank: graded.then(|| reciprocal_rank(&ranked, &query.relevant)),
        ndcg: graded.then(|| ndcg_at_k(&ranked, &query.relevant, k)),
        hit_at_1: graded.then(|| hit_at_1(&ranked, &query.relevant)),
        complete_support: (!query.required.is_empty()).then(|| {
            query
                .required
                .iter()
                .all(|key| ranked.iter().take(k).any(|r| r == key))
        }),
        leaked: query
            .forbidden
            .iter()
            .filter(|key| ranked.contains(key))
            .cloned()
            .collect(),
        top_dense: hits.iter().filter_map(|h| h.signals.dense).reduce(f64::max),
        ranked,
        latency_ms,
    }
}

fn variant_report(name: &str, results: Vec<QueryResult>) -> VariantReport {
    let all: Vec<&QueryResult> = results.iter().collect();
    let mut by_category: BTreeMap<String, Vec<&QueryResult>> = BTreeMap::new();
    for result in &results {
        by_category
            .entry(result.category.clone())
            .or_default()
            .push(result);
    }
    let by_category: BTreeMap<String, Summary> = by_category
        .into_iter()
        .map(|(category, rows)| (category, Summary::of(&rows)))
        .collect();
    let category_means: Vec<f64> = by_category
        .values()
        .filter(|s| s.queries > 0)
        .map(|s| s.ndcg)
        .collect();
    let ndcgs: Vec<f64> = results.iter().filter_map(|r| r.ndcg).collect();
    VariantReport {
        name: name.to_owned(),
        overall: Summary::of(&all),
        ndcg_ci: Interval::bootstrap_mean(&ndcgs, BOOTSTRAP_SEED),
        macro_ndcg: if category_means.is_empty() {
            0.0
        } else {
            category_means.iter().sum::<f64>() / category_means.len() as f64
        },
        by_category,
        queries: results,
    }
}

/// Paired per-query nDCG differences, `variant - baseline`, over graded queries.
fn ndcg_differences(variant: &[QueryResult], baseline: &[QueryResult]) -> Vec<f64> {
    variant
        .iter()
        .zip(baseline)
        .filter_map(|(a, b)| Some(a.ndcg? - b.ndcg?))
        .collect()
}

fn compare(variant: &VariantReport, baseline: &VariantReport) -> Comparison {
    let differences = ndcg_differences(&variant.queries, &baseline.queries);
    let wins = differences.iter().filter(|d| **d > 1e-9).count();
    let losses = differences.iter().filter(|d| **d < -1e-9).count();
    Comparison {
        variant: variant.name.clone(),
        baseline: baseline.name.clone(),
        wins,
        losses,
        ties: differences.len() - wins - losses,
        delta: Interval::bootstrap_mean(&differences, BOOTSTRAP_SEED),
    }
}

/// Link statistics, slot precision, hub exposure, and link ablations.
async fn graph_report(
    app: &App,
    dataset: &Dataset,
    options: &EvalOptions,
    variants: &[VariantReport],
) -> Result<GraphReport> {
    let domain = Some(dataset.domain.as_str());
    let all_notes = app.store.notes(domain, true).await?;
    let active: Vec<String> = app
        .store
        .notes(domain, false)
        .await?
        .into_iter()
        .map(|n| n.input.key)
        .collect();
    let edges = app.store.edges(domain).await?;
    let default = variants
        .iter()
        .find(|v| v.name == DEFAULT_VARIANT)
        .context("the default variant did not run")?;
    let hybrid = variants
        .iter()
        .find(|v| v.name == "hybrid")
        .context("the hybrid variant did not run")?;

    let mut ablations = Vec::new();
    for (name, fraction) in [
        ("shuffled links", None),
        ("half of links dropped", Some(0.5)),
    ] {
        let mut runs = Vec::new();
        for seed in ABLATION_SEEDS {
            let altered = match fraction {
                None => shuffled_links(&edges, seed),
                Some(fraction) => dropped_links(&edges, fraction, seed),
            };
            runs.push(
                run_queries(
                    app,
                    dataset,
                    options,
                    RankOptions::HYBRID_GRAPH,
                    Some(&altered),
                    None,
                )
                .await?,
            );
        }
        ablations.push(ablation(name, &runs, &default.queries));
    }

    Ok(GraphReport {
        links: link_stats(&all_notes),
        slot_precision: slot_precision(
            DEFAULT_VARIANT,
            &default.queries,
            (&hybrid.name, &hybrid.queries),
            &dataset.queries,
        ),
        hub_exposure: variants
            .iter()
            .map(|v| hub_exposure(&v.name, &v.queries, &dataset.queries, &active, options.k))
            .collect(),
        ablations,
    })
}

/// Average each query's metrics over the seeded runs, then compare with the
/// default ranking query by query.
fn ablation(name: &str, runs: &[Vec<QueryResult>], default: &[QueryResult]) -> Ablation {
    let per_query = |pick: &dyn Fn(&QueryResult) -> Option<f64>| -> Vec<Option<f64>> {
        (0..default.len())
            .map(|i| {
                let values: Vec<f64> = runs.iter().filter_map(|run| pick(&run[i])).collect();
                (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
            })
            .collect()
    };
    let ndcg = per_query(&|r| r.ndcg);
    let recall = per_query(&|r| r.recall);
    let support = per_query(&|r| r.complete_support.map(|c| f64::from(u8::from(c))));
    let mean = |values: &[Option<f64>]| -> Option<f64> {
        let present: Vec<f64> = values.iter().flatten().copied().collect();
        (!present.is_empty()).then(|| present.iter().sum::<f64>() / present.len() as f64)
    };
    let graded: Vec<f64> = ndcg.iter().flatten().copied().collect();
    let differences: Vec<f64> = ndcg
        .iter()
        .zip(default)
        .filter_map(|(a, b)| Some((*a)? - b.ndcg?))
        .collect();
    Ablation {
        name: name.to_owned(),
        seeds: ABLATION_SEEDS.to_vec(),
        ndcg: Interval::bootstrap_mean(&graded, BOOTSTRAP_SEED),
        recall: mean(&recall).unwrap_or(0.0),
        complete_support: mean(&support),
        delta_vs_default: Interval::bootstrap_mean(&differences, BOOTSTRAP_SEED),
    }
}

fn calibrate(vector: Option<&VariantReport>) -> Option<Calibration> {
    let vector = vector?;
    let unanswerable = vector
        .queries
        .iter()
        .filter(|r| r.ndcg.is_none())
        .filter_map(|r| r.top_dense)
        .reduce(f64::max)?;
    let answerable = vector
        .queries
        .iter()
        .filter(|r| r.ndcg.is_some())
        .filter_map(|r| r.top_dense)
        .reduce(f64::min)?;
    Some(Calibration {
        max_unanswerable_top_dense: unanswerable,
        min_answerable_top_dense: answerable,
        separable: unanswerable < answerable,
    })
}

async fn context_sufficiency(app: &App, dataset: &Dataset, budget: usize) -> Result<ContextReport> {
    let mut checked = 0;
    let mut failures = Vec::new();
    for query in dataset.queries.iter().filter(|q| !q.answer.is_empty()) {
        checked += 1;
        let pack = app
            .context(&ContextRequest {
                query: Some(&query.query),
                ids: None,
                domain: Some(&dataset.domain),
                budget,
                include_legacy: query.include_legacy,
                ranking: RankOptions::HYBRID_GRAPH,
                record_access: false,
                viewer: None,
                with_aliases: false,
            })
            .await
            .with_context(|| format!("context for {} failed", query.id))?;
        let text = pack.text().to_lowercase();
        if !query
            .answer
            .iter()
            .all(|fact| text.contains(&fact.to_lowercase()))
        {
            failures.push(query.id.clone());
        }
    }
    Ok(ContextReport {
        variant: DEFAULT_VARIANT.to_owned(),
        budget_utf8_bytes: budget,
        sufficient: checked - failures.len(),
        checked,
        failures,
    })
}

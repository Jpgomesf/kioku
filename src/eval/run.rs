//! Running every ranking variant over a dataset and comparing them.

use std::collections::BTreeMap;
use std::time::Instant;

use anyhow::{Context, Result, ensure};
use serde::Serialize;

use crate::app::{App, ContextRequest, SearchRequest};
use crate::model::NoteInput;
use crate::rank::RankOptions;

use super::{
    DEFAULT_VARIANT, Dataset, QueryResult, Summary, VARIANTS, hit_at_1, ndcg_at_k, recall_at_k,
    reciprocal_rank,
};

#[derive(Debug, Serialize)]
pub struct VariantReport {
    pub name: String,
    pub overall: Summary,
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
    pub context: ContextReport,
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
    pub context_budget: usize,
}

/// Prepare the dataset's domain: import the corpus and retire the listed keys.
pub async fn prepare(app: &App, dataset: &Dataset) -> Result<()> {
    let Some(corpus) = &dataset.corpus else {
        return Ok(());
    };
    app.ingest(corpus, &dataset.domain).await?;
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
    for (name, ranking) in VARIANTS {
        let mut results = Vec::new();
        for query in &dataset.queries {
            let started = Instant::now();
            let hits = app
                .search(&SearchRequest {
                    query: &query.query,
                    domain: Some(&dataset.domain),
                    limit: options.k,
                    include_legacy: query.include_legacy,
                    ranking,
                })
                .await
                .with_context(|| format!("query {} failed", query.id))?
                .hits;
            let latency_ms = started.elapsed().as_secs_f64() * 1000.0;
            let ranked: Vec<String> = hits.iter().map(|h| h.key.clone()).collect();
            let graded = !query.relevant.is_empty();
            results.push(QueryResult {
                id: query.id.clone(),
                category: query.category.clone(),
                recall: graded.then(|| recall_at_k(&ranked, &query.relevant, options.k)),
                reciprocal_rank: graded.then(|| reciprocal_rank(&ranked, &query.relevant)),
                ndcg: graded.then(|| ndcg_at_k(&ranked, &query.relevant, options.k)),
                hit_at_1: graded.then(|| hit_at_1(&ranked, &query.relevant)),
                leaked: query
                    .forbidden
                    .iter()
                    .filter(|key| ranked.contains(key))
                    .cloned()
                    .collect(),
                top_dense: hits.iter().filter_map(|h| h.signals.dense).reduce(f64::max),
                ranked,
                latency_ms,
            });
        }
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
        let graded: Vec<f64> = by_category
            .values()
            .filter(|s| s.queries > 0)
            .map(|s| s.ndcg)
            .collect();
        variants.push(VariantReport {
            name: name.to_owned(),
            overall: Summary::of(&all),
            macro_ndcg: if graded.is_empty() {
                0.0
            } else {
                graded.iter().sum::<f64>() / graded.len() as f64
            },
            by_category,
            queries: results,
        });
    }

    let comparisons = compare_all(&variants);
    let context = context_sufficiency(app, dataset, options).await?;
    let calibration = calibrate(variants.iter().find(|v| v.name == "vector"));
    Ok(Report {
        dataset: dataset.name.clone(),
        domain: dataset.domain.clone(),
        k: options.k,
        embedding_model: app.config.embedding_model.clone(),
        variants,
        comparisons,
        context,
        abstention_calibration: calibration,
    })
}

fn compare_all(variants: &[VariantReport]) -> Vec<Comparison> {
    let Some(baseline) = variants.first() else {
        return Vec::new();
    };
    variants[1..]
        .iter()
        .map(|variant| {
            let (mut wins, mut losses, mut ties) = (0, 0, 0);
            for (a, b) in variant.queries.iter().zip(&baseline.queries) {
                let (Some(a), Some(b)) = (a.ndcg, b.ndcg) else {
                    continue;
                };
                if (a - b).abs() < 1e-9 {
                    ties += 1;
                } else if a > b {
                    wins += 1;
                } else {
                    losses += 1;
                }
            }
            Comparison {
                variant: variant.name.clone(),
                baseline: baseline.name.clone(),
                wins,
                losses,
                ties,
            }
        })
        .collect()
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

async fn context_sufficiency(
    app: &App,
    dataset: &Dataset,
    options: &EvalOptions,
) -> Result<ContextReport> {
    let mut checked = 0;
    let mut failures = Vec::new();
    for query in dataset.queries.iter().filter(|q| !q.answer.is_empty()) {
        checked += 1;
        let pack = app
            .context(&ContextRequest {
                query: Some(&query.query),
                ids: None,
                domain: Some(&dataset.domain),
                budget: options.context_budget,
                include_legacy: query.include_legacy,
                ranking: RankOptions::HYBRID_GRAPH,
                record_access: false,
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
        budget_utf8_bytes: options.context_budget,
        sufficient: checked - failures.len(),
        checked,
        failures,
    })
}

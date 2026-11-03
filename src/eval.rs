//! Retrieval evaluation: graded queries over a note corpus, scored with
//! standard IR metrics so ranking changes are judged on evidence.
//!
//! A dataset is a JSON manifest plus a JSONL file of queries. With a `corpus`
//! directory the harness imports it into isolated storage; without one it runs
//! read-only against an existing domain, so you can evaluate your own notes.
//! Evaluation never records consumption or runs maintenance, so it doesn't
//! change the state it measures.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};

use crate::app::{App, ContextRequest, SearchRequest};
use crate::config::Config;
use crate::model::NoteInput;
use crate::rank::RankOptions;
use crate::vector::Qdrant;

/// Ranking variants compared by every run. `hybrid+graph` is what MCP clients
/// get by default (`graph_mode = "rerank"`).
pub const VARIANTS: [(&str, RankOptions); 3] = [
    ("vector", RankOptions::VECTOR),
    ("hybrid", RankOptions::HYBRID),
    ("hybrid+graph", RankOptions::HYBRID_GRAPH),
];
const DEFAULT_VARIANT: &str = "hybrid+graph";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    name: String,
    #[serde(default)]
    description: String,
    domain: String,
    #[serde(default)]
    corpus: Option<PathBuf>,
    queries: PathBuf,
    #[serde(default)]
    retire: Vec<String>,
}

/// One graded query. `relevant` maps note keys to grades: 2 answers the
/// question, 1 is useful supporting context. An empty map means nothing in the
/// corpus answers it, which measures abstention.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Query {
    pub id: String,
    pub category: String,
    pub query: String,
    #[serde(default)]
    pub relevant: BTreeMap<String, u8>,
    /// Facts that a context pack for this query must contain (case-insensitive).
    #[serde(default)]
    pub answer: Vec<String>,
    #[serde(default)]
    pub include_legacy: bool,
    /// Keys that must never appear in the top k, such as a retired runbook.
    #[serde(default)]
    pub forbidden: Vec<String>,
}

#[derive(Debug)]
pub struct Dataset {
    pub name: String,
    pub description: String,
    pub domain: String,
    pub corpus: Option<PathBuf>,
    pub retire: Vec<String>,
    pub queries: Vec<Query>,
}

impl Dataset {
    pub fn load(manifest: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(manifest)
            .with_context(|| format!("cannot read dataset manifest {}", manifest.display()))?;
        let m: Manifest = serde_json::from_str(&text).context("invalid dataset manifest")?;
        let base = manifest.parent().unwrap_or_else(|| Path::new("."));
        let queries_path = base.join(&m.queries);
        let mut queries = Vec::new();
        let lines = std::fs::read_to_string(&queries_path)
            .with_context(|| format!("cannot read queries {}", queries_path.display()))?;
        for (number, line) in lines.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let query: Query = serde_json::from_str(line)
                .with_context(|| format!("invalid query on line {}", number + 1))?;
            ensure!(
                query.relevant.values().all(|grade| (1..=3).contains(grade)),
                "query {} has a relevance grade outside 1..=3",
                query.id
            );
            queries.push(query);
        }
        ensure!(!queries.is_empty(), "dataset has no queries");
        let mut ids = std::collections::HashSet::new();
        for query in &queries {
            ensure!(ids.insert(&query.id), "duplicate query id {}", query.id);
        }
        Ok(Self {
            name: m.name,
            description: m.description,
            domain: m.domain,
            corpus: m.corpus.map(|corpus| base.join(corpus)),
            retire: m.retire,
            queries,
        })
    }
}

/// Recall@k: the fraction of relevant notes that appear in the top k.
pub fn recall_at_k(ranked: &[String], relevant: &BTreeMap<String, u8>, k: usize) -> f64 {
    if relevant.is_empty() {
        return 0.0;
    }
    let top = &ranked[..ranked.len().min(k)];
    relevant.keys().filter(|key| top.contains(key)).count() as f64 / relevant.len() as f64
}

/// Reciprocal rank of the first relevant note, or 0 if none was returned.
pub fn reciprocal_rank(ranked: &[String], relevant: &BTreeMap<String, u8>) -> f64 {
    ranked
        .iter()
        .position(|key| relevant.contains_key(key))
        .map_or(0.0, |index| 1.0 / (index as f64 + 1.0))
}

/// nDCG@k with exponential gain (2^grade - 1).
pub fn ndcg_at_k(ranked: &[String], relevant: &BTreeMap<String, u8>, k: usize) -> f64 {
    let dcg = |grades: &mut dyn Iterator<Item = u8>| -> f64 {
        grades
            .take(k)
            .enumerate()
            .map(|(i, grade)| (2f64.powi(i32::from(grade)) - 1.0) / (i as f64 + 2.0).log2())
            .sum()
    };
    let actual = dcg(&mut ranked
        .iter()
        .map(|key| relevant.get(key).copied().unwrap_or(0)));
    let mut ideal_grades: Vec<u8> = relevant.values().copied().collect();
    ideal_grades.sort_unstable_by(|a, b| b.cmp(a));
    let ideal = dcg(&mut ideal_grades.into_iter());
    if ideal == 0.0 { 0.0 } else { actual / ideal }
}

/// Whether the first result is one of the best-graded notes.
pub fn hit_at_1(ranked: &[String], relevant: &BTreeMap<String, u8>) -> bool {
    let best = relevant.values().copied().max().unwrap_or(0);
    ranked
        .first()
        .and_then(|key| relevant.get(key))
        .is_some_and(|grade| *grade == best)
}

#[derive(Debug, Clone, Serialize)]
pub struct QueryResult {
    pub id: String,
    pub category: String,
    pub ranked: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recall: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reciprocal_rank: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ndcg: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hit_at_1: Option<bool>,
    pub leaked: Vec<String>,
    /// Highest dense similarity among the results, for abstention calibration.
    pub top_dense: Option<f64>,
    pub latency_ms: f64,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Summary {
    pub queries: usize,
    pub recall: f64,
    pub mrr: f64,
    pub ndcg: f64,
    pub hit_at_1: f64,
    pub leaks: usize,
    pub abstention_queries: usize,
    pub abstained: usize,
    pub p50_ms: f64,
    pub p95_ms: f64,
}

impl Summary {
    fn of(results: &[&QueryResult]) -> Self {
        let graded: Vec<&&QueryResult> = results.iter().filter(|r| r.ndcg.is_some()).collect();
        let mean = |f: &dyn Fn(&QueryResult) -> f64| -> f64 {
            if graded.is_empty() {
                0.0
            } else {
                graded.iter().map(|r| f(r)).sum::<f64>() / graded.len() as f64
            }
        };
        let abstention: Vec<_> = results.iter().filter(|r| r.ndcg.is_none()).collect();
        let mut latencies: Vec<f64> = results.iter().map(|r| r.latency_ms).collect();
        latencies.sort_by(f64::total_cmp);
        let percentile = |p: f64| -> f64 {
            if latencies.is_empty() {
                0.0
            } else {
                latencies[((latencies.len() - 1) as f64 * p).round() as usize]
            }
        };
        Self {
            queries: graded.len(),
            recall: mean(&|r| r.recall.unwrap_or(0.0)),
            mrr: mean(&|r| r.reciprocal_rank.unwrap_or(0.0)),
            ndcg: mean(&|r| r.ndcg.unwrap_or(0.0)),
            hit_at_1: mean(&|r| f64::from(u8::from(r.hit_at_1.unwrap_or(false)))),
            leaks: results.iter().filter(|r| !r.leaked.is_empty()).count(),
            abstention_queries: abstention.len(),
            abstained: abstention.iter().filter(|r| r.ranked.is_empty()).count(),
            p50_ms: percentile(0.5),
            p95_ms: percentile(0.95),
        }
    }
}

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

/// `<base>_eval_<model>` with characters PostgreSQL and Qdrant both accept,
/// at most `max_len` bytes. Separate names per embedding model let you
/// compare models side by side.
pub fn isolated_name(base: &str, model: &str, max_len: usize) -> String {
    let slug = |text: &str| -> String {
        let mut out = String::new();
        for c in text.chars().flat_map(char::to_lowercase) {
            if c.is_ascii_alphanumeric() {
                out.push(c);
            } else if !out.ends_with('_') {
                out.push('_');
            }
        }
        out.trim_matches('_').to_owned()
    };
    let mut name = format!("{}_eval_{}", slug(base), slug(model));
    name.truncate(max_len);
    name.trim_end_matches('_').to_owned()
}

fn is_disposable(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 63
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        && (name.contains("eval") || name.contains("test"))
}

/// Point `config` at a freshly recreated database and Qdrant collection, so a
/// fixture corpus never touches real memories. Both names must contain
/// "eval" or "test" and differ from the configured ones.
pub async fn isolate_storage(config: &mut Config, database: &str, collection: &str) -> Result<()> {
    use sqlx::Connection;

    let live_database = config.database_name()?;
    ensure!(
        is_disposable(database) && database != live_database,
        "evaluation database {database:?} must be lowercase, contain eval or test, and differ from {live_database:?}"
    );
    ensure!(
        is_disposable(collection) && collection != config.collection,
        "evaluation collection {collection:?} must be lowercase, contain eval or test, and differ from {:?}",
        config.collection
    );
    let mut admin = sqlx::PgConnection::connect(&config.database_url)
        .await
        .context("cannot connect to PostgreSQL to prepare the evaluation database")?;
    // Audited: both names were validated above to contain only [a-z0-9_].
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "DROP DATABASE IF EXISTS \"{database}\" WITH (FORCE)"
    )))
    .execute(&mut admin)
    .await
    .context("cannot drop the previous evaluation database")?;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "CREATE DATABASE \"{database}\""
    )))
    .execute(&mut admin)
    .await
    .context("cannot create the evaluation database")?;
    admin.close().await?;
    config.database_url = config.with_database(database)?;
    Qdrant::new(
        &config.qdrant_url,
        collection,
        config.qdrant_api_key.clone(),
        config.embedding_dim,
    )?
    .delete_collection()
    .await?;
    config.collection = collection.to_owned();
    Ok(())
}

/// Fail when the default variant drops below the given floors.
pub fn check_thresholds(
    report: &Report,
    min_ndcg: Option<f64>,
    min_recall: Option<f64>,
) -> Result<()> {
    let Some(default) = report.default_variant() else {
        bail!("report has no {DEFAULT_VARIANT} variant");
    };
    if let Some(min) = min_ndcg {
        ensure!(
            default.overall.ndcg >= min,
            "nDCG@{} {:.3} is below the required {min:.3}",
            report.k,
            default.overall.ndcg
        );
    }
    if let Some(min) = min_recall {
        ensure!(
            default.overall.recall >= min,
            "recall@{} {:.3} is below the required {min:.3}",
            report.k,
            default.overall.recall
        );
    }
    Ok(())
}

/// Render the report as Markdown tables.
pub fn render_markdown(report: &Report) -> String {
    let mut out = String::new();
    let k = report.k;
    let _ = writeln!(
        out,
        "Dataset `{}` (domain `{}`), k = {k}, embeddings `{}`\n",
        report.dataset, report.domain, report.embedding_model
    );
    let _ = writeln!(
        out,
        "| variant | recall@{k} | MRR | nDCG@{k} | macro nDCG | hit@1 | leaks | p50 ms |\n|---|---|---|---|---|---|---|---|"
    );
    for v in &report.variants {
        let s = &v.overall;
        let _ = writeln!(
            out,
            "| {} | {:.3} | {:.3} | {:.3} | {:.3} | {:.3} | {} | {:.1} |",
            v.name, s.recall, s.mrr, s.ndcg, v.macro_ndcg, s.hit_at_1, s.leaks, s.p50_ms
        );
    }
    let categories: Vec<&String> = report
        .variants
        .first()
        .map(|v| {
            v.by_category
                .keys()
                .filter(|c| v.by_category[*c].queries > 0)
                .collect()
        })
        .unwrap_or_default();
    let _ = writeln!(out, "\nnDCG@{k} by category\n");
    let _ = writeln!(
        out,
        "| category | {} |\n|---|{}",
        report
            .variants
            .iter()
            .map(|v| v.name.as_str())
            .collect::<Vec<_>>()
            .join(" | "),
        "---|".repeat(report.variants.len())
    );
    for category in categories {
        let n = report.variants[0].by_category[category].queries;
        let cells: Vec<String> = report
            .variants
            .iter()
            .map(|v| format!("{:.3}", v.by_category[category].ndcg))
            .collect();
        let _ = writeln!(out, "| {category} ({n}) | {} |", cells.join(" | "));
    }
    let _ = writeln!(out);
    for c in &report.comparisons {
        let _ = writeln!(
            out,
            "- `{}` vs `{}` (per-query nDCG): {} better, {} worse, {} tied",
            c.variant, c.baseline, c.wins, c.losses, c.ties
        );
    }
    let ctx = &report.context;
    let _ = writeln!(
        out,
        "- Context packs ({} bytes, `{}`) contained every expected fact for {}/{} queries{}",
        ctx.budget_utf8_bytes,
        ctx.variant,
        ctx.sufficient,
        ctx.checked,
        if ctx.failures.is_empty() {
            String::new()
        } else {
            format!("; missing: {}", ctx.failures.join(", "))
        }
    );
    if let Some(cal) = &report.abstention_calibration {
        let _ = writeln!(
            out,
            "- Abstention: unanswerable queries reach dense similarity {:.3}; answerable ones go as low as {:.3} ({})",
            cal.max_unanswerable_top_dense,
            cal.min_answerable_top_dense,
            if cal.separable {
                "a threshold can separate them"
            } else {
                "no similarity threshold separates them"
            }
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    fn grades(items: &[(&str, u8)]) -> BTreeMap<String, u8> {
        items.iter().map(|(k, g)| ((*k).to_owned(), *g)).collect()
    }

    #[test]
    fn perfect_ranking_scores_one() {
        let rel = grades(&[("a", 2), ("b", 1)]);
        let ranked = keys(&["a", "b", "c"]);
        assert_eq!(recall_at_k(&ranked, &rel, 5), 1.0);
        assert_eq!(reciprocal_rank(&ranked, &rel), 1.0);
        assert!((ndcg_at_k(&ranked, &rel, 5) - 1.0).abs() < 1e-12);
        assert!(hit_at_1(&ranked, &rel));
    }

    #[test]
    fn swapped_grades_lower_ndcg_but_not_recall() {
        let rel = grades(&[("a", 2), ("b", 1)]);
        let swapped = keys(&["b", "a"]);
        assert_eq!(recall_at_k(&swapped, &rel, 5), 1.0);
        assert_eq!(reciprocal_rank(&swapped, &rel), 1.0);
        let ndcg = ndcg_at_k(&swapped, &rel, 5);
        assert!(ndcg < 1.0 && ndcg > 0.5, "{ndcg}");
        assert!(!hit_at_1(&swapped, &rel));
    }

    #[test]
    fn misses_and_cutoffs() {
        let rel = grades(&[("a", 2)]);
        assert_eq!(reciprocal_rank(&keys(&["x", "y", "a"]), &rel), 1.0 / 3.0);
        assert_eq!(recall_at_k(&keys(&["x", "y", "a"]), &rel, 2), 0.0);
        assert_eq!(ndcg_at_k(&keys(&["x", "y", "a"]), &rel, 2), 0.0);
        assert_eq!(reciprocal_rank(&[], &rel), 0.0);
        assert_eq!(ndcg_at_k(&[], &BTreeMap::new(), 5), 0.0);
    }

    #[test]
    fn summary_separates_abstention_queries() {
        let graded = QueryResult {
            id: "q1".into(),
            category: "c".into(),
            ranked: keys(&["a"]),
            recall: Some(1.0),
            reciprocal_rank: Some(1.0),
            ndcg: Some(1.0),
            hit_at_1: Some(true),
            leaked: Vec::new(),
            top_dense: Some(0.8),
            latency_ms: 2.0,
        };
        let empty = QueryResult {
            id: "q2".into(),
            ranked: Vec::new(),
            recall: None,
            reciprocal_rank: None,
            ndcg: None,
            hit_at_1: None,
            top_dense: None,
            ..graded.clone()
        };
        let summary = Summary::of(&[&graded, &empty]);
        assert_eq!(summary.queries, 1);
        assert_eq!(summary.abstention_queries, 1);
        assert_eq!(summary.abstained, 1);
        assert_eq!(summary.ndcg, 1.0);
    }

    #[test]
    fn isolated_names_are_disposable_and_bounded() {
        let name = isolated_name("memory", "nomic-embed-text:latest", 63);
        assert_eq!(name, "memory_eval_nomic_embed_text_latest");
        assert!(is_disposable(&name));
        let long = isolated_name("memory", &"x".repeat(200), 63);
        assert!(long.len() <= 63 && is_disposable(&long));
        assert!(!is_disposable("memory"));
        assert!(!is_disposable("Memory_eval"));
        assert!(!is_disposable("memory_eval\"; drop"));
    }

    #[test]
    fn bundled_dataset_is_consistent() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("evals/retrieval/dataset.json");
        let dataset = Dataset::load(&root).expect("dataset loads");
        let corpus = dataset
            .corpus
            .as_ref()
            .expect("bundled dataset has a corpus");
        let keys: std::collections::HashSet<String> = std::fs::read_dir(corpus)
            .expect("corpus directory")
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                e.path()
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
            })
            .collect();
        for query in &dataset.queries {
            for key in query.relevant.keys().chain(&query.forbidden) {
                assert!(
                    keys.contains(key),
                    "query {} references unknown note {key}",
                    query.id
                );
            }
        }
        for key in &dataset.retire {
            assert!(
                keys.contains(key),
                "retire list references unknown note {key}"
            );
        }
    }
}

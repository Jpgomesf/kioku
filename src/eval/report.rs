//! Quality gates and the Markdown report.

use std::fmt::Write as _;

use anyhow::{Result, bail, ensure};

use super::metrics::Interval;
use super::{DEFAULT_VARIANT, Report};

/// Quality floors that make `kioku eval` exit with an error, for CI.
#[derive(Debug, Default, Clone, Copy)]
pub struct Gates {
    pub min_ndcg: Option<f64>,
    pub min_recall: Option<f64>,
    /// Highest allowed hub exposure ratio for the default ranking.
    pub max_hub_exposure: Option<f64>,
    /// Fail when any forbidden (superseded) key reaches the top k.
    pub no_leaks: bool,
}

/// Fail when the default variant drops below the given floors.
pub fn check_thresholds(report: &Report, gates: Gates) -> Result<()> {
    let Gates {
        min_ndcg,
        min_recall,
        max_hub_exposure,
        no_leaks,
    } = gates;
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
    if let Some(max) = max_hub_exposure
        && let Some(exposure) = report
            .graph
            .hub_exposure
            .iter()
            .find(|h| h.variant == DEFAULT_VARIANT)
    {
        ensure!(
            exposure.max_ratio <= max,
            "hub exposure {:.2} for `{}` is above the allowed {max:.2}",
            exposure.max_ratio,
            exposure.top.first().map_or("", |r| r.key.as_str())
        );
    }
    if no_leaks {
        ensure!(
            default.overall.leaks == 0,
            "{} queries returned a forbidden (superseded) note",
            default.overall.leaks
        );
    }
    Ok(())
}

fn ci(interval: &Interval) -> String {
    format!(
        "{:.3} [{:.3}, {:.3}]",
        interval.mean, interval.low, interval.high
    )
}

fn signed(interval: &Interval) -> String {
    format!(
        "{:+.3} [{:+.3}, {:+.3}]{}",
        interval.mean,
        interval.low,
        interval.high,
        if interval.excludes_zero() {
            ""
        } else {
            " (within noise)"
        }
    )
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
        "| variant | recall@{k} | MRR | nDCG@{k} (95% CI) | macro nDCG | hit@1 | complete support | leaks | p50 ms |\n|---|---|---|---|---|---|---|---|---|"
    );
    for v in &report.variants {
        let s = &v.overall;
        let _ = writeln!(
            out,
            "| {} | {:.3} | {:.3} | {} | {:.3} | {:.3} | {}/{} | {} | {:.1} |",
            v.name,
            s.recall,
            s.mrr,
            ci(&v.ndcg_ci),
            v.macro_ndcg,
            s.hit_at_1,
            s.complete_support,
            s.support_queries,
            s.leaks,
            s.p50_ms
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
            "- `{}` vs `{}`: {} better, {} worse, {} tied; mean nDCG change {}",
            c.variant,
            c.baseline,
            c.wins,
            c.losses,
            c.ties,
            signed(&c.delta)
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
    render_graph(&mut out, report);
    out
}

fn render_graph(out: &mut String, report: &Report) {
    let graph = &report.graph;
    let k = report.k;
    let _ = writeln!(out, "\nGraph contribution\n");
    let _ = writeln!(
        out,
        "| links | nDCG@{k} (95% CI) | recall@{k} | complete support | nDCG change vs stored links (95% CI) |\n|---|---|---|---|---|"
    );
    if let Some(default) = report.default_variant() {
        let s = &default.overall;
        let _ = writeln!(
            out,
            "| stored links (`{DEFAULT_VARIANT}`) | {} | {:.3} | {}/{} | |",
            ci(&default.ndcg_ci),
            s.recall,
            s.complete_support,
            s.support_queries
        );
    }
    if let Some(hybrid) = report.variant("hybrid") {
        let delta = report
            .comparisons
            .iter()
            .find(|c| c.variant == DEFAULT_VARIANT && c.baseline == "hybrid")
            .map(|c| Interval {
                mean: -c.delta.mean,
                low: -c.delta.high,
                high: -c.delta.low,
            });
        let s = &hybrid.overall;
        let _ = writeln!(
            out,
            "| no links (`hybrid`) | {} | {:.3} | {}/{} | {} |",
            ci(&hybrid.ndcg_ci),
            s.recall,
            s.complete_support,
            s.support_queries,
            delta.as_ref().map(signed).unwrap_or_default()
        );
    }
    for a in &graph.ablations {
        let _ = writeln!(
            out,
            "| {} ({} seeds) | {} | {:.3} | {} | {} |",
            a.name,
            a.seeds.len(),
            ci(&a.ndcg),
            a.recall,
            a.complete_support
                .map(|share| format!("{:.0}%", share * 100.0))
                .unwrap_or_default(),
            signed(&a.delta_vs_default)
        );
    }
    let l = &graph.links;
    let _ = writeln!(
        out,
        "\n- Links: {} of {} references resolve ({:.0}%); {} edges; {} of {} notes linked; mean degree {:.1}, max {}{}",
        l.references - l.unresolved,
        l.references,
        l.resolution_rate * 100.0,
        l.edges,
        l.linked_notes,
        l.notes,
        l.mean_degree,
        l.max_degree,
        l.max_degree_key
            .as_ref()
            .map(|key| format!(" (`{key}`)"))
            .unwrap_or_default()
    );
    let p = &graph.slot_precision;
    match &p.precision {
        Some(precision) => {
            let _ = writeln!(
                out,
                "- Graph slot (`{}`): {} linked results, {} relevant, precision {}; `{}` had {} relevant results in those positions",
                p.variant,
                p.link_hits,
                p.relevant,
                ci(precision),
                p.baseline,
                p.baseline_relevant
            );
        }
        None => {
            let _ = writeln!(out, "- Graph slot (`{}`): no linked results", p.variant);
        }
    }
    let exposures: Vec<String> = graph
        .hub_exposure
        .iter()
        .map(|h| {
            format!(
                "`{}` {:.2}{}",
                h.variant,
                h.max_ratio,
                h.top
                    .first()
                    .map(|r| format!(" ({}, {}/{})", r.key, r.appearances, r.eligible))
                    .unwrap_or_default()
            )
        })
        .collect();
    let uniform = graph.hub_exposure.first().map_or(0.0, |h| h.uniform_rate);
    let _ = writeln!(
        out,
        "- Hub exposure, worst note vs a uniform rate of {uniform:.3}: {}",
        exposures.join("; ")
    );
}

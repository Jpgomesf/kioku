//! Quality gates and the Markdown report.

use std::fmt::Write as _;

use anyhow::{Result, bail, ensure};

use super::{DEFAULT_VARIANT, Report};

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

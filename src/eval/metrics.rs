//! Standard IR metrics over graded relevance, and their per-category summary.

use std::collections::BTreeMap;

use serde::Serialize;

use super::graph::Rng;

/// Bootstrap resamples per interval. 2,000 keeps the 2.5% tails stable to
/// about ±0.005 on these dataset sizes.
const BOOTSTRAP_RESAMPLES: usize = 2000;

/// A point estimate with a 95% interval.
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
pub struct Interval {
    pub mean: f64,
    pub low: f64,
    pub high: f64,
}

impl Interval {
    /// Wilson score interval for `successes` out of `n` (n > 0).
    pub fn wilson(successes: usize, n: usize) -> Self {
        let n_f = n as f64;
        let p = successes as f64 / n_f;
        let z = 1.959_963_984_540_054_f64;
        let denominator = 1.0 + z * z / n_f;
        let centre = (p + z * z / (2.0 * n_f)) / denominator;
        let half = z * (p * (1.0 - p) / n_f + z * z / (4.0 * n_f * n_f)).sqrt() / denominator;
        Self {
            mean: p,
            low: (centre - half).max(0.0),
            high: (centre + half).min(1.0),
        }
    }

    /// Percentile bootstrap of the mean. For paired comparisons pass the
    /// per-query differences. The seed makes reports reproducible.
    pub fn bootstrap_mean(values: &[f64], seed: u64) -> Self {
        if values.is_empty() {
            return Self {
                mean: 0.0,
                low: 0.0,
                high: 0.0,
            };
        }
        let n = values.len();
        let mean = values.iter().sum::<f64>() / n as f64;
        let mut rng = Rng::new(seed);
        let mut means: Vec<f64> = (0..BOOTSTRAP_RESAMPLES)
            .map(|_| (0..n).map(|_| values[rng.below(n)]).sum::<f64>() / n as f64)
            .collect();
        means.sort_by(f64::total_cmp);
        let at = |q: f64| means[((means.len() - 1) as f64 * q).round() as usize];
        Self {
            mean,
            low: at(0.025),
            high: at(0.975),
        }
    }

    /// Whether the interval excludes zero, i.e. a difference is unlikely to be noise.
    pub fn excludes_zero(&self) -> bool {
        self.low > 0.0 || self.high < 0.0
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
    /// Keys that entered through an explicit link (graph slots).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub linked: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recall: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reciprocal_rank: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ndcg: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hit_at_1: Option<bool>,
    /// Whether every note in the query's `required` set reached the top k.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub complete_support: Option<bool>,
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
    /// Queries with a `required` set, and how many had all of it in the top k.
    pub support_queries: usize,
    pub complete_support: usize,
    pub abstention_queries: usize,
    pub abstained: usize,
    pub p50_ms: f64,
    pub p95_ms: f64,
}

impl Summary {
    pub(super) fn of(results: &[&QueryResult]) -> Self {
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
            support_queries: results
                .iter()
                .filter(|r| r.complete_support.is_some())
                .count(),
            complete_support: results
                .iter()
                .filter(|r| r.complete_support == Some(true))
                .count(),
            abstention_queries: abstention.len(),
            abstained: abstention.iter().filter(|r| r.ranked.is_empty()).count(),
            p50_ms: percentile(0.5),
            p95_ms: percentile(0.95),
        }
    }
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
            linked: Vec::new(),
            recall: Some(1.0),
            reciprocal_rank: Some(1.0),
            ndcg: Some(1.0),
            hit_at_1: Some(true),
            complete_support: Some(true),
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
        assert_eq!((summary.support_queries, summary.complete_support), (2, 2));
    }

    #[test]
    fn wilson_matches_published_values() {
        // 5/5 and 1/1 are the intervals quoted in evals/behavior/README.md.
        let five = Interval::wilson(5, 5);
        assert!(
            (five.low - 0.566).abs() < 1e-3 && five.high == 1.0,
            "{five:?}"
        );
        let one = Interval::wilson(1, 1);
        assert!((one.low - 0.207).abs() < 1e-3, "{one:?}");
        let half = Interval::wilson(10, 20);
        assert!((half.low - 0.299).abs() < 1e-3 && (half.high - 0.701).abs() < 1e-3);
    }

    #[test]
    fn bootstrap_is_reproducible_and_brackets_the_mean() {
        let values: Vec<f64> = (0..40).map(|i| f64::from(i % 5) / 4.0).collect();
        let a = Interval::bootstrap_mean(&values, 11);
        assert_eq!(a, Interval::bootstrap_mean(&values, 11));
        assert!(a.low < a.mean && a.mean < a.high, "{a:?}");
        assert!(!Interval::bootstrap_mean(&[0.0; 10], 1).excludes_zero());
        assert!(Interval::bootstrap_mean(&[0.2; 10], 1).excludes_zero());
    }
}

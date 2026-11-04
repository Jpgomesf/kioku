//! What the link graph contributes: ablations against shuffled and thinned
//! links, how often a linked note is relevant, how often one note shows up
//! where it doesn't belong, and how much of the authored graph resolves.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde::Serialize;
use uuid::Uuid;

use crate::graph;
use crate::model::{Edge, Note};

use super::metrics::Interval;
use super::{Query, QueryResult};

/// Deterministic SplitMix64, so ablations and bootstrap intervals reproduce
/// exactly without a random-number dependency.
pub(super) struct Rng(u64);

impl Rng {
    pub(super) fn new(seed: u64) -> Self {
        Self(seed)
    }

    pub(super) fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in `0..n`; `n` must be positive.
    pub(super) fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }

    /// True with probability `p`.
    pub(super) fn chance(&mut self, p: f64) -> bool {
        ((self.next_u64() >> 11) as f64 / (1u64 << 53) as f64) < p
    }
}

/// Rewire links by directed double edge swaps: `a→b, c→d` becomes `a→d, c→b`.
/// Every note keeps its number of outgoing and incoming links, but which notes
/// are linked becomes random. If real links beat these, the signal is in the
/// links themselves and not just in having some links.
pub fn shuffled_links(edges: &[Edge], seed: u64) -> Vec<Edge> {
    let mut edges: Vec<Edge> = edges.to_vec();
    if edges.len() < 2 {
        return edges;
    }
    let mut present: HashSet<(Uuid, Uuid)> = edges.iter().map(|e| (e.source, e.target)).collect();
    let mut rng = Rng::new(seed);
    for _ in 0..edges.len() * 20 {
        let (i, j) = (rng.below(edges.len()), rng.below(edges.len()));
        if i == j {
            continue;
        }
        let (a, b) = (edges[i].source, edges[i].target);
        let (c, d) = (edges[j].source, edges[j].target);
        if a == d || c == b || present.contains(&(a, d)) || present.contains(&(c, b)) {
            continue;
        }
        present.remove(&(a, b));
        present.remove(&(c, d));
        present.insert((a, d));
        present.insert((c, b));
        edges[i].target = d;
        edges[j].target = b;
    }
    edges
}

/// Keep each link with probability `1 - fraction`.
pub fn dropped_links(edges: &[Edge], fraction: f64, seed: u64) -> Vec<Edge> {
    let mut rng = Rng::new(seed);
    edges
        .iter()
        .filter(|_| !rng.chance(fraction))
        .cloned()
        .collect()
}

#[derive(Debug, Serialize)]
pub struct LinkStats {
    pub notes: usize,
    /// `related` references written in notes.
    pub references: usize,
    pub unresolved: usize,
    /// Share of references that resolve to a note in the domain.
    pub resolution_rate: f64,
    pub edges: usize,
    /// Notes with at least one link in either direction.
    pub linked_notes: usize,
    pub mean_degree: f64,
    pub max_degree: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_degree_key: Option<String>,
}

/// Resolve the domain's references the way imports do and describe the result.
pub fn link_stats(notes: &[Note]) -> LinkStats {
    let (edges, unresolved) = graph::resolve_edges_with_report(notes);
    let references: usize = notes.iter().map(|n| n.input.related.len()).sum();
    let mut neighbors: BTreeMap<Uuid, BTreeSet<Uuid>> = BTreeMap::new();
    for edge in &edges {
        neighbors
            .entry(edge.source)
            .or_default()
            .insert(edge.target);
        neighbors
            .entry(edge.target)
            .or_default()
            .insert(edge.source);
    }
    let hub = neighbors
        .iter()
        .max_by(|a, b| a.1.len().cmp(&b.1.len()).then_with(|| b.0.cmp(a.0)));
    let key_of = |id: &Uuid| {
        notes
            .iter()
            .find(|n| n.id == *id)
            .map(|n| n.input.key.clone())
    };
    LinkStats {
        notes: notes.len(),
        references,
        unresolved: unresolved.len(),
        resolution_rate: if references == 0 {
            1.0
        } else {
            1.0 - unresolved.len() as f64 / references as f64
        },
        edges: edges.len(),
        linked_notes: neighbors.len(),
        mean_degree: if notes.is_empty() {
            0.0
        } else {
            neighbors.values().map(BTreeSet::len).sum::<usize>() as f64 / notes.len() as f64
        },
        max_degree: hub.map_or(0, |(_, n)| n.len()),
        max_degree_key: hub.and_then(|(id, _)| key_of(id)),
    }
}

/// How often notes that entered through a link were relevant, against what
/// the same result positions held without links.
#[derive(Debug, Serialize)]
pub struct SlotPrecision {
    pub variant: String,
    pub link_hits: usize,
    pub relevant: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub precision: Option<Interval>,
    /// The ranking without links, at the positions linked notes took.
    pub baseline: String,
    pub baseline_relevant: usize,
}

pub fn slot_precision(
    variant: &str,
    results: &[QueryResult],
    baseline: (&str, &[QueryResult]),
    queries: &[Query],
) -> SlotPrecision {
    let (mut hits, mut relevant, mut baseline_relevant) = (0, 0, 0);
    for ((result, without), query) in results.iter().zip(baseline.1).zip(queries) {
        for key in &result.linked {
            hits += 1;
            if query.relevant.contains_key(key) {
                relevant += 1;
            }
            let position = result.ranked.iter().position(|r| r == key);
            if position
                .and_then(|i| without.ranked.get(i))
                .is_some_and(|other| query.relevant.contains_key(other))
            {
                baseline_relevant += 1;
            }
        }
    }
    SlotPrecision {
        variant: variant.to_owned(),
        link_hits: hits,
        relevant,
        precision: (hits > 0).then(|| Interval::wilson(relevant, hits)),
        baseline: baseline.0.to_owned(),
        baseline_relevant,
    }
}

#[derive(Debug, Serialize)]
pub struct NoteExposure {
    pub key: String,
    /// Queries where this note was not relevant but still in the top k.
    pub appearances: usize,
    /// Queries where this note was not relevant.
    pub eligible: usize,
    /// `appearances / eligible` divided by the uniform rate `k / notes`.
    pub ratio: f64,
}

/// Whether one note shows up in results it doesn't belong in. A ratio of 1
/// means a note appears in unrelated results as often as a random pick would;
/// v0.1.0's pinned hub note would score far above 3.
#[derive(Debug, Serialize)]
pub struct HubExposure {
    pub variant: String,
    pub uniform_rate: f64,
    pub max_ratio: f64,
    pub top: Vec<NoteExposure>,
}

pub fn hub_exposure(
    variant: &str,
    results: &[QueryResult],
    queries: &[Query],
    keys: &[String],
    k: usize,
) -> HubExposure {
    let uniform_rate = if keys.is_empty() {
        0.0
    } else {
        (k as f64 / keys.len() as f64).min(1.0)
    };
    let mut rows: Vec<NoteExposure> = keys
        .iter()
        .filter_map(|key| {
            let mut eligible = 0;
            let mut appearances = 0;
            for (result, query) in results.iter().zip(queries) {
                if query.relevant.contains_key(key) {
                    continue;
                }
                eligible += 1;
                if result.ranked.iter().take(k).any(|r| r == key) {
                    appearances += 1;
                }
            }
            (eligible > 0 && uniform_rate > 0.0).then(|| NoteExposure {
                key: key.clone(),
                appearances,
                eligible,
                ratio: appearances as f64 / eligible as f64 / uniform_rate,
            })
        })
        .collect();
    rows.sort_by(|a, b| b.ratio.total_cmp(&a.ratio).then_with(|| a.key.cmp(&b.key)));
    rows.truncate(5);
    HubExposure {
        variant: variant.to_owned(),
        uniform_rate,
        max_ratio: rows.first().map_or(0.0, |r| r.ratio),
        top: rows,
    }
}

/// The default ranking rerun with altered links, averaged over seeds.
#[derive(Debug, Serialize)]
pub struct Ablation {
    pub name: String,
    pub seeds: Vec<u64>,
    pub ndcg: Interval,
    pub recall: f64,
    /// Share of queries with a `required` set whose notes were all in the top k.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub complete_support: Option<f64>,
    /// Paired per-query nDCG difference, ablation minus the default ranking.
    /// Below zero means the real links do better.
    pub delta_vs_default: Interval,
}

#[derive(Debug, Serialize)]
pub struct GraphReport {
    pub links: LinkStats,
    pub slot_precision: SlotPrecision,
    pub hub_exposure: Vec<HubExposure>,
    pub ablations: Vec<Ablation>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::note;

    fn edge(a: &Note, b: &Note) -> Edge {
        Edge {
            source: a.id,
            target: b.id,
            kind: "related".into(),
            weight: 1.0,
        }
    }

    fn degrees(edges: &[Edge]) -> (BTreeMap<Uuid, usize>, BTreeMap<Uuid, usize>) {
        let (mut out, mut inc) = (BTreeMap::new(), BTreeMap::new());
        for e in edges {
            *out.entry(e.source).or_default() += 1;
            *inc.entry(e.target).or_default() += 1;
        }
        (out, inc)
    }

    #[test]
    fn shuffling_keeps_degrees_and_changes_links() {
        let notes: Vec<Note> = (0..8).map(|i| note(&format!("n{i}"), "d")).collect();
        let edges: Vec<Edge> = (0..8)
            .flat_map(|i| {
                [
                    edge(&notes[i], &notes[(i + 1) % 8]),
                    edge(&notes[i], &notes[(i + 3) % 8]),
                ]
            })
            .collect();
        let shuffled = shuffled_links(&edges, 7);
        assert_eq!(degrees(&edges), degrees(&shuffled));
        let before: HashSet<_> = edges.iter().map(|e| (e.source, e.target)).collect();
        let after: HashSet<_> = shuffled.iter().map(|e| (e.source, e.target)).collect();
        assert_eq!(after.len(), shuffled.len(), "no duplicate links");
        assert!(
            shuffled.iter().all(|e| e.source != e.target),
            "no self links"
        );
        assert_ne!(before, after);
        assert_eq!(shuffled_links(&edges, 7).len(), shuffled.len());
        let again: Vec<_> = shuffled_links(&edges, 7)
            .iter()
            .map(|e| (e.source, e.target))
            .collect();
        let first: Vec<_> = shuffled.iter().map(|e| (e.source, e.target)).collect();
        assert_eq!(again, first, "same seed, same result");
    }

    #[test]
    fn dropout_removes_about_the_requested_share() {
        let notes: Vec<Note> = (0..40).map(|i| note(&format!("n{i}"), "d")).collect();
        let edges: Vec<Edge> = (0..39).map(|i| edge(&notes[i], &notes[i + 1])).collect();
        assert_eq!(dropped_links(&edges, 0.0, 1).len(), edges.len());
        assert!(dropped_links(&edges, 1.0, 1).is_empty());
        let half = dropped_links(&edges, 0.5, 3).len();
        assert!((10..=29).contains(&half), "{half}");
    }

    #[test]
    fn link_stats_count_unresolved_references_and_hubs() {
        let mut hub = note("hub", "d");
        hub.input.related = vec!["a".into(), "b".into(), "missing".into()];
        let a = note("a", "d");
        let mut b = note("b", "d");
        b.input.related = vec!["a".into()];
        let stats = link_stats(&[hub, a, b]);
        assert_eq!(stats.references, 4);
        assert_eq!(stats.unresolved, 1);
        assert!((stats.resolution_rate - 0.75).abs() < 1e-12);
        assert_eq!(stats.edges, 3);
        assert_eq!(stats.max_degree, 2);
        assert_eq!(stats.linked_notes, 3);
    }

    fn query(id: &str, relevant: &[&str]) -> Query {
        serde_json::from_value(serde_json::json!({
            "id": id, "category": "c", "query": id,
            "relevant": relevant.iter().map(|k| ((*k).to_owned(), 2)).collect::<BTreeMap<_, _>>(),
        }))
        .unwrap()
    }

    fn result(ranked: &[&str], linked: &[&str]) -> QueryResult {
        QueryResult {
            id: String::new(),
            category: "c".into(),
            ranked: ranked.iter().map(|s| (*s).to_owned()).collect(),
            linked: linked.iter().map(|s| (*s).to_owned()).collect(),
            recall: None,
            reciprocal_rank: None,
            ndcg: None,
            hit_at_1: None,
            complete_support: None,
            leaked: Vec::new(),
            top_dense: None,
            latency_ms: 0.0,
        }
    }

    #[test]
    fn a_note_in_every_unrelated_result_is_a_hub() {
        let keys: Vec<String> = ["hub", "a", "b", "c"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        let queries = vec![
            query("q1", &["a"]),
            query("q2", &["b"]),
            query("q3", &["c"]),
        ];
        let results = vec![
            result(&["a", "hub"], &[]),
            result(&["b", "hub"], &[]),
            result(&["c", "hub"], &[]),
        ];
        let exposure = hub_exposure("v", &results, &queries, &keys, 2);
        assert_eq!(exposure.top[0].key, "hub");
        assert_eq!(exposure.top[0].appearances, 3);
        assert!(
            (exposure.max_ratio - 2.0).abs() < 1e-12,
            "{}",
            exposure.max_ratio
        );
        assert!(exposure.top.iter().skip(1).all(|r| r.appearances == 0));
    }

    #[test]
    fn slot_precision_counts_relevant_linked_notes() {
        let queries = vec![query("q1", &["a", "b"]), query("q2", &["c"])];
        let results = vec![result(&["a", "b"], &["b"]), result(&["c", "x"], &["x"])];
        let without = vec![result(&["a", "y"], &[]), result(&["c", "c2"], &[])];
        let p = slot_precision("v", &results, ("base", &without), &queries);
        assert_eq!((p.link_hits, p.relevant, p.baseline_relevant), (2, 1, 0));
        assert!((p.precision.unwrap().mean - 0.5).abs() < 1e-12);
    }
}

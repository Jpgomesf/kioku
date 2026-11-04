//! Query-time ranking: dense and lexical retrieval fused with Reciprocal Rank
//! Fusion, then optional expansion through explicit links.
//!
//! Everything here is pure and deterministic, so the same code is unit-tested,
//! measured by `kioku eval`, and served over MCP.
//!
//! Design, as measured on `evals/retrieval` (see `docs/evaluation.md`):
//! - Dense similarity alone misses identifiers, exact terminology, and
//!   cross-language aliases. BM25 over key, title, aliases, tags, and body
//!   recovers them, and RRF combines the two rankings without calibrating
//!   their score scales against each other.
//! - Explicit links help recall for multi-hop questions, but letting graph
//!   scores reorder the whole list hurt precision: hub notes with many links
//!   rose to the top of unrelated queries. Graph expansion therefore only
//!   fills reserved trailing slots and never displaces the direct matches.

mod lexical;

pub use lexical::{fold, tokenize};

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::graph;
use crate::lifecycle;
use crate::model::{Edge, Note};

use lexical::{Bm25, normalize_label};

/// Conventional RRF constant (Cormack, Clarke, and Büttcher, 2009).
const RRF_K: f64 = 60.0;

/// Dense hits below this cosine similarity are ignored.
pub const DENSE_FLOOR: f64 = 0.2;

/// Restart probability for graph expansion. A high restart keeps probability
/// mass close to the seeds, as in HippoRAG 2, so hubs cannot dominate.
const EXPANSION_RESTART: f64 = 0.5;

/// Number of top-ranked notes whose links seed graph expansion.
const EXPANSION_SEEDS: usize = 3;

/// Retention is a mild prior that only breaks near-ties. Adjacent RRF ranks
/// differ by about 1.6%, so a larger weight would let a pinned or
/// high-confidence note jump over a more relevant one. Stale notes are handled
/// by moving them to legacy status, not by ranking.
const RETENTION_WEIGHT: f64 = 0.05;

/// Which retrieval signals to combine. The MCP surface always enables lexical
/// matching; the eval harness also measures the ablations.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RankOptions {
    pub lexical: bool,
    pub graph: bool,
}

impl RankOptions {
    pub const VECTOR: Self = Self {
        lexical: false,
        graph: false,
    };
    pub const HYBRID: Self = Self {
        lexical: true,
        graph: false,
    };
    pub const HYBRID_GRAPH: Self = Self {
        lexical: true,
        graph: true,
    };
}

/// Why a note appears in the results.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MatchKind {
    /// The query equals the note's key, title, or one of its aliases.
    Exact,
    /// Dense and/or lexical retrieval matched the note.
    Search,
    /// Reached through an explicit link from a top match.
    Link,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Ranked {
    pub id: Uuid,
    /// Fused relevance in [0, 1]: 1 means rank one in every enabled signal.
    pub score: f64,
    pub kind: MatchKind,
    /// For [`MatchKind::Link`], the top match whose link led here.
    pub linked_from: Option<Uuid>,
    pub dense: Option<f64>,
    pub lexical: Option<f64>,
    pub retention: f64,
}

pub struct RankInput<'a> {
    /// Candidate notes: one domain, already filtered by lifecycle status.
    pub notes: &'a [Note],
    pub edges: &'a [Edge],
    /// Cosine similarity per note from the vector index, already checked for
    /// freshness by the caller.
    pub dense: &'a HashMap<Uuid, f64>,
    pub query: &'a str,
    pub limit: usize,
    pub now: DateTime<Utc>,
    pub half_life_days: f64,
}

/// Rank notes for a query. Returns at most `input.limit` results.
pub fn rank(input: &RankInput<'_>, options: RankOptions) -> Vec<Ranked> {
    if input.limit == 0 || input.notes.is_empty() {
        return Vec::new();
    }
    let by_id: HashMap<Uuid, &Note> = input.notes.iter().map(|n| (n.id, n)).collect();

    let dense: Vec<(Uuid, f64)> = sorted_desc(
        input
            .dense
            .iter()
            .filter(|(id, score)| {
                by_id.contains_key(id) && score.is_finite() && **score >= DENSE_FLOOR
            })
            .map(|(id, score)| (*id, *score)),
    );
    let lexical: Vec<(Uuid, f64)> = if options.lexical {
        sorted_desc(Bm25::new(input.notes).scores(input.query))
    } else {
        Vec::new()
    };
    let signals = 1 + usize::from(options.lexical);
    let mut fused: HashMap<Uuid, f64> = HashMap::new();
    for list in [&dense, &lexical] {
        for (rank, (id, _)) in list.iter().enumerate() {
            *fused.entry(*id).or_default() += rrf(rank);
        }
    }
    let exact = exact_matches(input.notes, input.query);
    for id in &exact {
        fused.entry(*id).or_default();
    }
    if fused.is_empty() {
        return Vec::new();
    }

    let dense_by_id: HashMap<Uuid, f64> = dense.iter().copied().collect();
    let lexical_by_id: HashMap<Uuid, f64> = lexical.iter().copied().collect();
    let best_possible = signals as f64 * rrf(0);
    let make = |id: Uuid, kind: MatchKind, linked_from: Option<Uuid>| {
        let retention = lifecycle::retention(by_id[&id], input.now, input.half_life_days);
        let relevance = (fused.get(&id).copied().unwrap_or(0.0) / best_possible).clamp(0.0, 1.0);
        let score = if kind == MatchKind::Exact {
            1.0
        } else {
            relevance * (1.0 - RETENTION_WEIGHT + RETENTION_WEIGHT * retention)
        };
        Ranked {
            id,
            score,
            kind,
            linked_from,
            dense: dense_by_id.get(&id).copied(),
            lexical: lexical_by_id.get(&id).copied(),
            retention,
        }
    };

    // Exact matches first, then fused relevance with the retention prior.
    let mut ordered: Vec<Ranked> = exact
        .iter()
        .map(|id| make(*id, MatchKind::Exact, None))
        .collect();
    let mut rest: Vec<Ranked> = fused
        .keys()
        .filter(|id| !exact.contains(id))
        .map(|id| make(*id, MatchKind::Search, None))
        .collect();
    rest.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.id.cmp(&b.id)));
    ordered.extend(rest);

    let slots = graph_slots(input.limit);
    if !options.graph || slots == 0 {
        ordered.truncate(input.limit);
        return ordered;
    }

    // Keep the direct head intact and fill the reserved slots with linked notes.
    let head_len = input.limit - slots;
    let seeds: Vec<Uuid> = ordered.iter().take(EXPANSION_SEEDS).map(|r| r.id).collect();
    let weights: HashMap<Uuid, f64> = seeds
        .iter()
        .map(|id| {
            (
                *id,
                fused.get(id).copied().unwrap_or(0.0).max(f64::MIN_POSITIVE),
            )
        })
        .collect();
    let ppr = graph::personalized_pagerank(input.notes, input.edges, &weights, EXPANSION_RESTART);
    let head: HashSet<Uuid> = ordered.iter().take(head_len).map(|r| r.id).collect();
    let mut linked: Vec<(Uuid, f64)> = sorted_desc(
        ppr.into_iter()
            .filter(|(id, mass)| *mass > 1e-12 && !head.contains(id) && !seeds.contains(id)),
    );
    linked.truncate(slots);
    let adjacency = adjacency(input.edges);
    let mut results: Vec<Ranked> = ordered.iter().take(head_len).cloned().collect();
    for (id, _) in &linked {
        let from = seeds
            .iter()
            .find(|seed| adjacency.get(seed).is_some_and(|n| n.contains(id)))
            .copied();
        results.push(make(*id, MatchKind::Link, from));
    }
    let taken: HashSet<Uuid> = results.iter().map(|r| r.id).collect();
    results.extend(ordered.into_iter().filter(|r| !taken.contains(&r.id)));
    results.truncate(input.limit);
    results
}

/// One reserved graph slot for small result lists, more for larger ones.
fn graph_slots(limit: usize) -> usize {
    if limit < 3 { 0 } else { (limit / 4).max(1) }
}

fn rrf(zero_based_rank: usize) -> f64 {
    1.0 / (RRF_K + zero_based_rank as f64 + 1.0)
}

fn sorted_desc(items: impl IntoIterator<Item = (Uuid, f64)>) -> Vec<(Uuid, f64)> {
    let mut items: Vec<_> = items.into_iter().collect();
    items.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    items
}

fn adjacency(edges: &[Edge]) -> HashMap<Uuid, HashSet<Uuid>> {
    let mut map: HashMap<Uuid, HashSet<Uuid>> = HashMap::new();
    for edge in edges {
        map.entry(edge.source).or_default().insert(edge.target);
        map.entry(edge.target).or_default().insert(edge.source);
    }
    map
}

/// Notes whose key, title, or alias equals the query after case and accent folding.
fn exact_matches(notes: &[Note], query: &str) -> Vec<Uuid> {
    let wanted = normalize_label(query);
    if wanted.is_empty() {
        return Vec::new();
    }
    let mut ids: Vec<Uuid> = notes
        .iter()
        .filter(|note| {
            std::iter::once(&note.input.key)
                .chain(std::iter::once(&note.input.title))
                .chain(&note.input.aliases)
                .any(|label| normalize_label(label) == wanted)
        })
        .map(|note| note.id)
        .collect();
    ids.sort();
    ids
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{NoteInput, Status};
    use chrono::TimeZone;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 1, 12, 0, 0).unwrap()
    }

    fn note(key: &str, title: &str, body: &str, aliases: &[&str]) -> Note {
        let input = NoteInput {
            domain: "test".into(),
            key: key.into(),
            title: title.into(),
            body: body.into(),
            aliases: aliases.iter().map(|a| (*a).to_owned()).collect(),
            related: Vec::new(),
            tags: Vec::new(),
            source: None,
            confidence: 0.9,
            pinned: false,
        };
        Note {
            id: input.id(),
            input,
            status: Status::Active,
            created_at: now(),
            updated_at: now(),
            last_accessed_at: None,
            access_count: 0,
            positive_feedback: 0,
            negative_feedback: 0,
            retention_score: 0.9,
            last_decay_at: now(),
            vector_synced: true,
            revision: 1,
        }
    }

    fn link(a: &Note, b: &Note) -> Edge {
        Edge {
            source: a.id,
            target: b.id,
            kind: "related".into(),
            weight: 1.0,
        }
    }

    fn input<'a>(
        notes: &'a [Note],
        edges: &'a [Edge],
        dense: &'a HashMap<Uuid, f64>,
        query: &'a str,
        limit: usize,
    ) -> RankInput<'a> {
        RankInput {
            notes,
            edges,
            dense,
            query,
            limit,
            now: now(),
            half_life_days: 90.0,
        }
    }

    #[test]
    fn lexical_signal_finds_identifiers_dense_vectors_miss() {
        let queue = note(
            "media-queue",
            "Media stream",
            "Consumers set max_deliver to five.",
            &[],
        );
        let limits = note(
            "rate-limits",
            "Rate limits",
            "Six hundred requests per minute.",
            &[],
        );
        let notes = [queue.clone(), limits.clone()];
        // The dense signal prefers the wrong note.
        let dense = HashMap::from([(limits.id, 0.7), (queue.id, 0.5)]);
        let vector = rank(
            &input(&notes, &[], &dense, "max_deliver", 2),
            RankOptions::VECTOR,
        );
        assert_eq!(vector[0].id, limits.id);
        let hybrid = rank(
            &input(&notes, &[], &dense, "max_deliver", 2),
            RankOptions::HYBRID,
        );
        assert_eq!(hybrid[0].id, queue.id);
        assert!(hybrid[0].lexical.is_some());
    }

    #[test]
    fn exact_alias_match_ranks_first_regardless_of_other_signals() {
        let target = note(
            "local-dev-setup",
            "Local environment",
            "Ports.",
            &["Dev Setup"],
        );
        let other = note("other", "Other", "dev setup dev setup dev setup", &[]);
        let notes = [target.clone(), other.clone()];
        let dense = HashMap::from([(other.id, 0.9), (target.id, 0.3)]);
        let ranked = rank(
            &input(&notes, &[], &dense, "dev setup", 2),
            RankOptions::HYBRID,
        );
        assert_eq!(ranked[0].id, target.id);
        assert_eq!(ranked[0].kind, MatchKind::Exact);
        assert_eq!(ranked[0].score, 1.0);
    }

    #[test]
    fn graph_expansion_fills_reserved_slots_without_displacing_the_head() {
        let a = note("a", "Alpha", "alpha", &[]);
        let b = note("b", "Beta", "beta", &[]);
        let c = note("c", "Gamma", "gamma", &[]);
        let hub = note("hub", "Hub", "hub", &[]);
        let linked = note("linked", "Linked", "unrelated words", &[]);
        let notes = [a.clone(), b.clone(), c.clone(), hub.clone(), linked.clone()];
        let edges = [link(&a, &linked), link(&hub, &b), link(&hub, &c)];
        let dense = HashMap::from([
            (a.id, 0.9),
            (b.id, 0.8),
            (c.id, 0.7),
            (hub.id, 0.3),
            (linked.id, 0.21),
        ]);
        let plain = rank(
            &input(&notes, &edges, &dense, "alpha", 3),
            RankOptions::HYBRID,
        );
        let expanded = rank(
            &input(&notes, &edges, &dense, "alpha", 3),
            RankOptions::HYBRID_GRAPH,
        );
        // The first two direct matches are unchanged.
        assert_eq!(
            plain[..2].iter().map(|r| r.id).collect::<Vec<_>>(),
            expanded[..2].iter().map(|r| r.id).collect::<Vec<_>>()
        );
        let last = &expanded[2];
        assert_eq!(last.kind, MatchKind::Link);
        assert_eq!(last.linked_from, Some(a.id));
        assert_eq!(last.id, linked.id);
    }

    #[test]
    fn graph_expansion_falls_back_to_direct_matches_without_links() {
        let notes: Vec<Note> = (0..4)
            .map(|i| note(&format!("n{i}"), "Title", "body", &[]))
            .collect();
        let dense: HashMap<Uuid, f64> = notes
            .iter()
            .enumerate()
            .map(|(i, n)| (n.id, 0.9 - i as f64 / 10.0))
            .collect();
        let plain = rank(&input(&notes, &[], &dense, "q", 3), RankOptions::HYBRID);
        let expanded = rank(
            &input(&notes, &[], &dense, "q", 3),
            RankOptions::HYBRID_GRAPH,
        );
        assert_eq!(plain, expanded);
    }

    #[test]
    fn stale_or_low_dense_scores_are_ignored() {
        let a = note("a", "Alpha", "alpha", &[]);
        let ghost = Uuid::new_v4();
        let notes = [a.clone()];
        let dense = HashMap::from([(a.id, 0.1), (ghost, 0.99)]);
        assert!(rank(&input(&notes, &[], &dense, "zzz", 5), RankOptions::VECTOR).is_empty());
    }

    #[test]
    fn scores_are_bounded_and_results_respect_the_limit() {
        let notes: Vec<Note> = (0..10)
            .map(|i| note(&format!("k{i}"), "shared words", "shared words", &[]))
            .collect();
        let dense: HashMap<Uuid, f64> = notes.iter().map(|n| (n.id, 0.5)).collect();
        for options in [
            RankOptions::VECTOR,
            RankOptions::HYBRID,
            RankOptions::HYBRID_GRAPH,
        ] {
            let ranked = rank(&input(&notes, &[], &dense, "shared words", 4), options);
            assert_eq!(ranked.len(), 4);
            assert!(ranked.iter().all(|r| (0.0..=1.0).contains(&r.score)));
        }
    }
}

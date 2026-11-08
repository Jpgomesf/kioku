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
pub const EXPANSION_RESTART: f64 = 0.5;

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
    /// Notes the embedding service may not read, which have no vector by
    /// design. Each is ranked on the signals that can rank it.
    pub unembedded: &'a HashSet<Uuid>,
    pub query: &'a str,
    pub limit: usize,
    pub now: DateTime<Utc>,
    pub half_life_days: f64,
}

/// The retrieval signals of one query over the ranked notes.
pub struct Signals<'a> {
    /// Cosine similarity per note from the vector index, already checked for
    /// freshness by the caller.
    pub dense: &'a HashMap<Uuid, f64>,
    /// BM25 score of each ranked note that shares a term with the query, in
    /// any order. Empty when lexical matching is off.
    pub lexical: Vec<(Uuid, f64)>,
    /// Ranked notes whose key, title, or alias equals the query, sorted.
    pub exact: Vec<Uuid>,
}

/// What ranking needs to know about the notes it ranks: those the caller may
/// see, in the searched lifecycle status.
pub trait Candidates {
    /// Whether `id` is one of the ranked notes.
    fn contains(&self, id: Uuid) -> bool;
    /// Whether `id` has no vector by design, because the embedding service
    /// may not read it.
    fn unembedded(&self, id: Uuid) -> bool;
    /// `id`'s lifecycle retention in [0, 1].
    fn retention(&self, id: Uuid) -> f64;
    /// `id`'s links among the ranked notes, as [`graph::link_weights`] builds
    /// them, or `None` if they aren't loaded.
    fn links(&self, id: Uuid) -> Option<Vec<(Uuid, f64)>>;
}

/// Rank notes for a query. Returns at most `input.limit` results.
pub fn rank(input: &RankInput<'_>, options: RankOptions) -> Vec<Ranked> {
    if input.limit == 0 || input.notes.is_empty() {
        return Vec::new();
    }
    let notes = NoteSet::new(input);
    let signals = Signals {
        dense: input.dense,
        lexical: if options.lexical {
            Bm25::new(input.notes).scores(input.query)
        } else {
            Vec::new()
        },
        exact: exact_matches(input.notes, input.query),
    };
    rank_with(&signals, &notes, input.limit, options)
}

/// Rank from signals the caller computed. Graph expansion walks
/// `notes.links`, which must know the links of every note it reaches.
pub fn rank_with(
    signals: &Signals<'_>,
    notes: &impl Candidates,
    limit: usize,
    options: RankOptions,
) -> Vec<Ranked> {
    let direct = Direct::new(signals, notes, options);
    if !options.graph || graph_slots(limit) == 0 || direct.is_empty() {
        return direct.truncate(limit);
    }
    let mut walk = graph::LocalPagerank::new(&direct.seeds(), EXPANSION_RESTART);
    let missing = walk.run(|id| notes.links(id));
    debug_assert!(missing.is_empty(), "every reached note's links are known");
    direct.expand(&walk.into_masses(), notes, limit)
}

/// The direct matches of a query in rank order, before graph expansion:
/// exact label matches first, then fused relevance with the retention prior.
pub struct Direct {
    ordered: Vec<Ranked>,
    fused: HashMap<Uuid, f64>,
    dense: HashMap<Uuid, f64>,
    lexical: HashMap<Uuid, f64>,
    best_possible: f64,
}

impl Direct {
    pub fn new(signals: &Signals<'_>, notes: &impl Candidates, options: RankOptions) -> Self {
        let dense: Vec<(Uuid, f64)> = sorted_desc(
            signals
                .dense
                .iter()
                .filter(|(id, score)| {
                    notes.contains(**id) && score.is_finite() && **score >= DENSE_FLOOR
                })
                .map(|(id, score)| (*id, *score)),
        );
        let lexical: Vec<(Uuid, f64)> = if options.lexical {
            sorted_desc(signals.lexical.iter().copied())
        } else {
            Vec::new()
        };
        let signal_count = 1 + usize::from(options.lexical);
        let mut fused: HashMap<Uuid, f64> = HashMap::new();
        for list in [&dense, &lexical] {
            for (rank, (id, _)) in list.iter().enumerate() {
                *fused.entry(*id).or_default() += rrf(rank);
            }
        }
        // A note without a vector by design can't have a dense rank. Its lexical
        // rank stands in for it, so it competes on the signals that can rank it
        // instead of losing to every note that has both.
        for (rank, (id, _)) in lexical.iter().enumerate() {
            if notes.unembedded(*id) {
                *fused.entry(*id).or_default() += rrf(rank);
            }
        }
        for id in &signals.exact {
            fused.entry(*id).or_default();
        }
        let mut direct = Self {
            ordered: Vec::new(),
            fused,
            dense: dense.into_iter().collect(),
            lexical: lexical.into_iter().collect(),
            best_possible: signal_count as f64 * rrf(0),
        };
        if direct.fused.is_empty() {
            return direct;
        }
        let mut ordered: Vec<Ranked> = signals
            .exact
            .iter()
            .map(|id| direct.make(*id, MatchKind::Exact, None, notes))
            .collect();
        let mut rest: Vec<Ranked> = direct
            .fused
            .keys()
            .filter(|id| !signals.exact.contains(id))
            .map(|id| direct.make(*id, MatchKind::Search, None, notes))
            .collect();
        rest.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.id.cmp(&b.id)));
        ordered.extend(rest);
        direct.ordered = ordered;
        direct
    }

    fn make(
        &self,
        id: Uuid,
        kind: MatchKind,
        linked_from: Option<Uuid>,
        notes: &impl Candidates,
    ) -> Ranked {
        let retention = notes.retention(id);
        let relevance =
            (self.fused.get(&id).copied().unwrap_or(0.0) / self.best_possible).clamp(0.0, 1.0);
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
            dense: self.dense.get(&id).copied(),
            lexical: self.lexical.get(&id).copied(),
            retention,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.ordered.is_empty()
    }

    /// The top matches whose links seed graph expansion, weighted by their
    /// fused relevance.
    pub fn seeds(&self) -> HashMap<Uuid, f64> {
        self.ordered
            .iter()
            .take(EXPANSION_SEEDS)
            .map(|r| {
                let weight = self.fused.get(&r.id).copied().unwrap_or(0.0);
                (r.id, weight.max(f64::MIN_POSITIVE))
            })
            .collect()
    }

    /// The first `limit` direct matches.
    pub fn truncate(mut self, limit: usize) -> Vec<Ranked> {
        self.ordered.truncate(limit);
        self.ordered
    }

    /// Keep the direct head intact and fill the reserved trailing slots with
    /// the linked notes of highest PageRank `masses`.
    pub fn expand(
        self,
        masses: &HashMap<Uuid, f64>,
        notes: &impl Candidates,
        limit: usize,
    ) -> Vec<Ranked> {
        let slots = graph_slots(limit);
        let head_len = limit - slots;
        let seeds: Vec<Uuid> = self
            .ordered
            .iter()
            .take(EXPANSION_SEEDS)
            .map(|r| r.id)
            .collect();
        let head: HashSet<Uuid> = self.ordered.iter().take(head_len).map(|r| r.id).collect();
        let mut linked: Vec<(Uuid, f64)> = sorted_desc(
            masses
                .iter()
                .map(|(id, mass)| (*id, *mass))
                .filter(|(id, mass)| {
                    *mass > 1e-12
                        && !head.contains(id)
                        && !seeds.contains(id)
                        && notes.contains(*id)
                }),
        );
        linked.truncate(slots);
        let seed_links: Vec<(Uuid, Vec<(Uuid, f64)>)> = seeds
            .iter()
            .map(|seed| (*seed, notes.links(*seed).unwrap_or_default()))
            .collect();
        let mut results: Vec<Ranked> = self.ordered.iter().take(head_len).cloned().collect();
        for (id, _) in &linked {
            let from = seed_links
                .iter()
                .find(|(_, links)| links.iter().any(|(other, _)| other == id))
                .map(|(seed, _)| *seed);
            results.push(self.make(*id, MatchKind::Link, from, notes));
        }
        let taken: HashSet<Uuid> = results.iter().map(|r| r.id).collect();
        results.extend(self.ordered.into_iter().filter(|r| !taken.contains(&r.id)));
        results.truncate(limit);
        results
    }
}

/// [`Candidates`] over a list of notes and their links.
struct NoteSet<'a> {
    by_id: HashMap<Uuid, &'a Note>,
    links: HashMap<Uuid, Vec<(Uuid, f64)>>,
    unembedded: &'a HashSet<Uuid>,
    now: DateTime<Utc>,
    half_life_days: f64,
}

impl<'a> NoteSet<'a> {
    fn new(input: &RankInput<'a>) -> Self {
        let by_id: HashMap<Uuid, &Note> = input.notes.iter().map(|n| (n.id, n)).collect();
        let mut raw: HashMap<Uuid, Vec<(Uuid, f64)>> = HashMap::new();
        for edge in input.edges {
            let (Some(source), Some(target)) = (by_id.get(&edge.source), by_id.get(&edge.target))
            else {
                continue;
            };
            if source.input.domain != target.input.domain {
                continue;
            }
            raw.entry(edge.source)
                .or_default()
                .push((edge.target, edge.weight));
            raw.entry(edge.target)
                .or_default()
                .push((edge.source, edge.weight));
        }
        let links = raw
            .into_iter()
            .map(|(id, links)| (id, graph::link_weights(links, id)))
            .collect();
        Self {
            by_id,
            links,
            unembedded: input.unembedded,
            now: input.now,
            half_life_days: input.half_life_days,
        }
    }
}

impl Candidates for NoteSet<'_> {
    fn contains(&self, id: Uuid) -> bool {
        self.by_id.contains_key(&id)
    }

    fn unembedded(&self, id: Uuid) -> bool {
        self.unembedded.contains(&id)
    }

    fn retention(&self, id: Uuid) -> f64 {
        self.by_id.get(&id).map_or(0.0, |note| {
            lifecycle::retention(note, self.now, self.half_life_days)
        })
    }

    fn links(&self, id: Uuid) -> Option<Vec<(Uuid, f64)>> {
        Some(self.links.get(&id).cloned().unwrap_or_default())
    }
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
            lock: Vec::new(),
            paths: Vec::new(),
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
            unembedded: &NONE,
            query,
            limit,
            now: now(),
            half_life_days: 90.0,
        }
    }

    static NONE: std::sync::LazyLock<HashSet<Uuid>> = std::sync::LazyLock::new(HashSet::new);

    #[test]
    fn a_note_without_a_vector_by_design_ranks_on_its_lexical_signal() {
        let embedded = note("ledger-a", "Ledger", "The ledger keeps entries.", &[]);
        let kept = note(
            "ledger-b",
            "Retention policy",
            "The ledger retention is ninety days.",
            &[],
        );
        let notes = vec![embedded.clone(), kept.clone()];
        let dense = HashMap::from([(embedded.id, 0.9)]);
        let plain = rank(
            &input(&notes, &[], &dense, "ledger retention", 2),
            RankOptions::HYBRID,
        );
        assert_eq!(
            plain[0].id, embedded.id,
            "dense and lexical outrank lexical alone"
        );
        let unembedded = HashSet::from([kept.id]);
        let fair = rank(
            &RankInput {
                unembedded: &unembedded,
                ..input(&notes, &[], &dense, "ledger retention", 2)
            },
            RankOptions::HYBRID,
        );
        assert_eq!(fair[0].id, kept.id, "the best keyword match ranks first");
        assert!(fair[0].score > fair[1].score);
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

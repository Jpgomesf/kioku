//! Ranked search and graph lookups around a note.
//!
//! Search ranks over this process's index of each searched domain
//! ([`super::cache`]), checked against PostgreSQL first. With a [`Viewer`],
//! notes it may not see are left out of the ranking: they neither match nor
//! count in BM25's statistics, the vector index is told to leave them out of
//! its candidates, and graph expansion never walks through them, so a hidden
//! note can neither be returned nor shift the ranking of visible ones.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::time::Instant;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::Serialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::error::{invalid, not_found};
use crate::graph;
use crate::model::{Edge, Note, Status};
use crate::rank::index::{Entry, View, corpus_weights};
use crate::rank::{self, Candidates, Direct, MatchKind, RankOptions, Ranked, tokenize};
use crate::store::HitFields;
use crate::text::truncate_chars;
use crate::vault::Viewer;

use super::App;

const SNIPPET_CHARS: usize = 220;

pub struct SearchRequest<'a> {
    pub query: &'a str,
    pub domain: Option<&'a str>,
    /// Search these domains together, ranked as one corpus, instead of
    /// `domain`: a whole vault at once. `None` searches `domain` alone.
    pub domains: Option<&'a [String]>,
    pub limit: usize,
    pub include_legacy: bool,
    pub ranking: RankOptions,
    /// Links to rank with instead of the domain's stored ones. Evaluation
    /// ablations set this; everything else passes `None`.
    pub edges: Option<&'a [Edge]>,
    /// Whose view to rank: notes it may not see are left out. `None` (the CLI
    /// and evaluation) sees everything; MCP always passes its session's viewer.
    pub viewer: Option<&'a Viewer>,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct SearchHit {
    pub id: Uuid,
    pub key: String,
    /// The note's domain, for vault-wide searches. Not serialized, so
    /// `kioku search` prints what it always has.
    #[serde(skip)]
    pub domain: String,
    pub title: String,
    pub status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub snippet: String,
    /// Fused relevance in [0, 1]. It ranks results; it is not a truth score.
    pub score: f64,
    /// How the note matched: exact label, search, or an explicit link.
    #[serde(rename = "match")]
    pub kind: MatchKind,
    /// Key of the top match whose explicit link surfaced this note.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linked_from: Option<String>,
    pub signals: Signals,
}

/// Raw ranking signals, for debugging and evaluation.
#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct Signals {
    /// Cosine similarity from the vector index, when it matched.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dense: Option<f64>,
    /// BM25 score, when lexical terms matched.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lexical: Option<f64>,
    /// Lifecycle retention in [0, 1].
    pub retention: f64,
}

pub struct SearchResults {
    pub hits: Vec<SearchHit>,
    /// Non-fatal problems, such as the embedding service being unavailable.
    pub warnings: Vec<String>,
    pub stats: SearchStats,
}

/// What one search did: candidate counts per signal and time per stage. Logged
/// on the `search` span and shown by `kioku search --explain`.
#[derive(Clone, Debug, Default, Serialize)]
pub struct SearchStats {
    /// Notes ranked (the domain, filtered by status).
    pub notes: usize,
    /// Notes not yet in the vector index; they can match only by keyword.
    pub unsynced: usize,
    /// Points the vector index returned.
    pub dense_candidates: usize,
    /// Points dropped as stale (revision mismatch) or no longer in scope.
    pub dense_stale: usize,
    /// Links available to graph expansion.
    pub links: usize,
    /// Results that entered through a link.
    pub link_hits: usize,
    /// Notes read from PostgreSQL to bring this process's index up to date:
    /// the whole domain the first time, then only what changed.
    pub refreshed: usize,
    /// Checking (and if needed refreshing) the index.
    pub load_ms: f64,
    /// Embedding the query and the vector index's search. It runs while the
    /// index is checked and BM25 scores, so it overlaps those stages.
    pub dense_ms: f64,
    /// BM25 scoring and exact label matches.
    pub lexical_ms: f64,
    /// Graph expansion.
    pub graph_ms: f64,
    /// Everything after the signals: fusion, graph expansion, and reading
    /// the hits' text.
    pub rank_ms: f64,
}

fn elapsed_ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

/// Drop the notes `viewer` may not see, and return their ids.
pub(super) fn hide(notes: &mut Vec<Note>, viewer: Option<&Viewer>) -> HashSet<Uuid> {
    let mut hidden = HashSet::new();
    if let Some(viewer) = viewer {
        notes.retain(|note| {
            let visible = viewer.sees(note);
            if !visible {
                hidden.insert(note.id);
            }
            visible
        });
    }
    hidden
}

/// The ranked notes of one search, across the views of its domains.
struct Ranking<'a> {
    views: &'a [View<'a>],
    now: DateTime<Utc>,
    half_life_days: f64,
    /// Links to rank with instead of the stored ones (evaluation ablations).
    edges: Option<HashMap<Uuid, Vec<(Uuid, f64)>>>,
}

impl Ranking<'_> {
    fn entry(&self, id: Uuid) -> Option<&Entry> {
        self.views.iter().find_map(|view| view.entry(id))
    }
}

impl Candidates for Ranking<'_> {
    fn contains(&self, id: Uuid) -> bool {
        self.entry(id).is_some()
    }

    fn unembedded(&self, id: Uuid) -> bool {
        self.entry(id).is_some_and(|e| e.unembedded)
    }

    fn retention(&self, id: Uuid) -> f64 {
        self.entry(id)
            .map_or(0.0, |e| e.retention(self.now, self.half_life_days))
    }

    fn links(&self, id: Uuid) -> Option<Vec<(Uuid, f64)>> {
        let stored = match &self.edges {
            Some(edges) => edges.get(&id).map(Vec::as_slice),
            None => self.views.iter().find_map(|view| view.links(id)),
        };
        Some(
            stored
                .unwrap_or_default()
                .iter()
                .filter(|(other, _)| self.contains(*other))
                .copied()
                .collect(),
        )
    }
}

/// Links grouped by note, as [`graph::link_weights`] builds them.
fn link_map(edges: &[Edge]) -> HashMap<Uuid, Vec<(Uuid, f64)>> {
    let mut raw: HashMap<Uuid, Vec<(Uuid, f64)>> = HashMap::new();
    for edge in edges {
        raw.entry(edge.source)
            .or_default()
            .push((edge.target, edge.weight));
        raw.entry(edge.target)
            .or_default()
            .push((edge.source, edge.weight));
    }
    raw.into_iter()
        .map(|(id, links)| (id, graph::link_weights(links, id)))
        .collect()
}

impl App {
    #[tracing::instrument(
        name = "search",
        skip_all,
        fields(domain, limit = request.limit, notes, link_hits, total_ms)
    )]
    pub async fn search(&self, request: &SearchRequest<'_>) -> Result<SearchResults> {
        let started = Instant::now();
        let query = request.query.trim();
        if query.is_empty() || query.len() > 4000 {
            invalid!("query must contain 1 to 4000 bytes");
        }
        if !(1..=20).contains(&request.limit) {
            invalid!("limit must be between 1 and 20");
        }
        let domain = self.domain(request.domain);
        let mut domains: Vec<String> = match request.domains {
            Some(domains) => domains.to_vec(),
            None => vec![domain.to_owned()],
        };
        domains.sort();
        domains.dedup();
        let span = tracing::Span::current();
        span.record("domain", domains.join(",").as_str());
        let mut stats = SearchStats::default();
        // The query goes to the embedding service only if that service may
        // read a searched domain; otherwise none of their notes has a vector.
        // It is embedded while the index is checked.
        let embedding = domains
            .iter()
            .any(|domain| self.embedder.reads_domain(domain))
            .then(|| {
                let embedder = self.embedder.clone();
                let text = query.to_owned();
                tokio::spawn(async move {
                    let started = Instant::now();
                    (embedder.embed_query(&text).await, elapsed_ms(started))
                })
            });
        let stage = Instant::now();
        let ready = match self.search_indexes(&domains).await {
            Ok(ready) => ready,
            Err(error) => {
                if let Some(task) = &embedding {
                    task.abort();
                }
                return Err(error);
            }
        };
        stats.load_ms = elapsed_ms(stage);
        stats.refreshed = ready.refreshed;
        let views: Vec<View<'_>> = ready
            .indexes
            .iter()
            .zip(&domains)
            .filter_map(|(cached, domain)| {
                Some(cached.as_ref()?.index.view(request.include_legacy, |lock| {
                    request
                        .viewer
                        .is_none_or(|viewer| viewer.sees_locked(domain, lock))
                }))
            })
            .collect();
        stats.notes = views.iter().map(View::notes).sum::<u64>() as usize;
        if stats.notes == 0 {
            if let Some(task) = &embedding {
                task.abort();
            }
            return Ok(SearchResults {
                hits: Vec::new(),
                warnings: Vec::new(),
                stats,
            });
        }
        let mut warnings = Vec::new();
        let unsynced = views.iter().map(View::unsynced).sum::<u64>() as usize;
        stats.unsynced = unsynced;
        if unsynced > 0 {
            warnings.push(format!(
                "{unsynced} memories in this domain are not in the vector index yet and can only match by keyword; they are re-indexed automatically"
            ));
        }
        // Hidden notes are excluded in the vector index itself, so they take
        // no candidate slot.
        let mut hidden: Vec<Uuid> = views.iter().flat_map(View::hidden).collect();
        hidden.sort_unstable();
        let searched: Vec<&str> = domains.iter().map(String::as_str).collect();
        let dense = async {
            let Some(task) = embedding else {
                return Ok((Vec::new(), 0.0));
            };
            let (vector, embed_ms) = task.await.context("the query embedding task failed")?;
            let started = Instant::now();
            let hits = self
                .vector
                .search(
                    vector?,
                    Some(&searched),
                    request.include_legacy,
                    &hidden,
                    (request.limit * 10).clamp(50, 200),
                )
                .await?;
            anyhow::Ok((hits, embed_ms + elapsed_ms(started)))
        };
        let lexical = async {
            let started = Instant::now();
            let mut scores = Vec::new();
            if request.ranking.lexical {
                let terms: BTreeSet<String> = tokenize(query).into_iter().collect();
                let (weights, average_length) = corpus_weights(&views, &terms);
                for view in &views {
                    view.bm25(&weights, average_length, &mut scores);
                }
            }
            let mut exact: Vec<Uuid> = views.iter().flat_map(|view| view.exact(query)).collect();
            exact.sort();
            (scores, exact, elapsed_ms(started))
        };
        let (dense, (lexical, exact, lexical_ms)) = tokio::join!(dense, lexical);
        stats.lexical_ms = lexical_ms;
        let dense: HashMap<Uuid, f64> = match dense {
            Ok((hits, dense_ms)) => {
                stats.dense_ms = dense_ms;
                stats.dense_candidates = hits.len();
                // PostgreSQL is authoritative even if a vector payload is stale.
                let scores: HashMap<Uuid, f64> = hits
                    .into_iter()
                    .filter(|hit| {
                        views
                            .iter()
                            .find_map(|view| view.entry(hit.id))
                            .is_some_and(|e| {
                                e.vector_synced
                                    && e.revision == hit.revision
                                    && hit.score.is_finite()
                            })
                    })
                    .map(|hit| (hit.id, hit.score.clamp(0.0, 1.0)))
                    .collect();
                stats.dense_stale = stats.dense_candidates - scores.len();
                scores
            }
            Err(error) if request.ranking.lexical => {
                tracing::warn!(error = format!("{error:#}"), "dense retrieval failed");
                warnings.push(format!(
                    "semantic search is unavailable ({error}); results use keyword matching only"
                ));
                HashMap::new()
            }
            Err(error) => return Err(error),
        };
        let stage = Instant::now();
        let candidates = Ranking {
            views: &views,
            now: Utc::now(),
            half_life_days: self.config.half_life_days,
            edges: request.edges.map(link_map),
        };
        stats.links = match request.edges {
            Some(edges) => edges.len(),
            None => ready
                .indexes
                .iter()
                .filter_map(|cached| Some(cached.as_ref()?.index.link_count()))
                .sum(),
        };
        let signals = rank::Signals {
            dense: &dense,
            lexical,
            exact,
        };
        let direct = Direct::new(&signals, &candidates, request.ranking);
        let ranked = if request.ranking.graph && !direct.is_empty() {
            let started = Instant::now();
            let mut walk = graph::LocalPagerank::new(&direct.seeds(), rank::EXPANSION_RESTART);
            walk.run(|id| candidates.links(id));
            let ranked = direct.expand(&walk.into_masses(), &candidates, request.limit);
            stats.graph_ms = elapsed_ms(started);
            ranked
        } else {
            direct.truncate(request.limit)
        };
        let hits = self.hits(ranked, &candidates, request).await?;
        stats.rank_ms = elapsed_ms(stage);
        stats.link_hits = hits.iter().filter(|h| h.kind == MatchKind::Link).count();
        span.record("notes", stats.notes);
        span.record("link_hits", stats.link_hits);
        span.record("total_ms", elapsed_ms(started));
        tracing::debug!(?stats, "search finished");
        Ok(SearchResults {
            hits,
            warnings,
            stats,
        })
    }

    /// Read the ranked notes' text for the results. A note that changed since
    /// the index was checked so that the caller may no longer see it, or that
    /// left the searched status, is left out.
    async fn hits(
        &self,
        ranked: Vec<Ranked>,
        candidates: &Ranking<'_>,
        request: &SearchRequest<'_>,
    ) -> Result<Vec<SearchHit>> {
        let ids: Vec<Uuid> = ranked.iter().map(|r| r.id).collect();
        let mut fields: HashMap<Uuid, HitFields> = self
            .store
            .search_hits(&ids)
            .await?
            .into_iter()
            .map(|f| (f.id, f))
            .collect();
        Ok(ranked
            .into_iter()
            .filter_map(|r| {
                let note = fields.remove(&r.id)?;
                let visible = request
                    .viewer
                    .is_none_or(|viewer| viewer.sees_locked(&note.domain, &note.lock))
                    && (request.include_legacy || note.status == Status::Active);
                visible.then(|| SearchHit {
                    id: note.id,
                    key: note.key,
                    domain: note.domain,
                    title: note.title,
                    status: note.status,
                    source: note.source,
                    snippet: truncate_chars(&note.body, SNIPPET_CHARS),
                    score: r.score,
                    kind: r.kind,
                    linked_from: r
                        .linked_from
                        .and_then(|id| candidates.entry(id))
                        .map(|e| e.key.clone()),
                    signals: Signals {
                        dense: r.dense,
                        lexical: r.lexical,
                        retention: r.retention,
                    },
                })
            })
            .collect())
    }

    /// A note and its explicit links. With a viewer, a note it may not see is
    /// not found, and neighbors it may not see are left out.
    pub async fn graph_context(
        &self,
        id: Uuid,
        domain: Option<&str>,
        include_legacy: bool,
        viewer: Option<&Viewer>,
    ) -> Result<Value> {
        let note = self.require_note(id, domain).await?;
        if viewer.is_some_and(|viewer| !viewer.sees(&note)) {
            not_found!("no memory {id} in domain {:?}", self.domain(domain));
        }
        if !include_legacy && note.status == Status::Legacy {
            invalid!(
                "memory {:?} is legacy; set include_legacy to inspect it",
                note.input.key
            );
        }
        let edges = self.store.edges(Some(&note.input.domain)).await?;
        let mut notes = self
            .store
            .notes(Some(&note.input.domain), include_legacy)
            .await?;
        hide(&mut notes, viewer);
        let by_id: HashMap<_, _> = notes.iter().map(|n| (n.id, n)).collect();
        let mut neighbors = Vec::new();
        for edge in edges.iter().filter(|e| e.source == id || e.target == id) {
            let other = if edge.source == id {
                edge.target
            } else {
                edge.source
            };
            if let Some(other) = by_id.get(&other) {
                neighbors.push(json!({
                    "id": other.id,
                    "key": other.input.key,
                    "title": other.input.title,
                    "kind": edge.kind,
                    "status": other.status,
                    "direction": if edge.source == id { "outgoing" } else { "incoming" },
                }));
            }
        }
        let total = neighbors.len();
        neighbors.truncate(50);
        Ok(json!({
            "id": id,
            "key": note.input.key,
            "domain": note.input.domain,
            "title": note.input.title,
            "neighbors": neighbors,
            "total_neighbors": total,
            "truncated": total > 50,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_hits_serialize_as_before_vaults() {
        let hit = SearchHit {
            id: Uuid::nil(),
            key: "k".into(),
            domain: "local".into(),
            title: "T".into(),
            status: Status::Active,
            source: None,
            snippet: "s".into(),
            score: 0.5,
            kind: MatchKind::Search,
            linked_from: None,
            signals: Signals {
                dense: None,
                lexical: Some(1.0),
                retention: 0.8,
            },
        };
        let value = serde_json::to_value(&hit).unwrap();
        let mut fields: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        fields.sort_unstable();
        assert_eq!(
            fields,
            [
                "id", "key", "match", "score", "signals", "snippet", "status", "title"
            ]
        );
    }
}

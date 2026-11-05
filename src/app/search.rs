//! Ranked search and graph lookups around a note.
//!
//! With a [`Viewer`], notes it may not see are dropped before ranking, and so
//! are vector hits and links that touch them, so a hidden note can neither be
//! returned nor shift the ranking of visible ones.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::time::Instant;

use anyhow::Result;
use chrono::Utc;
use schemars::JsonSchema;
use serde::Serialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::error::{invalid, not_found};
use crate::model::{Edge, Note, Status};
use crate::rank::{self, MatchKind, RankInput, RankOptions};
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
    pub load_ms: f64,
    pub dense_ms: f64,
    pub rank_ms: f64,
}

/// Dense scores plus what the vector index returned, for [`SearchStats`].
struct Dense {
    scores: HashMap<Uuid, f64>,
    candidates: usize,
    stale: usize,
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
        let one = [domain.to_owned()];
        let domains: &[String] = request.domains.unwrap_or(&one);
        let span = tracing::Span::current();
        span.record("domain", domains.join(",").as_str());
        let mut stats = SearchStats::default();
        let stage = Instant::now();
        // A restricting viewer needs every note, legacy ones included, to
        // know which links touch notes it may not see.
        let restricted = request.viewer.is_some_and(Viewer::restricts_notes);
        let load_legacy = request.include_legacy || restricted;
        let mut notes = match domains {
            [domain] => self.store.notes(Some(domain), load_legacy).await?,
            several => self.store.notes_in(several, load_legacy).await?,
        };
        let hidden = hide(&mut notes, request.viewer);
        if restricted && !request.include_legacy {
            notes.retain(|note| note.status == Status::Active);
        }
        stats.load_ms = elapsed_ms(stage);
        stats.notes = notes.len();
        if notes.is_empty() {
            return Ok(SearchResults {
                hits: Vec::new(),
                warnings: Vec::new(),
                stats,
            });
        }
        let mut warnings = Vec::new();
        let unsynced = notes.iter().filter(|n| !n.vector_synced).count();
        stats.unsynced = unsynced;
        if unsynced > 0 {
            warnings.push(format!(
                "{unsynced} memories in this domain are not in the vector index yet and can only match by keyword; they are re-indexed automatically"
            ));
        }
        let stage = Instant::now();
        let dense = match self.dense_scores(query, domains, &notes, request).await {
            Ok(dense) => {
                stats.dense_candidates = dense.candidates;
                stats.dense_stale = dense.stale;
                dense.scores
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
        stats.dense_ms = elapsed_ms(stage);
        let stage = Instant::now();
        let mut edges: Cow<'_, [Edge]> = match request.edges {
            Some(edges) => Cow::Borrowed(edges),
            None if request.ranking.graph => Cow::Owned(match domains {
                [domain] => self.store.edges(Some(domain)).await?,
                several => self.store.edges_in(several).await?,
            }),
            None => Cow::Borrowed(&[]),
        };
        if !hidden.is_empty() {
            edges = Cow::Owned(
                edges
                    .iter()
                    .filter(|e| !hidden.contains(&e.source) && !hidden.contains(&e.target))
                    .cloned()
                    .collect(),
            );
        }
        let edges: &[Edge] = &edges;
        stats.links = edges.len();
        let ranked = rank::rank(
            &RankInput {
                notes: &notes,
                edges,
                dense: &dense,
                query,
                limit: request.limit,
                now: Utc::now(),
                half_life_days: self.config.half_life_days,
            },
            request.ranking,
        );
        let by_id: HashMap<Uuid, &Note> = notes.iter().map(|n| (n.id, n)).collect();
        let hits = ranked
            .into_iter()
            .filter_map(|r| {
                let note = by_id.get(&r.id)?;
                Some(SearchHit {
                    id: note.id,
                    key: note.input.key.clone(),
                    domain: note.input.domain.clone(),
                    title: note.input.title.clone(),
                    status: note.status,
                    source: note.input.source.clone(),
                    snippet: truncate_chars(&note.input.body, SNIPPET_CHARS),
                    score: r.score,
                    kind: r.kind,
                    linked_from: r
                        .linked_from
                        .and_then(|id| by_id.get(&id))
                        .map(|n| n.input.key.clone()),
                    signals: Signals {
                        dense: r.dense,
                        lexical: r.lexical,
                        retention: r.retention,
                    },
                })
            })
            .collect::<Vec<_>>();
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

    /// Cosine similarity for notes whose indexed revision is current.
    /// PostgreSQL is authoritative even if a vector payload is stale.
    async fn dense_scores(
        &self,
        query: &str,
        domains: &[String],
        notes: &[Note],
        request: &SearchRequest<'_>,
    ) -> Result<Dense> {
        let vector = self.embedder.embed_query(query).await?;
        let domains: Vec<&str> = domains.iter().map(String::as_str).collect();
        let hits = self
            .vector
            .search(
                vector,
                Some(&domains),
                request.include_legacy,
                (request.limit * 10).clamp(50, 200),
            )
            .await?;
        let by_id: HashMap<Uuid, &Note> = notes.iter().map(|n| (n.id, n)).collect();
        let candidates = hits.len();
        let scores: HashMap<Uuid, f64> = hits
            .into_iter()
            .filter(|hit| {
                by_id.get(&hit.id).is_some_and(|note| {
                    note.vector_synced && note.revision == hit.revision && hit.score.is_finite()
                })
            })
            .map(|hit| (hit.id, hit.score.clamp(0.0, 1.0)))
            .collect();
        Ok(Dense {
            stale: candidates - scores.len(),
            candidates,
            scores,
        })
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

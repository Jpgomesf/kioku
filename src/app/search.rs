//! Ranked search and graph lookups around a note.

use std::collections::HashMap;

use anyhow::Result;
use chrono::Utc;
use schemars::JsonSchema;
use serde::Serialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::error::invalid;
use crate::model::{Note, Status};
use crate::rank::{self, MatchKind, RankInput, RankOptions};
use crate::text::truncate_chars;

use super::App;

const SNIPPET_CHARS: usize = 220;

pub struct SearchRequest<'a> {
    pub query: &'a str,
    pub domain: Option<&'a str>,
    pub limit: usize,
    pub include_legacy: bool,
    pub ranking: RankOptions,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct SearchHit {
    pub id: Uuid,
    pub key: String,
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
}

impl App {
    pub async fn search(&self, request: &SearchRequest<'_>) -> Result<SearchResults> {
        let query = request.query.trim();
        if query.is_empty() || query.len() > 4000 {
            invalid!("query must contain 1 to 4000 bytes");
        }
        if !(1..=20).contains(&request.limit) {
            invalid!("limit must be between 1 and 20");
        }
        let domain = self.domain(request.domain);
        let notes = self
            .store
            .notes(Some(domain), request.include_legacy)
            .await?;
        if notes.is_empty() {
            return Ok(SearchResults {
                hits: Vec::new(),
                warnings: Vec::new(),
            });
        }
        let mut warnings = Vec::new();
        let unsynced = notes.iter().filter(|n| !n.vector_synced).count();
        if unsynced > 0 {
            warnings.push(format!(
                "{unsynced} memories in this domain are not in the vector index yet and can only match by keyword; they are re-indexed automatically"
            ));
        }
        let dense = match self.dense_scores(query, domain, &notes, request).await {
            Ok(dense) => dense,
            Err(error) if request.ranking.lexical => {
                tracing::warn!(error = format!("{error:#}"), "dense retrieval failed");
                warnings.push(format!(
                    "semantic search is unavailable ({error}); results use keyword matching only"
                ));
                HashMap::new()
            }
            Err(error) => return Err(error),
        };
        let edges = if request.ranking.graph {
            self.store.edges(Some(domain)).await?
        } else {
            Vec::new()
        };
        let ranked = rank::rank(
            &RankInput {
                notes: &notes,
                edges: &edges,
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
            .collect();
        Ok(SearchResults { hits, warnings })
    }

    /// Cosine similarity for notes whose indexed revision is current.
    /// PostgreSQL is authoritative even if a vector payload is stale.
    async fn dense_scores(
        &self,
        query: &str,
        domain: &str,
        notes: &[Note],
        request: &SearchRequest<'_>,
    ) -> Result<HashMap<Uuid, f64>> {
        let vector = self.embedder.embed_query(query).await?;
        let hits = self
            .vector
            .search(
                vector,
                Some(domain),
                request.include_legacy,
                (request.limit * 10).clamp(50, 200),
            )
            .await?;
        let by_id: HashMap<Uuid, &Note> = notes.iter().map(|n| (n.id, n)).collect();
        Ok(hits
            .into_iter()
            .filter(|hit| {
                by_id.get(&hit.id).is_some_and(|note| {
                    note.vector_synced && note.revision == hit.revision && hit.score.is_finite()
                })
            })
            .map(|hit| (hit.id, hit.score.clamp(0.0, 1.0)))
            .collect())
    }

    pub async fn graph_context(
        &self,
        id: Uuid,
        domain: Option<&str>,
        include_legacy: bool,
    ) -> Result<Value> {
        let note = self.require_note(id, domain).await?;
        if !include_legacy && note.status == Status::Legacy {
            invalid!(
                "memory {:?} is legacy; set include_legacy to inspect it",
                note.input.key
            );
        }
        let edges = self.store.edges(Some(&note.input.domain)).await?;
        let notes = self
            .store
            .notes(Some(&note.input.domain), include_legacy)
            .await?;
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

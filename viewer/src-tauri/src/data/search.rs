//! Search, ranked by kioku's own ranker over the same signals as
//! `kioku::app::App::search`, without `App` (which writes when it connects).

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use chrono::Utc;
use kioku::model::{Edge, Note};
use kioku::rank::{self, MatchKind, RankInput, RankOptions, Ranked};
use uuid::Uuid;

use crate::commands::search::{MatchedBy, SearchHit};
use crate::data::notes;
use crate::state::ReadOnly;

/// Characters of body text in a snippet, as in kioku.
const SNIPPET_CHARS: usize = 220;
/// Budget for each of the embedding and vector calls. Past it, search falls
/// back to keywords instead of waiting on a slow or hung service.
const DENSE_BUDGET: Duration = Duration::from_secs(3);

/// What the matched signals were, for one ranked note.
pub fn matched_by(ranked: &Ranked) -> Vec<MatchedBy> {
    match ranked.kind {
        MatchKind::Exact => vec![MatchedBy::Label],
        MatchKind::Link => vec![MatchedBy::Linked],
        MatchKind::Search => {
            let mut out = Vec::new();
            if ranked.lexical.is_some() {
                out.push(MatchedBy::Text);
            }
            if ranked.dense.is_some() {
                out.push(MatchedBy::Meaning);
            }
            if out.is_empty() {
                out.push(MatchedBy::Text);
            }
            out
        }
    }
}

/// Cosine scores from the vector index, for notes whose vector is current.
/// A failure means keyword search only, as in kioku.
async fn dense_scores(
    services: &ReadOnly,
    query: &str,
    domains: &[String],
    notes: &[Note],
    include_legacy: bool,
    limit: usize,
) -> HashMap<Uuid, f64> {
    if !domains.iter().any(|d| services.embedder.reads_domain(d)) {
        return HashMap::new();
    }
    let Ok(Ok(vector)) =
        tokio::time::timeout(DENSE_BUDGET, services.embedder.embed_query(query)).await
    else {
        return HashMap::new();
    };
    let names: Vec<&str> = domains.iter().map(String::as_str).collect();
    let Ok(Ok(hits)) = tokio::time::timeout(
        DENSE_BUDGET,
        services.vector.search(
            vector,
            Some(&names),
            include_legacy,
            &[],
            (limit * 10).clamp(50, 200),
        ),
    )
    .await
    else {
        return HashMap::new();
    };
    let by_id: HashMap<Uuid, &Note> = notes.iter().map(|n| (n.id, n)).collect();
    hits.into_iter()
        .filter(|hit| {
            by_id.get(&hit.id).is_some_and(|note| {
                note.vector_synced && note.revision == hit.revision && hit.score.is_finite()
            })
        })
        .map(|hit| (hit.id, hit.score.clamp(0.0, 1.0)))
        .collect()
}

/// Rank `domains` for `query`.
pub async fn search(
    services: &ReadOnly,
    query: &str,
    domains: &[String],
    limit: usize,
    include_legacy: bool,
) -> anyhow::Result<Vec<SearchHit>> {
    let notes = services.store.notes_in(domains, include_legacy).await?;
    if notes.is_empty() {
        return Ok(Vec::new());
    }
    let dense = dense_scores(services, query, domains, &notes, include_legacy, limit).await;
    let loaded: HashSet<Uuid> = notes.iter().map(|n| n.id).collect();
    let edges: Vec<Edge> = services
        .store
        .edges_in(domains)
        .await?
        .into_iter()
        .filter(|e| loaded.contains(&e.source) && loaded.contains(&e.target))
        .collect();
    let unembedded: HashSet<Uuid> = notes
        .iter()
        .filter(|n| !services.embedder.reads(&n.input))
        .map(|n| n.id)
        .collect();
    let ranked = rank::rank(
        &RankInput {
            notes: &notes,
            edges: &edges,
            dense: &dense,
            unembedded: &unembedded,
            query,
            limit,
            now: Utc::now(),
            half_life_days: services.config.half_life_days,
        },
        RankOptions::HYBRID_GRAPH,
    );
    let links = notes::link_counts(&edges);
    let root = services.config.notes_root.as_deref();
    let by_id: HashMap<Uuid, &Note> = notes.iter().map(|n| (n.id, n)).collect();
    Ok(ranked
        .iter()
        .filter_map(|r| {
            let note = by_id.get(&r.id)?;
            Some(SearchHit {
                note: notes::summary(note, links.get(&note.id).copied().unwrap_or(0), root),
                score: r.score,
                matched_by: matched_by(r),
                linked_from: r
                    .linked_from
                    .and_then(|id| by_id.get(&id))
                    .map(|n| n.input.title.clone()),
                snippet: kioku::text::truncate_chars(&note.input.body, SNIPPET_CHARS),
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ranked(kind: MatchKind, lexical: Option<f64>, dense: Option<f64>) -> Ranked {
        Ranked {
            id: Uuid::nil(),
            score: 0.5,
            kind,
            linked_from: None,
            dense,
            lexical,
            retention: 1.0,
        }
    }

    #[test]
    fn signals_map_to_matched_by() {
        assert_eq!(
            matched_by(&ranked(MatchKind::Exact, None, None)),
            [MatchedBy::Label]
        );
        assert_eq!(
            matched_by(&ranked(MatchKind::Link, None, None)),
            [MatchedBy::Linked]
        );
        assert_eq!(
            matched_by(&ranked(MatchKind::Search, Some(1.0), Some(0.7))),
            [MatchedBy::Text, MatchedBy::Meaning]
        );
        assert_eq!(
            matched_by(&ranked(MatchKind::Search, None, Some(0.7))),
            [MatchedBy::Meaning]
        );
    }
}

//! Search with BM25 scored in Qdrant (`MEMORY_LEXICAL=qdrant`).
//!
//! One batch request to Qdrant returns the dense, BM25, and exact-label
//! candidates, each filtered to the notes the caller may see, with BM25's
//! statistics counted over those same notes. No process loads a domain:
//! PostgreSQL supplies only the candidates, checked again for visibility and
//! freshness, and the links around the top matches, read in a few waves for
//! local PageRank. Fusion, the retention prior, and graph slots are the same
//! code as the in-process path ([`crate::rank`]).

use std::collections::{BTreeSet, HashMap};
use std::time::Instant;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::graph::{self, LocalPagerank};
use crate::lifecycle;
use crate::model::{SearchFields, Status, VectorHit};
use crate::rank::{self, Candidates, Direct, MatchKind, normalize_label, tokenize};
use crate::vault::Viewer;
use crate::vector::{HybridQuery, Scope};

use super::App;
use super::search::{SearchRequest, SearchResults, SearchStats, elapsed_ms};

/// Waves of links read around the top matches, one query each. The walk stops
/// at the notes the last wave reached, which costs graph slots almost nothing:
/// at a restart of 0.5, little probability travels further.
const LINK_WAVES: usize = 3;

/// BM25 candidates asked of Qdrant. In-process BM25 ranks every match; past
/// this rank, a lexical match adds less than 0.004 to a note's fused score.
const LEXICAL_CANDIDATES: usize = 200;

/// The notes one search ranks, read from PostgreSQL as it needs them.
struct Fetched {
    /// Candidates and linked notes the caller may see, in a searched status,
    /// with whether the embedding service may not read them.
    notes: HashMap<Uuid, (SearchFields, bool)>,
    /// Links of the notes whose links were read, before visibility.
    links: HashMap<Uuid, Vec<(Uuid, f64)>>,
    now: DateTime<Utc>,
    half_life_days: f64,
}

impl Candidates for Fetched {
    fn contains(&self, id: Uuid) -> bool {
        self.notes.contains_key(&id)
    }

    fn unembedded(&self, id: Uuid) -> bool {
        self.notes
            .get(&id)
            .is_some_and(|(_, unembedded)| *unembedded)
    }

    fn retention(&self, id: Uuid) -> f64 {
        self.notes.get(&id).map_or(0.0, |(note, _)| {
            lifecycle::retention_of(&note.usage, self.now, self.half_life_days)
        })
    }

    fn links(&self, id: Uuid) -> Option<Vec<(Uuid, f64)>> {
        let links = self.links.get(&id)?;
        Some(graph::link_weights(
            links
                .iter()
                .filter(|(other, _)| self.contains(*other))
                .copied(),
            id,
        ))
    }
}

impl App {
    /// Rank with BM25 in Qdrant. If Qdrant can't answer, the in-process path
    /// ranks instead, as keyword search did before.
    pub(super) async fn search_in_qdrant(
        &self,
        request: &SearchRequest<'_>,
        query: &str,
        domains: &[String],
    ) -> Result<SearchResults> {
        let mut stats = SearchStats::default();
        let mut warnings = Vec::new();
        // The MCP layer checked the domains; the CLI and evaluation see all.
        let mut searched = Vec::new();
        for domain in domains {
            if request
                .viewer
                .map_or(Ok(true), |viewer| viewer.sees_domain(domain))?
            {
                searched.push(domain.clone());
            }
        }
        if searched.is_empty() {
            return Ok(SearchResults {
                hits: Vec::new(),
                warnings,
                stats,
            });
        }
        let embedding = self.embed_in_background(query, &searched);
        let stage = Instant::now();
        // A note written since its point was may have a stale payload, so its
        // point is left out of results and statistics until the index catches
        // up.
        let mut pending = match self
            .store
            .unsynced_in(&searched, request.include_legacy)
            .await
        {
            Ok(ids) => ids,
            Err(error) => {
                if let Some(task) = &embedding {
                    task.abort();
                }
                return Err(error);
            }
        };
        pending.sort_unstable();
        stats.unsynced = pending.len();
        if !pending.is_empty() {
            warnings.push(format!(
                "{} memories in this domain are waiting for the vector index; with BM25 in Qdrant they can't be found until it catches up, which happens automatically",
                pending.len()
            ));
        }
        stats.load_ms = elapsed_ms(stage);
        let (vector, embed_ms) = match embedding {
            None => (None, 0.0),
            Some(task) => match task.await.context("the query embedding task failed") {
                Ok((Ok(vector), ms)) => (Some(vector), ms),
                Ok((Err(error), _)) | Err(error) if request.ranking.lexical => {
                    tracing::warn!(error = format!("{error:#}"), "dense retrieval failed");
                    warnings.push(format!(
                        "semantic search is unavailable ({error}); results use keyword matching only"
                    ));
                    (None, 0.0)
                }
                Ok((Err(error), _)) | Err(error) => return Err(error),
            },
        };
        let terms: Vec<String> = if request.ranking.lexical {
            let unique: BTreeSet<String> = tokenize(query).into_iter().collect();
            unique.into_iter().collect()
        } else {
            Vec::new()
        };
        let label = normalize_label(query);
        let provider = request.viewer.and_then(Viewer::lock_reader);
        let names: Vec<&str> = searched.iter().map(String::as_str).collect();
        let started = Instant::now();
        let hits = match self
            .vector
            .hybrid(
                &HybridQuery {
                    vector,
                    terms: &terms,
                    label: (!label.is_empty()).then_some(label.as_str()),
                    dense_limit: (request.limit * 10).clamp(50, 200),
                    lexical_limit: LEXICAL_CANDIDATES,
                },
                &Scope {
                    domains: &names,
                    include_legacy: request.include_legacy,
                    exclude: &pending,
                    provider: provider.map(|p| p.as_str()),
                },
            )
            .await
        {
            Ok(hits) => hits,
            Err(error) => {
                tracing::warn!(error = format!("{error:#}"), "search in Qdrant failed");
                let mut results = self.search_in_process(request, query, domains).await?;
                results.warnings.push(format!(
                    "BM25 in Qdrant is unavailable ({error}); this search ranked in this process instead"
                ));
                return Ok(results);
            }
        };
        stats.dense_ms = embed_ms + elapsed_ms(started);

        // PostgreSQL decides what may be returned.
        let admits = |note: &SearchFields| {
            searched.contains(&note.domain)
                && (request.include_legacy || note.status == Status::Active)
                && request
                    .viewer
                    .is_none_or(|viewer| viewer.sees_locked(&note.domain, &note.lock))
        };
        let stage = Instant::now();
        let mut ids: Vec<Uuid> = hits
            .dense
            .iter()
            .chain(&hits.lexical)
            .chain(&hits.exact)
            .map(|hit| hit.id)
            .collect();
        if let Some(edges) = request.edges {
            ids.extend(edges.iter().flat_map(|e| [e.source, e.target]));
        }
        ids.sort_unstable();
        ids.dedup();
        let mut fetched = Fetched {
            notes: HashMap::new(),
            links: HashMap::new(),
            now: Utc::now(),
            half_life_days: self.config.half_life_days,
        };
        for note in self.store.search_candidates(&ids).await? {
            if admits(&note) {
                let unembedded = !self.embedder.reads_locked(&note.domain, &note.lock);
                fetched.notes.insert(note.id, (note, unembedded));
            }
        }
        stats.load_ms += elapsed_ms(stage);
        // A point is current when PostgreSQL holds the revision it was
        // written at; otherwise its payload may be stale.
        let current = |hit: &VectorHit| {
            hit.score.is_finite()
                && fetched
                    .notes
                    .get(&hit.id)
                    .is_some_and(|(note, _)| note.vector_synced && note.revision == hit.revision)
        };
        let dense: HashMap<Uuid, f64> = hits
            .dense
            .iter()
            .filter(|hit| current(hit))
            .map(|hit| (hit.id, hit.score.clamp(0.0, 1.0)))
            .collect();
        stats.dense_candidates = hits.dense.len();
        stats.dense_stale = hits.dense.len() - dense.len();
        let lexical: Vec<(Uuid, f64)> = hits
            .lexical
            .iter()
            .filter(|hit| current(hit))
            .map(|hit| (hit.id, hit.score))
            .collect();
        let mut exact: Vec<Uuid> = hits
            .exact
            .iter()
            .filter(|hit| current(hit))
            .map(|hit| hit.id)
            .collect();
        exact.sort();
        stats.notes = fetched.notes.len();

        let stage = Instant::now();
        let signals = rank::Signals {
            dense: &dense,
            lexical,
            exact,
        };
        let direct = Direct::new(&signals, &fetched, request.ranking);
        let ranked = if request.ranking.graph && !direct.is_empty() {
            let started = Instant::now();
            if let Some(edges) = request.edges {
                for edge in edges {
                    fetched
                        .links
                        .entry(edge.source)
                        .or_default()
                        .push((edge.target, edge.weight));
                    fetched
                        .links
                        .entry(edge.target)
                        .or_default()
                        .push((edge.source, edge.weight));
                }
            }
            let mut walk = LocalPagerank::new(&direct.seeds(), rank::EXPANSION_RESTART);
            for wave in 0..=LINK_WAVES {
                let missing = walk.run(|id| {
                    if request.edges.is_some() {
                        return Some(fetched.links(id).unwrap_or_default());
                    }
                    fetched.links(id)
                });
                if missing.is_empty() || wave == LINK_WAVES {
                    break;
                }
                for (near, weight, far) in self.store.search_links(&missing).await? {
                    stats.links += 1;
                    fetched
                        .links
                        .entry(near)
                        .or_default()
                        .push((far.id, weight));
                    if admits(&far) && !fetched.notes.contains_key(&far.id) {
                        let unembedded = !self.embedder.reads_locked(&far.domain, &far.lock);
                        fetched.notes.insert(far.id, (far, unembedded));
                    }
                }
                for id in missing {
                    fetched.links.entry(id).or_default();
                }
            }
            let ranked = direct.expand(&walk.into_masses(), &fetched, request.limit);
            stats.graph_ms = elapsed_ms(started);
            ranked
        } else {
            direct.truncate(request.limit)
        };
        let hits = self
            .hits(ranked, request, |id| {
                fetched.notes.get(&id).map(|(note, _)| note.key.clone())
            })
            .await?;
        stats.rank_ms = elapsed_ms(stage);
        stats.link_hits = hits.iter().filter(|h| h.kind == MatchKind::Link).count();
        Ok(SearchResults {
            hits,
            warnings,
            stats,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use anyhow::Result;
    use uuid::Uuid;

    use crate::access::Principal;
    use crate::app::{App, SearchHit, SearchRequest};
    use crate::config::Config;
    use crate::model::NoteInput;
    use crate::rank::RankOptions;
    use crate::testing::ScratchDatabase;
    use crate::vault::{Session, Vaults, Viewer};

    /// An app with BM25 in Qdrant over a scratch database and a new
    /// collection in the Qdrant at MEMORY_TEST_QDRANT_URL (its key in
    /// QDRANT_API_KEY), or `None` when that isn't set. The embedding service
    /// is unreachable, so search ranks by keyword, label, and link.
    async fn qdrant_app(url: &str) -> Result<Option<App>> {
        let Ok(qdrant) = std::env::var("MEMORY_TEST_QDRANT_URL") else {
            eprintln!("skipped: set MEMORY_TEST_QDRANT_URL to a test Qdrant");
            return Ok(None);
        };
        let key = std::env::var("QDRANT_API_KEY").ok();
        let collection = format!("kioku_test_{}", Uuid::new_v4().simple());
        let config = Config::from_lookup(|name| match name {
            "DATABASE_URL" => Some(url.to_owned()),
            "QDRANT_URL" => Some(qdrant.clone()),
            "QDRANT_API_KEY" => key.clone(),
            "QDRANT_COLLECTION" => Some(collection.clone()),
            "EMBEDDING_URL" => Some("http://127.0.0.1:9".to_owned()),
            "EMBEDDING_DIM" => Some("4".to_owned()),
            "MEMORY_LEXICAL" => Some("qdrant".to_owned()),
            _ => None,
        })?;
        Ok(Some(App::connect(config).await?))
    }

    fn input(domain: &str, key: &str, body: &str) -> NoteInput {
        let mut input = crate::testing::note(key, domain).input;
        input.body = body.to_owned();
        input
    }

    /// Save notes with points, as a save with a working embedder would.
    async fn index(app: &App, inputs: &[&NoteInput]) -> Result<()> {
        for input in inputs {
            let note = app.store.upsert(input).await?;
            app.vector
                .upsert_many(&[(note.clone(), vec![1.0, 0.0, 0.0, 0.0])])
                .await?;
            app.store.mark_synced(note.id, note.revision).await?;
        }
        let domain = &inputs[0].domain;
        let notes = app.store.notes(Some(domain), true).await?;
        app.store
            .replace_edges(domain, &crate::graph::resolve_edges(&notes))
            .await
    }

    async fn search(
        app: &App,
        domain: &str,
        query: &str,
        viewer: Option<&Viewer>,
    ) -> Result<Vec<SearchHit>> {
        let results = app
            .search(&SearchRequest {
                query,
                domain: Some(domain),
                domains: None,
                limit: 5,
                include_legacy: false,
                ranking: RankOptions::HYBRID_GRAPH,
                edges: None,
                viewer,
                lexical: None,
            })
            .await?;
        Ok(results.hits)
    }

    fn keys(hits: &[SearchHit]) -> Vec<&str> {
        hits.iter().map(|h| h.key.as_str()).collect()
    }

    /// Needs PostgreSQL and Qdrant; creates and drops its own database and collection.
    #[tokio::test]
    #[ignore = "requires PostgreSQL and Qdrant; set MEMORY_TEST_DATABASE_URL and MEMORY_TEST_QDRANT_URL"]
    async fn bm25_in_qdrant_never_returns_a_locked_note() -> Result<()> {
        let scratch = ScratchDatabase::create().await?;
        let outcome = match qdrant_app(&scratch.url).await {
            Ok(Some(app)) => {
                let outcome = locked_checks(&app).await;
                app.vector.delete_collection().await?;
                outcome
            }
            Ok(None) => Ok(()),
            Err(error) => Err(error),
        };
        scratch.drop_database().await?;
        outcome
    }

    async fn locked_checks(app: &App) -> Result<()> {
        let mut open = input("relay", "open", "The ledger retries writes three times.");
        open.related = vec!["sealed".into()];
        let plain = input("relay", "plain", "The ledger keeps every entry.");
        let mut sealed = input("relay", "sealed", "Ledger secret rotation is weekly.");
        sealed.aliases = vec!["sealed label".into()];
        sealed.lock = vec!["local".into()];
        index(app, &[&open, &plain, &sealed]).await?;
        // The same visible notes in another domain of the same collection,
        // without the locked note, plus notes that only that domain has.
        let mirror = |input: &NoteInput| NoteInput {
            domain: "mirror".into(),
            related: Vec::new(),
            ..input.clone()
        };
        let extra = input(
            "mirror",
            "extra",
            "Ledger ledger ledger exports run nightly.",
        );
        index(app, &[&mirror(&open), &mirror(&plain)]).await?;
        let vaults = Arc::new(Vaults::parse(
            "[[vault]]\nname = \"p\"\ndomains = [\"relay\", \"mirror\", \"other\"]\nproviders = [\"local\", \"anthropic\"]\ndefault_domain = \"relay\"\n",
            std::path::Path::new("/cfg/vaults.toml"),
            None,
        )?);
        let viewer = |provider: &str| -> Result<Viewer> {
            let principal =
                Principal::new("p", "read", "*")?.with_vault(Some(provider), Some("p"))?;
            Ok(Viewer::new(
                &principal,
                &Session::for_principal(Some(&vaults), &principal),
            ))
        };
        let (claude, local) = (viewer("anthropic")?, viewer("local")?);

        let hits = search(app, "relay", "sealed label", Some(&local)).await?;
        assert_eq!(
            keys(&hits)[0],
            "sealed",
            "the provider the lock names finds it"
        );
        let hits = search(app, "relay", "sealed label", Some(&claude)).await?;
        assert!(!keys(&hits).contains(&"sealed"), "{hits:?}");
        let hits = search(app, "relay", "ledger secret rotation", Some(&claude)).await?;
        assert!(!keys(&hits).contains(&"sealed"), "{hits:?}");
        assert!(hits.iter().all(|h| h.linked_from.is_none()), "{hits:?}");
        // BM25 statistics cover only the notes the caller may see in the
        // searched domain: the locked note doesn't change the scores, and
        // neither do other domains' notes in the same collection.
        let mirrored = search(app, "mirror", "ledger secret rotation", None).await?;
        index(app, &[&extra]).await?;
        index(
            app,
            &[&input("other", "noise", "Ledger rotation secret secret.")],
        )
        .await?;
        let after = search(app, "relay", "ledger secret rotation", Some(&claude)).await?;
        let lexical = |hits: &[SearchHit], key: &str| {
            hits.iter()
                .find(|h| h.key == key)
                .and_then(|h| h.signals.lexical)
        };
        for key in ["open", "plain"] {
            let seen = lexical(&hits, key).unwrap_or_default();
            assert!(seen > 0.0, "{key} matches");
            for other in [&mirrored, &after] {
                let score = lexical(other, key).unwrap_or_default();
                assert!((score - seen).abs() < 1e-5, "{key}: {score} vs {seen}");
            }
        }
        Ok(())
    }

    /// Needs PostgreSQL and Qdrant; creates and drops its own database and collection.
    #[tokio::test]
    #[ignore = "requires PostgreSQL and Qdrant; set MEMORY_TEST_DATABASE_URL and MEMORY_TEST_QDRANT_URL"]
    async fn repair_payloads_lets_qdrant_find_older_points() -> Result<()> {
        let scratch = ScratchDatabase::create().await?;
        let outcome = match qdrant_app(&scratch.url).await {
            Ok(Some(app)) => {
                let outcome = backfill_checks(&app).await;
                app.vector.delete_collection().await?;
                outcome
            }
            Ok(None) => Ok(()),
            Err(error) => Err(error),
        };
        scratch.drop_database().await?;
        outcome
    }

    async fn backfill_checks(app: &App) -> Result<()> {
        let ledger = input("relay", "ledger", "The ledger retries writes three times.");
        let queue = input(
            "relay",
            "queue",
            "Media consumers acknowledge in 30 seconds.",
        );
        index(app, &[&ledger, &queue]).await?;
        assert_eq!(
            keys(&search(app, "relay", "ledger retries", None).await?),
            ["ledger"]
        );
        // Points as an older version wrote them.
        app.vector
            .delete_payload_keys(&["lexical", "labels", "lock"])
            .await?;
        assert!(
            search(app, "relay", "ledger retries", None)
                .await?
                .is_empty()
        );
        let report = app.backfill_payloads().await?;
        assert_eq!((report.payloads, report.pending), (2, 0));
        assert_eq!(
            keys(&search(app, "relay", "ledger retries", None).await?),
            ["ledger"]
        );
        assert_eq!(
            keys(&search(app, "relay", "Queue", None).await?)[0],
            "queue"
        );
        // The vectors are untouched.
        let hits = app
            .vector
            .search(vec![1.0, 0.0, 0.0, 0.0], Some(&["relay"]), false, &[], 5)
            .await?;
        assert_eq!(hits.len(), 2);
        assert!(hits.iter().all(|h| h.score > 0.99));
        Ok(())
    }
}

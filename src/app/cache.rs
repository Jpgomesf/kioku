//! Each server process's search indexes, one per domain ([`DomainIndex`]).
//!
//! An index is built the first time a process searches its domain, then kept
//! fresh with one cheap check per search: the domain's versions, which
//! triggers bump on every write to its notes or links, by any process
//! ([`SearchVersion`]). When they moved, only the notes written since the
//! index's snapshot are read again, and the links if they changed; a deleted
//! note, or a count below the index's (a restored database or a recreated
//! versions table), rebuilds the index. The cost is per change, never per
//! search.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use tokio::sync::{OwnedRwLockReadGuard, RwLock};

use crate::rank::index::DomainIndex;
use crate::store::SearchVersion;

use super::App;

/// A domain's index, the versions it is current with, and the snapshot it
/// was last read in.
#[derive(Default)]
pub struct Cached {
    pub index: DomainIndex,
    version: SearchVersion,
    snapshot: String,
}

type Slot = Arc<RwLock<Option<Cached>>>;

#[derive(Default)]
pub struct SearchCache {
    domains: Mutex<HashMap<String, Slot>>,
}

impl SearchCache {
    fn slot(&self, domain: &str) -> Slot {
        let mut domains = self
            .domains
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Arc::clone(domains.entry(domain.to_owned()).or_default())
    }
}

/// Current indexes for one search, read-locked until it finishes.
pub struct Ready {
    /// In the order of the domains asked for; each holds an index.
    pub indexes: Vec<OwnedRwLockReadGuard<Option<Cached>>>,
    /// Notes this search read from PostgreSQL to catch up.
    pub refreshed: usize,
}

impl App {
    /// The indexes of `domains` (distinct), each brought up to date first.
    /// Writers hold one domain's lock at a time and only while refreshing, so
    /// searches over several domains can't deadlock.
    pub(super) async fn search_indexes(&self, domains: &[String]) -> Result<Ready> {
        let versions = self.store.search_versions(domains).await?;
        self.catch_up(domains, &versions).await
    }

    /// [`App::search_indexes`] from the versions this search read, which
    /// another search may have refreshed an index past by now.
    async fn catch_up(
        &self,
        domains: &[String],
        versions: &HashMap<String, SearchVersion>,
    ) -> Result<Ready> {
        let slots: Vec<Slot> = domains.iter().map(|d| self.cache.slot(d)).collect();
        let mut refreshed = 0;
        for (domain, slot) in domains.iter().zip(&slots) {
            let read = versions.get(domain).copied().unwrap_or_default();
            if slot
                .read()
                .await
                .as_ref()
                .is_some_and(|c| c.version == read)
            {
                continue;
            }
            let mut cached = slot.write().await;
            // Another search may have caught up while this one waited, even
            // past what this one read. The refresh compares the index with
            // the versions in its own snapshot, so that finds nothing to read,
            // and only a count below the index's starts it over.
            if !cached.as_ref().is_some_and(|c| c.version == read) {
                refreshed += self.refresh(domain, &mut cached).await?;
            }
        }
        let mut indexes = Vec::with_capacity(slots.len());
        for slot in slots {
            indexes.push(slot.read_owned().await);
        }
        Ok(Ready { indexes, refreshed })
    }

    /// Catch `cached` up with its domain; returns how many notes were read.
    /// A domain that grew past the note limit is refused, and its index is
    /// dropped.
    async fn refresh(&self, domain: &str, cached: &mut Option<Cached>) -> Result<usize> {
        let since = cached.as_ref().map(|c| (c.snapshot.as_str(), c.version));
        let delta = self.store.search_delta(domain, since).await?;
        let mut current = match cached.take() {
            Some(old) if !delta.full => old,
            _ => Cached::default(),
        };
        let read = delta.rows.len();
        current.index.apply(delta.rows, |row| {
            !self.embedder.reads_locked(&row.domain, &row.lock)
        });
        self.store.check_domain_size(current.index.len())?;
        if let Some(edges) = &delta.edges {
            current.index.replace_links(edges);
        }
        current.version = delta.version;
        current.snapshot = delta.snapshot;
        *cached = Some(current);
        Ok(read)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use anyhow::Result;

    use crate::access::Principal;
    use crate::app::{App, SearchHit, SearchRequest, SearchResults};
    use crate::config::Config;
    use crate::model::{NoteInput, Status};
    use crate::rank::RankOptions;
    use crate::store::Store;
    use crate::testing::ScratchDatabase;
    use crate::vault::{Session, Vaults, Viewer};

    /// An app over `url` whose vector index and embedding service are
    /// unreachable, so search ranks by keyword, label, and link.
    async fn offline(url: &str) -> Result<App> {
        let config = Config::from_lookup(|name| match name {
            "DATABASE_URL" => Some(url.to_owned()),
            "QDRANT_URL" | "EMBEDDING_URL" => Some("http://127.0.0.1:9".to_owned()),
            _ => None,
        })?;
        let store = Store::connect(url).await?;
        store.migrate().await?;
        Ok(App {
            vector: crate::vector::Qdrant::new(
                &config.qdrant_url,
                &config.collection,
                None,
                config.embedding_dim,
            )?,
            embedder: crate::embedding::Embedder::new(&config)?,
            cache: Default::default(),
            store,
            config,
        })
    }

    fn input(domain: &str, key: &str, body: &str) -> NoteInput {
        let mut input = crate::testing::note(key, domain).input;
        input.body = body.to_owned();
        input
    }

    async fn save(store: &Store, inputs: &[&NoteInput]) -> Result<()> {
        for input in inputs {
            store.upsert(input).await?;
        }
        let domain = &inputs[0].domain;
        let notes = store.notes(Some(domain), true).await?;
        store
            .replace_edges(domain, &crate::graph::resolve_edges(&notes))
            .await
    }

    async fn search(
        app: &App,
        domain: &str,
        query: &str,
        viewer: Option<&Viewer>,
    ) -> Result<(Vec<SearchHit>, usize)> {
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
            })
            .await?;
        Ok((results.hits, results.stats.refreshed))
    }

    fn keys(hits: &[SearchHit]) -> Vec<&str> {
        hits.iter().map(|h| h.key.as_str()).collect()
    }

    /// Creates and drops its own database on the server in MEMORY_TEST_DATABASE_URL.
    #[tokio::test]
    #[ignore = "requires PostgreSQL; set MEMORY_TEST_DATABASE_URL"]
    async fn a_locked_note_never_leaks_through_the_cache() -> Result<()> {
        let scratch = ScratchDatabase::create().await?;
        let outcome = locked_checks(&scratch.url).await;
        scratch.drop_database().await?;
        outcome
    }

    async fn locked_checks(url: &str) -> Result<()> {
        let app = offline(url).await?;
        let mut open = input("relay", "open", "The ledger retries writes three times.");
        open.related = vec!["sealed".into()];
        let plain = input("relay", "plain", "The ledger keeps every entry.");
        let mut sealed = input("relay", "sealed", "Ledger secret rotation is weekly.");
        sealed.aliases = vec!["sealed label".into()];
        sealed.lock = vec!["local".into()];
        save(&app.store, &[&open, &plain, &sealed]).await?;
        // The same visible notes in a domain without the locked one.
        let mirror_open = NoteInput {
            domain: "mirror".into(),
            related: Vec::new(),
            ..open.clone()
        };
        let mirror_plain = NoteInput {
            domain: "mirror".into(),
            ..plain.clone()
        };
        save(&app.store, &[&mirror_open, &mirror_plain]).await?;

        let vaults = Arc::new(Vaults::parse(
            "[[vault]]\nname = \"p\"\ndomains = [\"relay\", \"mirror\"]\nproviders = [\"local\", \"anthropic\"]\ndefault_domain = \"relay\"\n",
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

        // The provider the lock names finds it, which also fills the cache.
        let (hits, _) = search(&app, "relay", "sealed label", Some(&local)).await?;
        assert_eq!(keys(&hits)[0], "sealed");
        // Any other gets nothing of it from the same cache: no exact label,
        // no keyword match, no link from a note it may see.
        let (hits, refreshed) = search(&app, "relay", "sealed label", Some(&claude)).await?;
        assert!(keys(&hits).iter().all(|k| *k != "sealed"), "{hits:?}");
        assert_eq!(refreshed, 0, "served from the cache");
        let (hits, _) = search(&app, "relay", "ledger secret rotation", Some(&claude)).await?;
        assert!(!keys(&hits).contains(&"sealed"), "{hits:?}");
        assert!(hits.iter().all(|h| h.linked_from.is_none()), "{hits:?}");
        // And the visible notes score as if it didn't exist.
        let (mirrored, _) = search(&app, "mirror", "ledger secret rotation", None).await?;
        let lexical = |hits: &[SearchHit], key: &str| {
            hits.iter()
                .find(|h| h.key == key)
                .and_then(|h| h.signals.lexical)
        };
        for key in ["open", "plain"] {
            assert!(lexical(&hits, key).is_some(), "{key} matches");
            assert_eq!(lexical(&hits, key), lexical(&mirrored, key), "{key}");
        }
        Ok(())
    }

    /// Creates and drops its own database on the server in MEMORY_TEST_DATABASE_URL.
    #[tokio::test]
    #[ignore = "requires PostgreSQL; set MEMORY_TEST_DATABASE_URL"]
    async fn a_write_through_another_connection_reaches_the_next_search() -> Result<()> {
        let scratch = ScratchDatabase::create().await?;
        let outcome = freshness_checks(&scratch.url).await;
        scratch.drop_database().await?;
        outcome
    }

    async fn freshness_checks(url: &str) -> Result<()> {
        let app = offline(url).await?;
        // Another process: its own connections, writing to the same database.
        let other = Store::connect(url).await?;
        let ledger = input("relay", "ledger", "The ledger retries writes three times.");
        let queue = input(
            "relay",
            "queue",
            "Media queue consumers acknowledge in 30 seconds.",
        );
        save(&other, &[&ledger, &queue]).await?;

        let (hits, refreshed) = search(&app, "relay", "ledger retries", None).await?;
        assert_eq!(keys(&hits), ["ledger"]);
        assert_eq!(refreshed, 2, "the first search reads the domain");

        let audit = input("relay", "audit", "The ledger audit retries nightly.");
        save(&other, &[&audit]).await?;
        let (hits, refreshed) = search(&app, "relay", "ledger audit", None).await?;
        assert_eq!(keys(&hits)[0], "audit", "a new note is found");
        assert_eq!(refreshed, 1, "only what changed is read");

        let edited = NoteInput {
            body: "The ledger never retries; writes fail fast.".into(),
            ..ledger.clone()
        };
        other.upsert(&edited).await?;
        let (hits, _) = search(&app, "relay", "fail fast", None).await?;
        assert_eq!(keys(&hits), ["ledger"], "an edit is searchable at once");

        let id = ledger.id();
        let note = other.get(id).await?.expect("saved");
        other
            .set_retention(id, note.retention_score, Status::Legacy, chrono::Utc::now())
            .await?;
        let (hits, _) = search(&app, "relay", "fail fast", None).await?;
        assert!(hits.is_empty(), "a retired note leaves default search");

        other.record_access(&[queue.id()]).await?;
        let (hits, refreshed) = search(&app, "relay", "media queue", None).await?;
        assert_eq!(keys(&hits), ["queue"]);
        assert_eq!(refreshed, 1, "a usage update reads one note");
        assert!(hits[0].signals.retention > 0.0);

        let (_, refreshed) = search(&app, "relay", "media queue", None).await?;
        assert_eq!(refreshed, 0, "nothing changed, nothing read");
        Ok(())
    }

    /// A search of `domains` together (one domain alone when it is the only one).
    async fn results(app: &App, domains: &[&str], query: &str) -> Result<SearchResults> {
        let several: Vec<String> = domains.iter().map(|d| (*d).to_owned()).collect();
        app.search(&SearchRequest {
            query,
            domain: Some(domains[0]),
            domains: (domains.len() > 1).then_some(several.as_slice()),
            limit: 5,
            include_legacy: false,
            ranking: RankOptions::HYBRID_GRAPH,
            edges: None,
            viewer: None,
        })
        .await
    }

    /// Run SQL as an administrator would, outside Kioku.
    async fn by_hand(url: &str, sql: &str) -> Result<()> {
        let pool = sqlx::PgPool::connect(url).await?;
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_owned()))
            .execute(&pool)
            .await?;
        pool.close().await;
        Ok(())
    }

    /// Creates and drops its own database on the server in MEMORY_TEST_DATABASE_URL.
    #[tokio::test]
    #[ignore = "requires PostgreSQL; set MEMORY_TEST_DATABASE_URL"]
    async fn a_version_that_went_back_rebuilds_the_index() -> Result<()> {
        let scratch = ScratchDatabase::create().await?;
        let outcome = version_checks(&scratch.url).await;
        scratch.drop_database().await?;
        outcome
    }

    async fn version_checks(url: &str) -> Result<()> {
        let app = offline(url).await?;
        let other = Store::connect(url).await?;
        let ledger = input("relay", "ledger", "The ledger retries writes three times.");
        let queue = input(
            "relay",
            "queue",
            "Media queue consumers acknowledge in 30 seconds.",
        );
        save(&other, &[&ledger, &queue]).await?;
        let (_, refreshed) = search(&app, "relay", "ledger retries", None).await?;
        assert_eq!(refreshed, 2);

        // The versions table is recreated, as a restore may do, and a note is
        // edited: its count starts again below the index's.
        by_hand(url, "DELETE FROM memory_search_versions").await?;
        let edited = NoteInput {
            body: "The ledger never retries; writes fail fast.".into(),
            ..ledger.clone()
        };
        other.upsert(&edited).await?;
        let (hits, refreshed) = search(&app, "relay", "fail fast", None).await?;
        assert_eq!(keys(&hits), ["ledger"], "the edit is found");
        assert_eq!(refreshed, 2, "the index was rebuilt");

        // Another search refreshed the index past the versions this one read:
        // nothing to rebuild.
        let domains = ["relay".to_owned()];
        let read = app.store.search_versions(&domains).await?;
        let audit = input("relay", "audit", "The ledger audit retries nightly.");
        save(&other, &[&audit]).await?;
        let (_, refreshed) = search(&app, "relay", "ledger audit", None).await?;
        assert_eq!(refreshed, 1);
        let ready = app.catch_up(&domains, &read).await?;
        assert_eq!(ready.refreshed, 0, "already current");
        Ok(())
    }

    /// Creates and drops its own database on the server in MEMORY_TEST_DATABASE_URL.
    #[tokio::test]
    #[ignore = "requires PostgreSQL; set MEMORY_TEST_DATABASE_URL"]
    async fn moves_and_truncation_reach_the_index() -> Result<()> {
        let scratch = ScratchDatabase::create().await?;
        let outcome = missed_write_checks(&scratch.url).await;
        scratch.drop_database().await?;
        outcome
    }

    async fn missed_write_checks(url: &str) -> Result<()> {
        let app = offline(url).await?;
        let mut ledger = input("relay", "ledger", "The ledger retries writes three times.");
        ledger.related = vec!["audit".into()];
        let audit = input("relay", "audit", "The ledger audit runs nightly.");
        let queue = input(
            "relay",
            "queue",
            "Media queue consumers acknowledge in 30 seconds.",
        );
        save(&app.store, &[&ledger, &audit, &queue]).await?;
        let mirror = input("mirror", "mirror", "Mirrors copy every bucket.");
        save(&app.store, &[&mirror]).await?;
        let relay = results(&app, &["relay"], "media queue consumers").await?;
        assert_eq!(keys(&relay.hits), ["queue"]);
        assert_eq!((relay.stats.notes, relay.stats.links), (3, 1));
        results(&app, &["mirror"], "mirrors").await?;

        // A note moved to another domain leaves its old domain's index.
        by_hand(
            url,
            r#"UPDATE memory_notes SET domain = 'mirror', input = jsonb_set(input, '{domain}', '"mirror"')
               WHERE note_key = 'queue'"#,
        )
        .await?;
        let relay = results(&app, &["relay"], "media queue consumers").await?;
        assert!(!keys(&relay.hits).contains(&"queue"), "{:?}", relay.hits);
        assert_eq!(relay.stats.notes, 2);
        let moved = results(&app, &["mirror"], "media queue consumers").await?;
        assert_eq!(keys(&moved.hits), ["queue"]);

        // TRUNCATE reaches every domain's index.
        by_hand(url, "TRUNCATE memory_edges").await?;
        let relay = results(&app, &["relay"], "ledger").await?;
        assert_eq!((relay.stats.notes, relay.stats.links), (2, 0));
        by_hand(url, "TRUNCATE memory_notes CASCADE").await?;
        for domain in ["relay", "mirror"] {
            let emptied = results(&app, &[domain], "ledger").await?;
            assert_eq!(emptied.stats.notes, 0, "{domain}");
        }
        Ok(())
    }

    /// Creates and drops its own database on the server in MEMORY_TEST_DATABASE_URL.
    #[tokio::test]
    #[ignore = "requires PostgreSQL; set MEMORY_TEST_DATABASE_URL"]
    async fn search_keeps_the_note_limit() -> Result<()> {
        let scratch = ScratchDatabase::create().await?;
        let outcome = limit_checks(&scratch.url).await;
        scratch.drop_database().await?;
        outcome
    }

    async fn limit_checks(url: &str) -> Result<()> {
        let mut app = offline(url).await?;
        app.store = app.store.with_max_notes(2);
        let ledger = input("relay", "ledger", "The ledger retries writes three times.");
        let audit = input("relay", "audit", "The ledger audit runs nightly.");
        let queue = input("media", "queue", "Media queue consumers acknowledge.");
        for note in [&ledger, &audit, &queue] {
            app.store.upsert(note).await?;
        }
        results(&app, &["relay"], "ledger").await?;
        let vault = results(&app, &["media", "relay"], "ledger").await;
        let error = vault.err().expect("three notes in all").to_string();
        assert!(
            error.contains("More than 2 memories in this vault"),
            "{error}"
        );

        // A domain that grows past the limit is refused, as loading it is.
        let extra = input("relay", "extra", "The ledger keeps every entry.");
        app.store.upsert(&extra).await?;
        for _ in 0..2 {
            let grown = results(&app, &["relay"], "ledger").await;
            let error = grown.err().expect("three notes in relay").to_string();
            assert!(
                error.contains("More than 2 memories in this scope"),
                "{error}"
            );
        }
        assert!(app.store.notes(Some("relay"), true).await.is_err());
        app.store = app.store.with_max_notes(3);
        assert_eq!(results(&app, &["relay"], "ledger").await?.stats.notes, 3);
        Ok(())
    }
}

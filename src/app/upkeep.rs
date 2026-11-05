//! Keeping the derived vector index and retention scores in step with PostgreSQL.
//!
//! Background upkeep only repairs the index and reports aging: retention is a
//! ranking prior, and memories move to legacy only when maintenance is run
//! explicitly (`kioku maintenance`, or `memory_maintenance` with `dry_run: false`).

use std::collections::HashMap;

use anyhow::Result;
use chrono::{Datelike, Utc};
use serde::Serialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::config::Config;
use crate::embedding::Embedder;
use crate::error::invalid;
use crate::graph;
use crate::lifecycle;
use crate::model::{Note, Status};
use crate::vector::Qdrant;

use super::{App, document_text, too_long_context};

/// Notes re-indexed per locked batch during repair.
const REPAIR_BATCH: usize = 32;
/// Aging candidates named in the background upkeep log.
const LOGGED_CANDIDATES: usize = 20;

#[derive(Clone, Debug, Default, Serialize)]
pub struct RepairReport {
    pub reindexed: usize,
    pub failures: Vec<RepairFailure>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ReindexReport {
    pub notes: usize,
    /// Notes edited during the run and indexed again before the switch.
    pub refreshed: usize,
    pub collection: String,
    pub embedding_model: String,
    pub embedding_dim: usize,
    pub previous_collection: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct RepairFailure {
    pub domain: String,
    pub key: String,
    pub error: String,
}

/// The aging policy's verdict on one active note.
#[derive(Clone, Debug, Serialize)]
struct AgingChange {
    id: Uuid,
    domain: String,
    key: String,
    score: f64,
    status: Status,
}

/// `domain/key` of the notes aging would retire, at most `limit` of them.
fn retirement_candidates(changes: &[AgingChange], limit: usize) -> Vec<String> {
    changes
        .iter()
        .filter(|change| change.status == Status::Legacy)
        .take(limit)
        .map(|change| format!("{}/{}", change.domain, change.key))
        .collect()
}

impl App {
    /// Re-index notes whose vectors are missing or stale (all notes with
    /// `all`), and rebuild every domain's links. Failures are collected per
    /// note instead of stopping the run.
    pub async fn repair(&self, all: bool) -> Result<RepairReport> {
        let mut report = RepairReport::default();
        for domain in self.store.domains().await? {
            let notes = self.store.notes(Some(&domain), true).await?;
            {
                let _guard = self.store.mutation_lock().await?;
                self.store
                    .replace_edges(&domain, &graph::resolve_edges(&notes))
                    .await?;
            }
            let targets: Vec<&Note> = notes.iter().filter(|n| all || !n.vector_synced).collect();
            for chunk in targets.chunks(REPAIR_BATCH) {
                let mut embedded = Vec::new();
                for note in chunk {
                    match self.embed_note(&note.input).await {
                        Ok(vector) => embedded.push(((*note).clone(), vector)),
                        Err(error) => report.failures.push(RepairFailure {
                            domain: domain.clone(),
                            key: note.input.key.clone(),
                            error: format!("{error:#}"),
                        }),
                    }
                }
                // Write only notes that nobody changed while we were embedding.
                let _guard = self.store.mutation_lock().await?;
                let mut current = Vec::new();
                for (note, vector) in embedded {
                    if let Some(latest) = self.store.get(note.id).await?
                        && latest.revision == note.revision
                    {
                        current.push((latest, vector));
                    }
                }
                self.vector.upsert_many(&current).await?;
                for (note, _) in &current {
                    self.store.mark_synced(note.id, note.revision).await?;
                }
                report.reindexed += current.len();
            }
        }
        Ok(report)
    }

    /// Embed every memory with another model into a new, empty collection,
    /// then switch the stored identity to it. The old collection is kept for
    /// rollback. Clients still running with the old settings must be
    /// restarted; run `kioku repair --all` if any wrote during the switch.
    pub async fn reindex(&self, target: &Config) -> Result<ReindexReport> {
        if target.collection == self.config.collection {
            invalid!(
                "choose a new collection name (--collection); the current one is {:?}",
                self.config.collection
            );
        }
        let qdrant = Qdrant::new(
            &target.qdrant_url,
            &target.collection,
            target.qdrant_api_key.clone(),
            target.embedding_dim,
        )?;
        qdrant.ensure_collection_created().await?;
        if qdrant.point_count().await? > 0 {
            invalid!(
                "collection {:?} already holds vectors; choose an empty one",
                target.collection
            );
        }
        let embedder = Embedder::new(target)?;
        let embed = |notes: Vec<Note>| {
            let embedder = embedder.clone();
            async move {
                let texts: Vec<String> = notes.iter().map(|n| document_text(&n.input)).collect();
                let vectors = embedder.embed_documents(&texts).await.map_err(|error| {
                    match crate::embedding::failed_index(&error).and_then(|i| notes.get(i)) {
                        Some(note) => too_long_context(error, &note.input),
                        None => error,
                    }
                })?;
                anyhow::Ok(notes.into_iter().zip(vectors).collect::<Vec<_>>())
            }
        };
        let mut indexed: HashMap<Uuid, (i64, Status)> = HashMap::new();
        for domain in self.store.domains().await? {
            let notes = self.store.notes(Some(&domain), true).await?;
            for chunk in notes.chunks(REPAIR_BATCH) {
                let batch = embed(chunk.to_vec()).await?;
                qdrant.upsert_many(&batch).await?;
                indexed.extend(batch.iter().map(|(n, _)| (n.id, (n.revision, n.status))));
            }
        }
        // Catch up with edits made while embedding, then switch atomically.
        let _guard = self.store.mutation_lock().await?;
        let mut changed = Vec::new();
        for domain in self.store.domains().await? {
            for note in self.store.notes(Some(&domain), true).await? {
                if indexed.get(&note.id) != Some(&(note.revision, note.status)) {
                    changed.push(note);
                }
            }
        }
        let refreshed = changed.len();
        for chunk in changed.chunks(REPAIR_BATCH) {
            let batch = embed(chunk.to_vec()).await?;
            qdrant.upsert_many(&batch).await?;
            indexed.extend(batch.iter().map(|(n, _)| (n.id, (n.revision, n.status))));
        }
        self.store
            .set_embedding_identity(&target.embedding_identity())
            .await?;
        for (id, (revision, _)) in &indexed {
            self.store.mark_synced(*id, *revision).await?;
        }
        Ok(ReindexReport {
            notes: indexed.len(),
            refreshed,
            collection: target.collection.clone(),
            embedding_model: target.embedding_model.clone(),
            embedding_dim: target.embedding_dim,
            previous_collection: self.config.collection.clone(),
        })
    }

    /// Repair the vector index and log which memories aging would retire,
    /// without retiring them. Runs when the MCP server starts and then daily;
    /// problems are logged, never sent to tools.
    pub async fn upkeep(&self) {
        match self.repair(false).await {
            Ok(report) if !report.failures.is_empty() => {
                tracing::warn!(reindexed = report.reindexed, failures = ?report.failures, "index repair left notes unindexed");
            }
            Ok(report) if report.reindexed > 0 => {
                tracing::info!(reindexed = report.reindexed, "repaired the vector index");
            }
            Ok(_) => {}
            Err(error) => tracing::warn!(error = format!("{error:#}"), "index repair failed"),
        }
        match self.age(true).await {
            Ok(changes) => {
                let total = changes
                    .iter()
                    .filter(|c| c.status == Status::Legacy)
                    .count();
                if total > 0 {
                    let candidates = retirement_candidates(&changes, LOGGED_CANDIDATES);
                    tracing::info!(
                        total,
                        ?candidates,
                        "memories fell below the legacy threshold and were left active; run `kioku maintenance` or memory_maintenance with dry_run=false to retire them"
                    );
                }
            }
            Err(error) => tracing::warn!(error = format!("{error:#}"), "aging preview failed"),
        }
    }

    /// Preview (`dry_run`) or apply monthly aging, one domain at a time.
    pub async fn maintenance(&self, dry_run: bool) -> Result<Value> {
        let mut changes = self.age(dry_run).await?;
        let total = changes.len();
        let legacy_count = changes
            .iter()
            .filter(|change| change.status == Status::Legacy)
            .count();
        changes.truncate(100);
        Ok(json!({
            "dry_run": dry_run,
            "evaluated": total,
            "legacy": legacy_count,
            "changes": changes,
            "truncated": total > 100,
            "policy": {
                "half_life_days": self.config.half_life_days,
                "legacy_threshold": self.config.legacy_threshold,
                "schedule": "calendar-month checks, completed 30-day aging periods",
                "permanent_deletion": false,
            },
        }))
    }

    /// Score every active note not yet aged this month, and with `dry_run`
    /// false persist the scores and move notes below the threshold to legacy.
    async fn age(&self, dry_run: bool) -> Result<Vec<AgingChange>> {
        let now = Utc::now();
        let mut changes = Vec::new();
        for domain in self.store.domains().await? {
            // A preview writes nothing, so it need not wait for writers.
            let _guard = if dry_run {
                None
            } else {
                Some(self.store.mutation_lock().await?)
            };
            let notes = self.store.notes(Some(&domain), false).await?;
            for note in &notes {
                if (note.last_decay_at.year(), note.last_decay_at.month())
                    >= (now.year(), now.month())
                {
                    continue;
                }
                let score = lifecycle::retention(note, now, self.config.half_life_days);
                let status = if !note.input.pinned && score < self.config.legacy_threshold {
                    Status::Legacy
                } else {
                    Status::Active
                };
                if !dry_run {
                    self.store
                        .set_retention(note.id, score, status, now)
                        .await?;
                    if status != note.status && note.vector_synced {
                        self.vector.set_status(note.id, status).await?;
                        self.store.mark_synced(note.id, note.revision).await?;
                    }
                }
                changes.push(AgingChange {
                    id: note.id,
                    domain: note.input.domain.clone(),
                    key: note.input.key.clone(),
                    score,
                    status,
                });
            }
        }
        Ok(changes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(key: &str, status: Status) -> AgingChange {
        AgingChange {
            id: Uuid::nil(),
            domain: "local".into(),
            key: key.into(),
            score: 0.1,
            status,
        }
    }

    #[test]
    fn upkeep_names_only_notes_aging_would_retire() {
        let changes = [
            change("kept", Status::Active),
            change("stale", Status::Legacy),
            change("older", Status::Legacy),
        ];
        assert_eq!(
            retirement_candidates(&changes, 20),
            ["local/stale", "local/older"]
        );
        assert_eq!(retirement_candidates(&changes, 1), ["local/stale"]);
    }

    #[test]
    fn aging_changes_keep_their_reported_shape() {
        let value = serde_json::to_value(change("stale", Status::Legacy)).unwrap();
        assert_eq!(
            value,
            json!({"id": Uuid::nil(), "domain": "local", "key": "stale", "score": 0.1, "status": "legacy"})
        );
    }
}

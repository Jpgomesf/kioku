//! Authoritative PostgreSQL persistence. All multi-store mutations must hold
//! `mutation_lock` until their Qdrant updates and graph rebuild have completed.
use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::{
    PgPool, Postgres, Row, Transaction,
    postgres::{PgPoolOptions, PgRow},
};
use uuid::Uuid;

use crate::model::{Edge, Note, NoteInput};

const MAX_NOTES: i64 = 10_000;
const MUTATION_LOCK: i64 = 0x4d454d4f525931;

#[derive(Clone)]
pub struct Store {
    pool: PgPool,
}

/// Dropping this guard rolls back its otherwise empty transaction and releases
/// the lock, including on cancellation and errors. Do not start a second guard
/// inside a held guard.
pub struct MutationGuard {
    _transaction: Transaction<'static, Postgres>,
}

impl Store {
    pub async fn connect(database_url: &str) -> Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .acquire_timeout(Duration::from_secs(10))
            .connect(database_url)
            .await
            .context("Could not connect to the memory PostgreSQL database")?;
        Ok(Self { pool })
    }

    pub async fn migrate(&self) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock($1)")
            .bind(MUTATION_LOCK)
            .execute(&mut *tx)
            .await?;
        sqlx::raw_sql(include_str!("../migrations/schema.sql"))
            .execute(&mut *tx)
            .await
            .context("Could not initialize memory schema")?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn mutation_lock(&self) -> Result<MutationGuard> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SET LOCAL lock_timeout = '60s'")
            .execute(&mut *tx)
            .await?;
        sqlx::query("SELECT pg_advisory_xact_lock($1)")
            .bind(MUTATION_LOCK)
            .execute(&mut *tx)
            .await
            .context("Another memory writer is busy; retry shortly")?;
        Ok(MutationGuard { _transaction: tx })
    }

    /// Fail closed when a model changes, even if its output dimension does not.
    /// Concurrent initializers may race, but only one identity can win the insert.
    pub async fn ensure_embedding_identity(&self, identity: &str) -> Result<()> {
        ensure!(
            !identity.is_empty() && identity.len() <= 4096,
            "Invalid embedding identity"
        );
        let mut tx = self.pool.begin().await?;
        sqlx::query("INSERT INTO memory_settings(key,value) VALUES('embedding_identity',$1) ON CONFLICT(key) DO NOTHING")
            .bind(identity).execute(&mut *tx).await?;
        let stored: String =
            sqlx::query_scalar("SELECT value FROM memory_settings WHERE key='embedding_identity'")
                .fetch_one(&mut *tx)
                .await?;
        ensure!(
            stored == identity,
            "Embedding configuration changed. Use a fresh database and Qdrant collection, then rehydrate your notes; mixing models invalidates semantic search"
        );
        tx.commit().await?;
        Ok(())
    }

    /// Identical input is a true no-op: keep revision, timestamps, usage, feedback
    /// and lifecycle state. Content changes invalidate vectors without reviving
    /// an explicitly legacy memory.
    pub async fn upsert(&self, input: &NoteInput) -> Result<Note> {
        input.validate()?;
        let payload = serde_json::to_value(input)?;
        let row = sqlx::query(
            "INSERT INTO memory_notes(id, domain, note_key, input, retention_score)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (domain,note_key) DO UPDATE SET
               input = EXCLUDED.input,
               updated_at = CASE WHEN memory_notes.input IS DISTINCT FROM EXCLUDED.input THEN now() ELSE memory_notes.updated_at END,
               revision = memory_notes.revision + CASE WHEN memory_notes.input IS DISTINCT FROM EXCLUDED.input THEN 1 ELSE 0 END,
               vector_synced = CASE WHEN memory_notes.input IS DISTINCT FROM EXCLUDED.input THEN false ELSE memory_notes.vector_synced END
             RETURNING *")
            .bind(input.id()).bind(&input.domain).bind(&input.key).bind(payload).bind(input.confidence)
            .fetch_one(&self.pool).await.context("Could not save memory")?;
        decode_note(&row)
    }

    pub async fn notes(&self, domain: Option<&str>, include_legacy: bool) -> Result<Vec<Note>> {
        let rows = sqlx::query(
            "SELECT * FROM memory_notes WHERE ($1::text IS NULL OR domain=$1)
             AND ($2 OR status='active') ORDER BY domain,note_key LIMIT $3",
        )
        .bind(domain)
        .bind(include_legacy)
        .bind(MAX_NOTES + 1)
        .fetch_all(&self.pool)
        .await?;
        ensure!(
            rows.len() <= MAX_NOTES as usize,
            "More than {MAX_NOTES} memories in this scope; choose a narrower domain before loading the graph"
        );
        rows.iter().map(decode_note).collect()
    }

    pub async fn get(&self, id: Uuid) -> Result<Option<Note>> {
        sqlx::query("SELECT * FROM memory_notes WHERE id=$1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .as_ref()
            .map(decode_note)
            .transpose()
    }

    pub async fn edges(&self, domain: Option<&str>) -> Result<Vec<Edge>> {
        let rows = sqlx::query(
            "SELECT e.source,e.target,e.kind,e.weight FROM memory_edges e
             JOIN memory_notes s ON s.id=e.source JOIN memory_notes t ON t.id=e.target
             WHERE s.domain=t.domain AND ($1::text IS NULL OR s.domain=$1)
             ORDER BY e.source,e.target,e.kind LIMIT 1000001",
        )
        .bind(domain)
        .fetch_all(&self.pool)
        .await?;
        ensure!(
            rows.len() <= 1_000_000,
            "Graph has too many edges; choose a narrower domain"
        );
        rows.iter()
            .map(|r| {
                Ok(Edge {
                    source: r.try_get("source")?,
                    target: r.try_get("target")?,
                    kind: r.try_get("kind")?,
                    weight: r.try_get("weight")?,
                })
            })
            .collect()
    }

    pub async fn replace_edges(&self, domain: &str, edges: &[Edge]) -> Result<()> {
        ensure!(edges.len() <= 1_000_000, "Too many edges");
        let mut tx = self.pool.begin().await?;
        // Validate before deleting. Every edge must remain inside this domain.
        let ids: std::collections::HashSet<Uuid> =
            sqlx::query_scalar("SELECT id FROM memory_notes WHERE domain=$1")
                .bind(domain)
                .fetch_all(&mut *tx)
                .await?
                .into_iter()
                .collect();
        for edge in edges {
            ensure!(
                ids.contains(&edge.source) && ids.contains(&edge.target),
                "Graph edge crosses its domain or references a missing memory"
            );
            ensure!(
                edge.source != edge.target
                    && edge.weight.is_finite()
                    && edge.weight > 0.0
                    && edge.weight <= 100.0,
                "Invalid graph edge weight or self-reference"
            );
            ensure!(
                !edge.kind.is_empty() && edge.kind.len() <= 64,
                "Invalid edge kind"
            );
        }
        sqlx::query("DELETE FROM memory_edges WHERE source IN (SELECT id FROM memory_notes WHERE domain=$1)")
            .bind(domain).execute(&mut *tx).await?;
        // Batch writes avoid one network round trip for each relation.
        for batch in edges.chunks(1000) {
            let sources: Vec<_> = batch.iter().map(|e| e.source).collect();
            let targets: Vec<_> = batch.iter().map(|e| e.target).collect();
            let kinds: Vec<_> = batch.iter().map(|e| e.kind.clone()).collect();
            let weights: Vec<_> = batch.iter().map(|e| e.weight).collect();
            sqlx::query(
                "INSERT INTO memory_edges(source,target,kind,weight)
                SELECT * FROM UNNEST($1::uuid[],$2::uuid[],$3::text[],$4::float8[])
                ON CONFLICT(source,target,kind) DO UPDATE SET weight=EXCLUDED.weight",
            )
            .bind(sources)
            .bind(targets)
            .bind(kinds)
            .bind(weights)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn mark_synced(&self, id: Uuid, revision: i64) -> Result<()> {
        sqlx::query("UPDATE memory_notes SET vector_synced=true WHERE id=$1 AND revision=$2")
            .bind(id)
            .bind(revision)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Invalidate a lost/recreated derived index without changing note contents.
    pub async fn invalidate_vectors(&self) -> Result<u64> {
        Ok(
            sqlx::query("UPDATE memory_notes SET vector_synced=false WHERE vector_synced")
                .execute(&self.pool)
                .await?
                .rows_affected(),
        )
    }

    pub async fn record_access(&self, ids: &[Uuid]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        ensure!(ids.len() <= 200, "Too many accessed notes in one request");
        sqlx::query("UPDATE memory_notes SET access_count=access_count+1,last_accessed_at=now() WHERE id=ANY($1)")
            .bind(ids).execute(&self.pool).await?;
        Ok(())
    }

    /// Returns false for an exact retry. Reusing a request ID with different
    /// feedback is rejected rather than silently counting an unrelated event.
    pub async fn feedback(&self, id: Uuid, positive: bool, request_id: &str) -> Result<bool> {
        ensure!(
            !request_id.trim().is_empty() && request_id.len() <= 256,
            "request_id must contain 1–256 bytes"
        );
        let mut tx = self.pool.begin().await?;
        let inserted = sqlx::query("INSERT INTO memory_feedback(request_id,note_id,positive) VALUES($1,$2,$3) ON CONFLICT(request_id) DO NOTHING")
            .bind(request_id).bind(id).bind(positive).execute(&mut *tx).await
            .context("Cannot record feedback: verify that this memory exists")?.rows_affected() == 1;
        if inserted {
            sqlx::query("UPDATE memory_notes SET positive_feedback=positive_feedback+$2,negative_feedback=negative_feedback+$3 WHERE id=$1")
                .bind(id).bind(i64::from(positive)).bind(i64::from(!positive)).execute(&mut *tx).await?;
        } else {
            let row =
                sqlx::query("SELECT note_id,positive FROM memory_feedback WHERE request_id=$1")
                    .bind(request_id)
                    .fetch_one(&mut *tx)
                    .await?;
            ensure!(
                row.try_get::<Uuid, _>("note_id")? == id
                    && row.try_get::<bool, _>("positive")? == positive,
                "request_id was already used for different feedback"
            );
        }
        tx.commit().await?;
        Ok(inserted)
    }

    pub async fn set_retention(
        &self,
        id: Uuid,
        score: f64,
        status: &str,
        at: DateTime<Utc>,
    ) -> Result<()> {
        ensure!(
            score.is_finite() && (0.0..=1.0).contains(&score),
            "Invalid retention score"
        );
        ensure!(
            matches!(status, "active" | "legacy"),
            "Invalid memory status"
        );
        let result = sqlx::query("UPDATE memory_notes SET retention_score=$2,status=$3,last_decay_at=$4,
            vector_synced=CASE WHEN status IS DISTINCT FROM $3 THEN false ELSE vector_synced END WHERE id=$1")
            .bind(id).bind(score).bind(status).bind(at).execute(&self.pool).await?;
        ensure!(result.rows_affected() == 1, "Memory not found");
        Ok(())
    }

    pub async fn restore(&self, id: Uuid) -> Result<()> {
        let result = sqlx::query(
            "UPDATE memory_notes SET status='active',retention_score=GREATEST(retention_score,0.5),
            last_accessed_at=now(),last_decay_at=now(),vector_synced=false WHERE id=$1",
        )
        .bind(id)
        .execute(&self.pool)
        .await?;
        ensure!(result.rows_affected() == 1, "Memory not found");
        Ok(())
    }

    pub async fn stats(&self) -> Result<Value> {
        let row = sqlx::query("SELECT count(*) AS total,count(*) FILTER(WHERE status='active') AS active,
            count(*) FILTER(WHERE status='legacy') AS legacy,count(*) FILTER(WHERE NOT vector_synced) AS pending_vectors,
            count(DISTINCT domain) AS domains FROM memory_notes").fetch_one(&self.pool).await?;
        let edges: i64 = sqlx::query_scalar("SELECT count(*) FROM memory_edges")
            .fetch_one(&self.pool)
            .await?;
        let feedback: i64 = sqlx::query_scalar("SELECT count(*) FROM memory_feedback")
            .fetch_one(&self.pool)
            .await?;
        Ok(
            json!({"total": row.try_get::<i64,_>("total")?, "active": row.try_get::<i64,_>("active")?,
            "legacy": row.try_get::<i64,_>("legacy")?, "pending_vectors": row.try_get::<i64,_>("pending_vectors")?,
            "domains": row.try_get::<i64,_>("domains")?, "edges": edges, "feedback_events": feedback}),
        )
    }
}

fn decode_note(row: &PgRow) -> Result<Note> {
    let input: Value = row.try_get("input")?;
    let input: NoteInput =
        serde_json::from_value(input).context("Stored memory has invalid content")?;
    if input.domain != row.try_get::<String, _>("domain")?
        || input.key != row.try_get::<String, _>("note_key")?
    {
        bail!("Stored memory domain/key mismatch");
    }
    Ok(Note {
        id: row.try_get("id")?,
        input,
        status: row.try_get("status")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        last_accessed_at: row.try_get("last_accessed_at")?,
        access_count: row.try_get("access_count")?,
        positive_feedback: row.try_get("positive_feedback")?,
        negative_feedback: row.try_get("negative_feedback")?,
        retention_score: row.try_get("retention_score")?,
        last_decay_at: row.try_get("last_decay_at")?,
        vector_synced: row.try_get("vector_synced")?,
        revision: row.try_get("revision")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Run with MEMORY_TEST_DATABASE_URL pointing to a disposable database.
    #[tokio::test]
    #[ignore = "requires a disposable PostgreSQL database"]
    async fn postgres_preserves_lifecycle_and_rejects_cross_domain_edges() -> Result<()> {
        let url =
            std::env::var("MEMORY_TEST_DATABASE_URL").context("Set MEMORY_TEST_DATABASE_URL")?;
        let store = Store::connect(&url).await?;
        store.migrate().await?;
        let _guard = store.mutation_lock().await?;
        let domain = format!("test-{}", Uuid::new_v4());
        let mut input = NoteInput {
            domain: domain.clone(),
            key: "service".into(),
            title: "Service".into(),
            body: "Service is active.".into(),
            aliases: vec!["svc".into()],
            related: vec![],
            tags: vec![],
            source: None,
            confidence: 0.8,
            pinned: false,
        };
        let note = store.upsert(&input).await?;
        store.mark_synced(note.id, note.revision).await?;
        let replay = store.upsert(&input).await?;
        assert_eq!(replay.revision, 1);
        assert_eq!(replay.updated_at, note.updated_at);
        assert!(replay.vector_synced);
        let request_id = Uuid::new_v4().to_string();
        assert!(store.feedback(note.id, true, &request_id).await?);
        assert!(!store.feedback(note.id, true, &request_id).await?);
        assert!(store.feedback(note.id, false, &request_id).await.is_err());
        store.record_access(&[note.id, note.id]).await?;
        store
            .set_retention(note.id, 0.1, "legacy", Utc::now())
            .await?;
        input.body = "Service has been retired.".into();
        let changed = store.upsert(&input).await?;
        assert_eq!(changed.revision, 2);
        assert_eq!(changed.status, "legacy");
        assert_eq!(changed.access_count, 1);
        assert_eq!(changed.positive_feedback, 1);
        assert!(!changed.vector_synced);
        // Old indexing completion cannot incorrectly mark a newer revision synced.
        store.mark_synced(note.id, 1).await?;
        assert!(!store.get(note.id).await?.unwrap().vector_synced);
        assert!(store.notes(Some(&domain), false).await?.is_empty());
        assert_eq!(store.notes(Some(&domain), true).await?.len(), 1);
        let other = NoteInput {
            domain: format!("{domain}-other"),
            ..input.clone()
        };
        let other_note = store.upsert(&other).await?;
        let neighbor = NoteInput {
            key: "neighbor".into(),
            title: "Neighbor".into(),
            ..input.clone()
        };
        let neighbor_note = store.upsert(&neighbor).await?;
        let edge = Edge {
            source: note.id,
            target: neighbor_note.id,
            kind: "related".into(),
            weight: 1.0,
        };
        store
            .replace_edges(&domain, std::slice::from_ref(&edge))
            .await?;
        assert!(
            store
                .replace_edges(
                    &domain,
                    &[Edge {
                        source: note.id,
                        target: other_note.id,
                        kind: "related".into(),
                        weight: 1.0
                    }]
                )
                .await
                .is_err()
        );
        assert_eq!(store.edges(Some(&domain)).await?, vec![edge]);
        assert!(store.edges(Some(&other.domain)).await?.is_empty());
        // Concurrent retries must record exactly one event, not merely avoid
        // duplicate rows while incrementing the counter twice.
        let concurrent_id = Uuid::new_v4().to_string();
        let (first, second) = tokio::join!(
            store.feedback(note.id, false, &concurrent_id),
            store.feedback(note.id, false, &concurrent_id),
        );
        assert_ne!(first?, second?);
        assert_eq!(store.get(note.id).await?.unwrap().negative_feedback, 1);
        store.restore(note.id).await?;
        assert_eq!(store.get(note.id).await?.unwrap().status, "active");
        assert!(
            store
                .set_retention(note.id, f64::NAN, "active", Utc::now())
                .await
                .is_err()
        );
        // A retried monthly persistence pass does not multiply the previous score.
        let maintenance_time = Utc::now();
        store
            .set_retention(note.id, 0.25, "active", maintenance_time)
            .await?;
        store
            .set_retention(note.id, 0.25, "active", maintenance_time)
            .await?;
        let maintained = store.get(note.id).await?.unwrap();
        assert_eq!(maintained.retention_score, 0.25);
        // PostgreSQL stores timestamps to microsecond precision.
        assert_eq!(
            maintained.last_decay_at.timestamp_micros(),
            maintenance_time.timestamp_micros()
        );
        store.mark_synced(note.id, maintained.revision).await?;
        store
            .mark_synced(neighbor_note.id, neighbor_note.revision)
            .await?;
        store.invalidate_vectors().await?;
        assert!(!store.get(note.id).await?.unwrap().vector_synced);
        assert!(!store.get(neighbor_note.id).await?.unwrap().vector_synced);
        assert_eq!(
            store.get(note.id).await?.unwrap().revision,
            maintained.revision
        );
        sqlx::query("DELETE FROM memory_notes WHERE id=ANY($1)")
            .bind(vec![note.id, other_note.id, neighbor_note.id])
            .execute(&store.pool)
            .await?;
        Ok(())
    }
}

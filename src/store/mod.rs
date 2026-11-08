//! Authoritative PostgreSQL persistence. All multi-store mutations must hold
//! `mutation_lock` until their Qdrant updates and graph rebuild have completed.
//! Every write that changes a note's content or status appends to its history
//! (`memory_note_revisions`) in the same transaction.
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::{
    PgPool, Postgres, Row, Transaction,
    postgres::{PgPoolOptions, PgRow},
};
use uuid::Uuid;

use crate::model::{Edge, Note, NoteInput, NoteRevision, Status};

mod code;

pub use code::CodeMapChange;

const MAX_NOTES: i64 = 10_000;
const MUTATION_LOCK: i64 = 0x4d454d4f525931;
/// Most history entries one call may return.
const MAX_REVISIONS: i64 = 100;

#[derive(Clone)]
pub struct Store {
    pool: PgPool,
    /// Serializes writers inside this process before they take a pooled
    /// connection, so waiters cannot starve the lock holder of connections.
    writer: Arc<tokio::sync::Mutex<()>>,
}

/// Dropping this guard rolls back its otherwise empty transaction and releases
/// the lock, including on cancellation and errors. Do not start a second guard
/// inside a held guard.
pub struct MutationGuard {
    _transaction: Transaction<'static, Postgres>,
    _writer: tokio::sync::OwnedMutexGuard<()>,
}

impl Store {
    pub async fn connect(database_url: &str) -> Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .acquire_timeout(Duration::from_secs(10))
            .connect(database_url)
            .await
            .context("cannot connect to the memory PostgreSQL database")?;
        Ok(Self {
            pool,
            writer: Arc::new(tokio::sync::Mutex::new(())),
        })
    }

    pub async fn migrate(&self) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        // Bounded wait: a long repair elsewhere must not hang a client's startup.
        sqlx::query("SET LOCAL lock_timeout = '15s'")
            .execute(&mut *tx)
            .await?;
        sqlx::query("SELECT pg_advisory_xact_lock($1)")
            .bind(MUTATION_LOCK)
            .execute(&mut *tx)
            .await?;
        sqlx::raw_sql(include_str!("../../migrations/schema.sql"))
            .execute(&mut *tx)
            .await
            .context(
                "cannot initialize the memory schema (another kioku process may be busy; retry)",
            )?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn mutation_lock(&self) -> Result<MutationGuard> {
        let writer = self.writer.clone().lock_owned().await;
        let mut tx = self.pool.begin().await?;
        sqlx::query("SET LOCAL lock_timeout = '60s'")
            .execute(&mut *tx)
            .await?;
        sqlx::query("SELECT pg_advisory_xact_lock($1)")
            .bind(MUTATION_LOCK)
            .execute(&mut *tx)
            .await
            .context("another memory writer is busy; retry shortly")?;
        Ok(MutationGuard {
            _transaction: tx,
            _writer: writer,
        })
    }

    /// Fail closed when a model changes, even if its output dimension does not.
    /// Concurrent initializers may race, but only one identity can win the insert.
    pub async fn ensure_embedding_identity(&self, identity: &str) -> Result<()> {
        ensure!(
            !identity.is_empty() && identity.len() <= 4096,
            "invalid embedding identity"
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
            "the embedding settings differ from those this database was indexed with ({stored}). Restore those settings, or switch safely with `kioku reindex --embedding-model <model> --embedding-dim <n> --collection <new-collection>`"
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
        let mut tx = self.pool.begin().await?;
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
            .fetch_one(&mut *tx).await.context("Could not save memory")?;
        let note = decode_note(&row)?;
        record_revision(&mut tx, note.id).await?;
        tx.commit().await?;
        Ok(note)
    }

    /// A note's most recent history entries, newest first.
    pub async fn revisions(&self, id: Uuid, limit: i64) -> Result<Vec<NoteRevision>> {
        ensure!(
            (1..=MAX_REVISIONS).contains(&limit),
            "history limit must be between 1 and {MAX_REVISIONS}"
        );
        let rows = sqlx::query(
            "SELECT revision, status, input->>'title' AS title, written_at
             FROM memory_note_revisions WHERE note_id=$1 ORDER BY id DESC LIMIT $2",
        )
        .bind(id)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|row| {
                Ok(NoteRevision {
                    revision: row.try_get("revision")?,
                    status: row.try_get::<String, _>("status")?.parse()?,
                    title: row
                        .try_get::<Option<String>, _>("title")?
                        .unwrap_or_default(),
                    written_at: row.try_get("written_at")?,
                })
            })
            .collect()
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

    /// Notes of several domains at once, for searching a whole vault. The
    /// same limit as [`Store::notes`] applies to all of them together.
    pub async fn notes_in(&self, domains: &[String], include_legacy: bool) -> Result<Vec<Note>> {
        let rows = sqlx::query(
            "SELECT * FROM memory_notes WHERE domain = ANY($1)
             AND ($2 OR status='active') ORDER BY domain,note_key LIMIT $3",
        )
        .bind(domains)
        .bind(include_legacy)
        .bind(MAX_NOTES + 1)
        .fetch_all(&self.pool)
        .await?;
        ensure!(
            rows.len() <= MAX_NOTES as usize,
            "More than {MAX_NOTES} memories in this vault; search one of its domains instead"
        );
        rows.iter().map(decode_note).collect()
    }

    /// A value in `memory_settings`, if set.
    pub async fn setting(&self, key: &str) -> Result<Option<String>> {
        Ok(
            sqlx::query_scalar("SELECT value FROM memory_settings WHERE key = $1")
                .bind(key)
                .fetch_optional(&self.pool)
                .await?,
        )
    }

    /// Set a value in `memory_settings`.
    pub async fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        sqlx::query(
            "INSERT INTO memory_settings(key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        )
        .bind(key)
        .bind(value)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Close every pooled connection, for a short-lived handle.
    pub async fn close(&self) {
        self.pool.close().await;
    }

    /// Replace the stored embedding identity after a full reindex.
    pub async fn set_embedding_identity(&self, identity: &str) -> Result<()> {
        sqlx::query(
            "INSERT INTO memory_settings(key, value) VALUES ('embedding_identity', $1)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        )
        .bind(identity)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Every domain that has at least one note.
    pub async fn domains(&self) -> Result<Vec<String>> {
        Ok(
            sqlx::query_scalar("SELECT DISTINCT domain FROM memory_notes ORDER BY domain")
                .fetch_all(&self.pool)
                .await?,
        )
    }

    /// Each domain with each distinct note lock its notes carry (empty for
    /// no lock), sorted by domain: enough to tell which domains hold a note
    /// a session may see without loading the notes. Without
    /// `include_legacy`, only active notes count.
    pub async fn domain_locks(&self, include_legacy: bool) -> Result<Vec<(String, Vec<String>)>> {
        let rows = sqlx::query(
            "SELECT DISTINCT domain, COALESCE(input->'lock', '[]'::jsonb) AS lock
             FROM memory_notes WHERE $1 OR status = 'active' ORDER BY domain",
        )
        .bind(include_legacy)
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|row| {
                let lock: Value = row.try_get("lock")?;
                Ok((
                    row.try_get("domain")?,
                    serde_json::from_value(lock).context("Stored memory has an invalid lock")?,
                ))
            })
            .collect()
    }

    /// Keys of active notes explicitly linked to each of `ids`, both directions,
    /// at most ten per note. Only neighbors whose id passes `keep` are listed,
    /// so callers can leave out notes a session may not see.
    pub async fn neighbor_keys(
        &self,
        ids: &[Uuid],
        keep: impl Fn(Uuid) -> bool,
    ) -> Result<std::collections::HashMap<Uuid, Vec<String>>> {
        let mut out: std::collections::HashMap<Uuid, Vec<String>> =
            std::collections::HashMap::new();
        if ids.is_empty() {
            return Ok(out);
        }
        let rows = sqlx::query(
            "SELECT e.source, e.target, s.note_key AS source_key, t.note_key AS target_key,
                    s.status AS source_status, t.status AS target_status
             FROM memory_edges e
             JOIN memory_notes s ON s.id = e.source
             JOIN memory_notes t ON t.id = e.target
             WHERE e.source = ANY($1) OR e.target = ANY($1)
             ORDER BY s.note_key, t.note_key",
        )
        .bind(ids)
        .fetch_all(&self.pool)
        .await?;
        for row in rows {
            let source: Uuid = row.try_get("source")?;
            let target: Uuid = row.try_get("target")?;
            for (from, other, other_key, other_status) in [
                (
                    source,
                    target,
                    row.try_get::<String, _>("target_key")?,
                    row.try_get::<String, _>("target_status")?,
                ),
                (
                    target,
                    source,
                    row.try_get::<String, _>("source_key")?,
                    row.try_get::<String, _>("source_status")?,
                ),
            ] {
                if ids.contains(&from) && other_status == "active" && keep(other) {
                    let keys = out.entry(from).or_default();
                    if keys.len() < 10 && !keys.contains(&other_key) {
                        keys.push(other_key);
                    }
                }
            }
        }
        Ok(out)
    }

    /// Note counts per domain, largest first, at most 50 domains.
    pub async fn domain_counts(&self) -> Result<Vec<(String, i64)>> {
        let rows = sqlx::query(
            "SELECT domain, count(*) AS notes FROM memory_notes GROUP BY domain ORDER BY notes DESC, domain LIMIT 50",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|row| Ok((row.try_get("domain")?, row.try_get("notes")?)))
            .collect()
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
        decode_edges(&rows)
    }

    /// Links within each of several domains, for searching a whole vault.
    pub async fn edges_in(&self, domains: &[String]) -> Result<Vec<Edge>> {
        let rows = sqlx::query(
            "SELECT e.source,e.target,e.kind,e.weight FROM memory_edges e
             JOIN memory_notes s ON s.id=e.source JOIN memory_notes t ON t.id=e.target
             WHERE s.domain=t.domain AND s.domain = ANY($1)
             ORDER BY e.source,e.target,e.kind LIMIT 1000001",
        )
        .bind(domains)
        .fetch_all(&self.pool)
        .await?;
        decode_edges(&rows)
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

    /// `Some(true)` when recorded, `Some(false)` for an exact retry, and `None`
    /// when the request id was already used for different feedback.
    pub async fn feedback(
        &self,
        id: Uuid,
        positive: bool,
        request_id: &str,
    ) -> Result<Option<bool>> {
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
            if row.try_get::<Uuid, _>("note_id")? != id
                || row.try_get::<bool, _>("positive")? != positive
            {
                return Ok(None);
            }
        }
        tx.commit().await?;
        Ok(Some(inserted))
    }

    pub async fn set_retention(
        &self,
        id: Uuid,
        score: f64,
        status: Status,
        at: DateTime<Utc>,
    ) -> Result<()> {
        ensure!(
            score.is_finite() && (0.0..=1.0).contains(&score),
            "invalid retention score"
        );
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query("UPDATE memory_notes SET retention_score=$2,status=$3,last_decay_at=$4,
            vector_synced=CASE WHEN status IS DISTINCT FROM $3 THEN false ELSE vector_synced END WHERE id=$1")
            .bind(id).bind(score).bind(status.as_str()).bind(at).execute(&mut *tx).await?;
        ensure!(result.rows_affected() == 1, "Memory not found");
        record_revision(&mut tx, id).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn restore(&self, id: Uuid) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query(
            "UPDATE memory_notes SET status='active',retention_score=GREATEST(retention_score,0.5),
            last_accessed_at=now(),last_decay_at=now(),vector_synced=false WHERE id=$1",
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
        ensure!(result.rows_affected() == 1, "Memory not found");
        record_revision(&mut tx, id).await?;
        tx.commit().await?;
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

/// Append the note's current content and status to its history, unless its
/// latest entry already holds them (an identical save, or a retention update
/// that kept the status). Run it in the transaction that wrote the note, after
/// that write: the row lock serializes concurrent writers of the same note.
async fn record_revision(tx: &mut Transaction<'static, Postgres>, id: Uuid) -> Result<()> {
    sqlx::query(
        "INSERT INTO memory_note_revisions(note_id, revision, input, status)
         SELECT n.id, n.revision, n.input, n.status FROM memory_notes n
         WHERE n.id = $1 AND NOT EXISTS (
             SELECT 1 FROM (
                 SELECT revision, status FROM memory_note_revisions
                 WHERE note_id = n.id ORDER BY id DESC LIMIT 1
             ) latest
             WHERE latest.revision = n.revision AND latest.status = n.status
         )",
    )
    .bind(id)
    .execute(&mut **tx)
    .await
    .context("cannot record the memory's history")?;
    Ok(())
}

fn decode_edges(rows: &[PgRow]) -> Result<Vec<Edge>> {
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
        status: row.try_get::<String, _>("status")?.parse()?,
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
mod tests;

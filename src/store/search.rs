//! What search caches read: per-domain versions, the ranking fields of the
//! notes written since a snapshot, and the display fields of a search's hits.
//! The versions and transaction stamps are kept by triggers in
//! `migrations/schema.sql`.

use std::collections::HashMap;

use anyhow::{Context, Result};
use sqlx::Row;
use sqlx::postgres::PgRow;
use uuid::Uuid;

use crate::lifecycle::Usage;
use crate::model::{Edge, SearchFields, Status};

use super::{Store, decode_edges};

/// How many times a domain's notes, links, and deletions have changed. Each
/// count only grows while the table lasts, so a cache built at one version is
/// current while the counts equal it. A count below the cache's means the
/// table was recreated or the database restored, and the cache starts over.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SearchVersion {
    pub notes: i64,
    pub links: i64,
    pub deletes: i64,
}

impl SearchVersion {
    /// Whether every count is at least `other`'s.
    pub fn covers(&self, other: &SearchVersion) -> bool {
        self.notes >= other.notes && self.links >= other.links && self.deletes >= other.deletes
    }
}

/// What a cache must apply to catch up with a domain.
pub struct SearchDelta {
    pub version: SearchVersion,
    /// The snapshot the rows were read in; the next refresh reads what was
    /// written after it.
    pub snapshot: String,
    /// The domain's notes (`full`), or those written since the old snapshot.
    pub rows: Vec<SearchFields>,
    /// The domain's links, when they changed or `full`.
    pub edges: Option<Vec<Edge>>,
    /// The cache must start over: it had nothing, or notes were deleted.
    pub full: bool,
}

/// A search hit's display fields, read after ranking.
pub struct HitFields {
    pub id: Uuid,
    pub domain: String,
    pub status: Status,
    pub key: String,
    pub title: String,
    pub source: Option<String>,
    pub body: String,
    pub lock: Vec<String>,
}

const FIELDS: &str =
    "SELECT id, domain, status, revision, vector_synced, updated_at, last_accessed_at,
        access_count, positive_feedback, negative_feedback,
        input->>'key' AS key, input->>'title' AS title, input->>'body' AS body,
        ARRAY(SELECT jsonb_array_elements_text(COALESCE(input->'aliases', '[]'))) AS aliases,
        ARRAY(SELECT jsonb_array_elements_text(COALESCE(input->'tags', '[]'))) AS tags,
        ARRAY(SELECT jsonb_array_elements_text(COALESCE(input->'lock', '[]'))) AS lock,
        COALESCE((input->>'pinned')::boolean, false) AS pinned,
        input->'confidence' AS confidence
    FROM memory_notes";

fn decode_fields(row: &PgRow) -> Result<SearchFields> {
    // Parsed as JSON, as reading the whole note does, so the retention prior
    // gets the very same number.
    let confidence: Option<serde_json::Value> = row.try_get("confidence")?;
    Ok(SearchFields {
        id: row.try_get("id")?,
        domain: row.try_get("domain")?,
        key: row
            .try_get::<Option<String>, _>("key")?
            .context("Stored memory has no key")?,
        title: row
            .try_get::<Option<String>, _>("title")?
            .unwrap_or_default(),
        aliases: row.try_get("aliases")?,
        tags: row.try_get("tags")?,
        body: row
            .try_get::<Option<String>, _>("body")?
            .unwrap_or_default(),
        lock: row.try_get("lock")?,
        status: row.try_get::<String, _>("status")?.parse()?,
        revision: row.try_get("revision")?,
        vector_synced: row.try_get("vector_synced")?,
        usage: Usage {
            pinned: row.try_get("pinned")?,
            confidence: confidence.and_then(|c| c.as_f64()).unwrap_or(0.8),
            updated_at: row.try_get("updated_at")?,
            last_accessed_at: row.try_get("last_accessed_at")?,
            access_count: row.try_get("access_count")?,
            positive_feedback: row.try_get("positive_feedback")?,
            negative_feedback: row.try_get("negative_feedback")?,
        },
    })
}

impl Store {
    /// The current versions of `domains`. A domain no write has touched since
    /// the triggers were installed has none, which reads as all zeros.
    pub async fn search_versions(
        &self,
        domains: &[String],
    ) -> Result<HashMap<String, SearchVersion>> {
        let rows = sqlx::query(
            "SELECT domain, notes, links, deletes FROM memory_search_versions WHERE domain = ANY($1)",
        )
        .bind(domains)
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|row| {
                Ok((
                    row.try_get("domain")?,
                    SearchVersion {
                        notes: row.try_get("notes")?,
                        links: row.try_get("links")?,
                        deletes: row.try_get("deletes")?,
                    },
                ))
            })
            .collect()
    }

    /// Read what a cache of `domain` needs, in one snapshot: everything when
    /// `since` is `None`, notes were deleted since it, or a count went back,
    /// otherwise only the notes written after the cache's snapshot and, if
    /// they changed, the links. Like every load of a whole domain, it refuses
    /// one of more notes than the limit.
    pub async fn search_delta(
        &self,
        domain: &str,
        since: Option<(&str, SearchVersion)>,
    ) -> Result<SearchDelta> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            .execute(&mut *tx)
            .await?;
        // The first statement fixes the transaction's snapshot, so this is the
        // snapshot every read below sees.
        let snapshot: String = sqlx::query_scalar("SELECT pg_current_snapshot()::text")
            .fetch_one(&mut *tx)
            .await?;
        let version = sqlx::query(
            "SELECT notes, links, deletes FROM memory_search_versions WHERE domain = $1",
        )
        .bind(domain)
        .fetch_optional(&mut *tx)
        .await?
        .map(|row| -> Result<SearchVersion> {
            Ok(SearchVersion {
                notes: row.try_get("notes")?,
                links: row.try_get("links")?,
                deletes: row.try_get("deletes")?,
            })
        })
        .transpose()?
        .unwrap_or_default();
        let since = since.filter(|(_, old)| old.deletes == version.deletes && version.covers(old));
        let full = since.is_none();
        let rows = match since {
            None => {
                sqlx::query(sqlx::AssertSqlSafe(format!(
                    "{FIELDS} WHERE domain = $1 LIMIT $2"
                )))
                .bind(domain)
                .bind(self.load_limit())
                .fetch_all(&mut *tx)
                .await?
            }
            Some((_, old)) if old.notes == version.notes => Vec::new(),
            Some((old_snapshot, _)) => {
                sqlx::query(sqlx::AssertSqlSafe(format!(
                    "{FIELDS} WHERE domain = $1
                     AND written_by >= pg_snapshot_xmin($2::pg_snapshot)
                     AND NOT pg_visible_in_snapshot(written_by, $2::pg_snapshot)
                     LIMIT $3"
                )))
                .bind(domain)
                .bind(old_snapshot)
                .bind(self.load_limit())
                .fetch_all(&mut *tx)
                .await?
            }
        };
        // Notes written since a cache's snapshot are all in the domain, so
        // more of them than the limit is a domain over it too.
        self.check_domain_size(rows.len())?;
        let edges = if since.is_none_or(|(_, old)| old.links != version.links) {
            let rows = sqlx::query(
                "SELECT e.source, e.target, e.kind, e.weight FROM memory_edges e
                 JOIN memory_notes s ON s.id = e.source JOIN memory_notes t ON t.id = e.target
                 WHERE s.domain = $1 AND t.domain = $1",
            )
            .bind(domain)
            .fetch_all(&mut *tx)
            .await?;
            Some(decode_edges(&rows)?)
        } else {
            None
        };
        tx.commit().await?;
        Ok(SearchDelta {
            version,
            snapshot,
            rows: rows.iter().map(decode_fields).collect::<Result<_>>()?,
            edges,
            full,
        })
    }

    /// The display fields of `ids`, in no particular order.
    pub async fn search_hits(&self, ids: &[Uuid]) -> Result<Vec<HitFields>> {
        let rows = sqlx::query(
            "SELECT id, domain, status, input->>'key' AS key, input->>'title' AS title,
                    input->>'source' AS source, input->>'body' AS body,
                    ARRAY(SELECT jsonb_array_elements_text(COALESCE(input->'lock', '[]'))) AS lock
             FROM memory_notes WHERE id = ANY($1)",
        )
        .bind(ids)
        .fetch_all(&self.pool)
        .await?;
        rows.iter()
            .map(|row| {
                Ok(HitFields {
                    id: row.try_get("id")?,
                    domain: row.try_get("domain")?,
                    status: row.try_get::<String, _>("status")?.parse()?,
                    key: row
                        .try_get::<Option<String>, _>("key")?
                        .context("Stored memory has no key")?,
                    title: row
                        .try_get::<Option<String>, _>("title")?
                        .unwrap_or_default(),
                    source: row.try_get("source")?,
                    body: row
                        .try_get::<Option<String>, _>("body")?
                        .unwrap_or_default(),
                    lock: row.try_get("lock")?,
                })
            })
            .collect()
    }
}

//! One note's links, read with two SELECTs instead of loading the whole
//! domain's edges and fetching each neighbour on its own.

use anyhow::Result;
use kioku::model::Edge;
use sqlx::{PgPool, Row};
use uuid::Uuid;

/// A linked note's domain, key and title.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Label {
    pub id: Uuid,
    pub domain: String,
    pub key: String,
    pub title: String,
}

/// Links from or to `id` inside its own domain, as `Store::edges` keeps them.
pub async fn edges_of(pool: &PgPool, id: Uuid) -> Result<Vec<Edge>> {
    let rows = sqlx::query(
        "SELECT e.source,e.target,e.kind,e.weight FROM memory_edges e
         JOIN memory_notes s ON s.id=e.source JOIN memory_notes t ON t.id=e.target
         WHERE (e.source=$1 OR e.target=$1) AND s.domain=t.domain
         ORDER BY e.source,e.target,e.kind",
    )
    .bind(id)
    .fetch_all(pool)
    .await?;
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

/// Labels of the notes in `ids`; ids with no note are left out.
pub async fn labels(pool: &PgPool, ids: &[Uuid]) -> Result<Vec<Label>> {
    let rows = sqlx::query(
        "SELECT id, domain, note_key, coalesce(input->>'title', '') AS title
         FROM memory_notes WHERE id = ANY($1)",
    )
    .bind(ids)
    .fetch_all(pool)
    .await?;
    rows.iter()
        .map(|r| {
            Ok(Label {
                id: r.try_get("id")?,
                domain: r.try_get("domain")?,
                key: r.try_get("note_key")?,
                title: r.try_get("title")?,
            })
        })
        .collect()
}

//! A size check before loading a whole scope. The kioku store refuses scopes
//! above its limits with a plain error, which would reach the app as
//! `unavailable`, the code for a service that is down. Counting first lets the
//! commands say "choose a narrower area" with `invalid_argument` instead.

use anyhow::Result;
use sqlx::{PgPool, Row};

use crate::error::{CommandError, CommandResult};

/// The kioku store's limits on one load (`MAX_NOTES` and the edge cap in
/// `decode_edges`).
pub const MAX_NOTES: i64 = 10_000;
pub const MAX_EDGES: i64 = 1_000_000;

/// Counts stop one past the limit, so a huge scope costs no more than a full one.
const QUERY: &str = "SELECT \
     (SELECT count(*) FROM (SELECT 1 FROM memory_notes WHERE domain = ANY($1) \
       AND ($2 OR status='active') LIMIT $3) n) AS notes, \
     (SELECT count(*) FROM (SELECT 1 FROM memory_edges e \
       JOIN memory_notes s ON s.id=e.source JOIN memory_notes t ON t.id=e.target \
       WHERE s.domain=t.domain AND s.domain = ANY($1) LIMIT $4) l) AS edges";

async fn sizes(pool: &PgPool, domains: &[String], include_legacy: bool) -> Result<(i64, i64)> {
    let row = sqlx::query(QUERY)
        .bind(domains)
        .bind(include_legacy)
        .bind(MAX_NOTES + 1)
        .bind(MAX_EDGES + 1)
        .fetch_one(pool)
        .await?;
    Ok((row.try_get("notes")?, row.try_get("edges")?))
}

/// `invalid_argument` when a scope of `notes` and `edges` is too large to load.
pub fn check(notes: i64, edges: i64) -> CommandResult<()> {
    if notes > MAX_NOTES {
        return Err(CommandError::invalid_argument(format!(
            "More than {MAX_NOTES} notes here. Choose a narrower area."
        )));
    }
    if edges > MAX_EDGES {
        return Err(CommandError::invalid_argument(format!(
            "More than {MAX_EDGES} links here. Choose a narrower area."
        )));
    }
    Ok(())
}

/// Refuses `domains` with `invalid_argument` when they hold too much to load.
pub async fn ensure_fits(
    pool: &PgPool,
    domains: &[String],
    include_legacy: bool,
) -> CommandResult<()> {
    let (notes, edges) = sizes(pool, domains, include_legacy).await?;
    check(notes, edges)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_scopes_are_invalid_arguments() {
        assert!(check(MAX_NOTES, MAX_EDGES).is_ok());
        let notes = check(MAX_NOTES + 1, 0).err();
        assert_eq!(notes.map(|e| e.code).as_deref(), Some("invalid_argument"));
        let edges = check(0, MAX_EDGES + 1).err();
        assert_eq!(edges.map(|e| e.code).as_deref(), Some("invalid_argument"));
    }
}

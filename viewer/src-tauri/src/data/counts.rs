//! Note counts per domain and status, from one SELECT-only aggregate instead
//! of decoding every note.

use anyhow::Result;
use kioku::model::Status;
use sqlx::{PgPool, Row};

/// The notes of one domain with one status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tally {
    pub domain: String,
    pub status: Status,
    pub count: u32,
    /// Distinct sources of the imported notes.
    pub sources: Vec<String>,
    /// Whether any note has no source.
    pub unsourced: bool,
}

const QUERY: &str = "SELECT domain, status, count(*) AS notes, \
     coalesce(array_agg(DISTINCT input->>'source') FILTER (WHERE input->>'source' IS NOT NULL), '{}') AS sources, \
     bool_or(input->>'source' IS NULL) AS unsourced \
     FROM memory_notes GROUP BY domain, status ORDER BY domain, status";

/// Every domain's tallies.
pub async fn tallies(pool: &PgPool) -> Result<Vec<Tally>> {
    let rows = sqlx::query(QUERY).fetch_all(pool).await?;
    rows.iter()
        .map(|row| {
            let count: i64 = row.try_get("notes")?;
            Ok(Tally {
                domain: row.try_get("domain")?,
                status: row.try_get::<String, _>("status")?.parse()?,
                count: u32::try_from(count).unwrap_or(u32::MAX),
                sources: row.try_get("sources")?,
                unsourced: row
                    .try_get::<Option<bool>, _>("unsourced")?
                    .unwrap_or(false),
            })
        })
        .collect()
}

/// The same tallies from loaded notes, for tests.
#[cfg(test)]
pub fn from_notes(notes: &[kioku::model::Note]) -> Vec<Tally> {
    let mut out: Vec<Tally> = Vec::new();
    for note in notes {
        let input = &note.input;
        let index = match out
            .iter()
            .position(|t| t.domain == input.domain && t.status == note.status)
        {
            Some(index) => index,
            None => {
                out.push(Tally {
                    domain: input.domain.clone(),
                    status: note.status,
                    count: 0,
                    sources: Vec::new(),
                    unsourced: false,
                });
                out.len() - 1
            }
        };
        let tally = &mut out[index];
        tally.count += 1;
        match &input.source {
            Some(source) if !tally.sources.contains(source) => tally.sources.push(source.clone()),
            Some(_) => {}
            None => tally.unsourced = true,
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;

    #[tokio::test]
    #[ignore = "needs the live Kioku services"]
    async fn live_tallies_run() -> anyhow::Result<()> {
        let state = AppState::default();
        let services = state.read_only().await?;
        let rows = tallies(&services.pool).await?;
        assert!(rows.iter().all(|row| row.count > 0));
        Ok(())
    }
}

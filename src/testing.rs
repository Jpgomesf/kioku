//! Note builders and a scratch database shared by unit tests.

use anyhow::{Context, Result};
use chrono::{DateTime, TimeZone, Utc};
use uuid::Uuid;

use crate::model::{Note, NoteInput, Status};

pub(crate) fn now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 28, 12, 0, 0).unwrap()
}

pub(crate) fn note(key: &str, domain: &str) -> Note {
    let input = NoteInput {
        domain: domain.to_owned(),
        key: key.to_owned(),
        title: key.to_owned(),
        body: format!("Evidence for {key}"),
        aliases: Vec::new(),
        related: Vec::new(),
        tags: Vec::new(),
        source: None,
        confidence: 0.8,
        pinned: false,
        lock: Vec::new(),
    };
    Note {
        id: input.id(),
        input,
        status: Status::Active,
        created_at: now(),
        updated_at: now(),
        last_accessed_at: None,
        access_count: 0,
        positive_feedback: 0,
        negative_feedback: 0,
        retention_score: 0.8,
        last_decay_at: now(),
        vector_synced: true,
        revision: 1,
    }
}

pub(crate) fn sourced_note(key: &str, body: &str) -> Note {
    let input = NoteInput {
        domain: "test".into(),
        key: key.into(),
        title: key.into(),
        body: body.into(),
        aliases: Vec::new(),
        related: Vec::new(),
        tags: Vec::new(),
        source: Some("test://source".into()),
        confidence: 0.8,
        pinned: false,
        lock: Vec::new(),
    };
    let at = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
    Note {
        id: input.id(),
        input,
        status: Status::Active,
        created_at: at,
        updated_at: at,
        last_accessed_at: None,
        access_count: 0,
        positive_feedback: 0,
        negative_feedback: 0,
        retention_score: 0.8,
        last_decay_at: at,
        vector_synced: true,
        revision: 1,
    }
}

/// A database created for one test run and dropped afterwards, so tests
/// never touch data they did not create.
pub(crate) struct ScratchDatabase {
    admin_url: String,
    name: String,
    pub(crate) url: String,
}

impl ScratchDatabase {
    pub(crate) async fn create() -> Result<Self> {
        use sqlx::Connection;
        let admin_url = std::env::var("MEMORY_TEST_DATABASE_URL").context(
            "set MEMORY_TEST_DATABASE_URL to a PostgreSQL URL that may create databases",
        )?;
        let name = format!("kioku_test_{}", Uuid::new_v4().simple());
        let mut admin = sqlx::PgConnection::connect(&admin_url).await?;
        // Audited: the name is generated from a UUID.
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!("CREATE DATABASE \"{name}\"")))
            .execute(&mut admin)
            .await?;
        admin.close().await?;
        let mut url = reqwest::Url::parse(&admin_url)?;
        url.set_path(&format!("/{name}"));
        Ok(Self {
            admin_url,
            name,
            url: url.to_string(),
        })
    }

    pub(crate) async fn drop_database(self) -> Result<()> {
        use sqlx::Connection;
        let mut admin = sqlx::PgConnection::connect(&self.admin_url).await?;
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            "DROP DATABASE IF EXISTS \"{}\" WITH (FORCE)",
            self.name
        )))
        .execute(&mut admin)
        .await?;
        admin.close().await?;
        Ok(())
    }
}

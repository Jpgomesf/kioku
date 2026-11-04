use super::*;

/// A database created for one test run and dropped afterwards, so tests
/// never touch data they did not create.
struct ScratchDatabase {
    admin_url: String,
    name: String,
    url: String,
}

impl ScratchDatabase {
    async fn create() -> Result<Self> {
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

    async fn drop_database(self) -> Result<()> {
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

/// Creates and drops its own database on the server in MEMORY_TEST_DATABASE_URL.
#[tokio::test]
#[ignore = "requires PostgreSQL; set MEMORY_TEST_DATABASE_URL"]
async fn postgres_preserves_lifecycle_and_rejects_cross_domain_edges() -> Result<()> {
    let scratch = ScratchDatabase::create().await?;
    let store = Store::connect(&scratch.url).await?;
    let outcome = lifecycle_checks(&store).await;
    store.pool.close().await;
    scratch.drop_database().await?;
    outcome
}

async fn lifecycle_checks(store: &Store) -> Result<()> {
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
    assert_eq!(
        store.feedback(note.id, true, &request_id).await?,
        Some(true)
    );
    assert_eq!(
        store.feedback(note.id, true, &request_id).await?,
        Some(false)
    );
    assert_eq!(store.feedback(note.id, false, &request_id).await?, None);
    store.record_access(&[note.id, note.id]).await?;
    store
        .set_retention(note.id, 0.1, Status::Legacy, Utc::now())
        .await?;
    input.body = "Service has been retired.".into();
    let changed = store.upsert(&input).await?;
    assert_eq!(changed.revision, 2);
    assert_eq!(changed.status, Status::Legacy);
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
    // Exactly one of the two concurrent retries was recorded.
    assert_eq!(store.get(note.id).await?.unwrap().negative_feedback, 1);
    store.restore(note.id).await?;
    assert_eq!(store.get(note.id).await?.unwrap().status, Status::Active);
    assert!(
        store
            .set_retention(note.id, f64::NAN, Status::Active, Utc::now())
            .await
            .is_err()
    );
    // A retried monthly persistence pass does not multiply the previous score.
    let maintenance_time = Utc::now();
    store
        .set_retention(note.id, 0.25, Status::Active, maintenance_time)
        .await?;
    store
        .set_retention(note.id, 0.25, Status::Active, maintenance_time)
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
    Ok(())
}

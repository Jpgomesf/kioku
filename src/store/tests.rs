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

/// Creates and drops its own database on the server in MEMORY_TEST_DATABASE_URL.
#[tokio::test]
#[ignore = "requires PostgreSQL; set MEMORY_TEST_DATABASE_URL"]
async fn postgres_keeps_append_only_note_history() -> Result<()> {
    let scratch = ScratchDatabase::create().await?;
    let store = Store::connect(&scratch.url).await?;
    let outcome = history_checks(&store).await;
    store.pool.close().await;
    scratch.drop_database().await?;
    outcome
}

async fn history_checks(store: &Store) -> Result<()> {
    store.migrate().await?;
    let mut input = NoteInput {
        domain: "history".into(),
        key: "service".into(),
        title: "Service v1".into(),
        body: "Service runs on the old cluster.".into(),
        aliases: vec![],
        related: vec![],
        tags: vec![],
        source: None,
        confidence: 0.8,
        pinned: false,
        lock: Vec::new(),
    };
    let note = store.upsert(&input).await?;
    // Writes that change nothing add nothing.
    store.upsert(&input).await?;
    store
        .set_retention(note.id, 0.5, Status::Active, Utc::now())
        .await?;
    assert_eq!(store.revisions(note.id, 10).await?.len(), 1);

    input.title = "Service v2".into();
    input.body = "Service moved to the new cluster.".into();
    store.upsert(&input).await?;
    store
        .set_retention(note.id, 0.1, Status::Legacy, Utc::now())
        .await?;
    store.restore(note.id).await?;
    let history = store.revisions(note.id, 10).await?;
    let summary: Vec<_> = history
        .iter()
        .map(|entry| (entry.revision, entry.status, entry.title.as_str()))
        .collect();
    assert_eq!(
        summary,
        vec![
            (2, Status::Active, "Service v2"),
            (2, Status::Legacy, "Service v2"),
            (2, Status::Active, "Service v2"),
            (1, Status::Active, "Service v1"),
        ]
    );
    assert!(
        history
            .windows(2)
            .all(|w| w[0].written_at >= w[1].written_at)
    );
    // The overwritten text is kept.
    let first: Value = sqlx::query_scalar(
        "SELECT input FROM memory_note_revisions WHERE note_id=$1 ORDER BY id LIMIT 1",
    )
    .bind(note.id)
    .fetch_one(&store.pool)
    .await?;
    assert_eq!(first["body"], "Service runs on the old cluster.");
    assert_eq!(store.revisions(note.id, 2).await?.len(), 2);
    assert!(store.revisions(note.id, 0).await.is_err());

    // A write by an older binary, which kept no history, is caught up once.
    sqlx::query("UPDATE memory_notes SET status='legacy' WHERE id=$1")
        .bind(note.id)
        .execute(&store.pool)
        .await?;
    store.migrate().await?;
    store.migrate().await?;
    let caught_up = store.revisions(note.id, 10).await?;
    assert_eq!(caught_up.len(), 5);
    assert_eq!(
        (caught_up[0].revision, caught_up[0].status),
        (2, Status::Legacy)
    );
    assert!(caught_up[0].written_at >= caught_up[1].written_at);

    // Notes saved before history existed get their current revision, once.
    sqlx::query("DELETE FROM memory_note_revisions WHERE note_id=$1")
        .bind(note.id)
        .execute(&store.pool)
        .await?;
    store.migrate().await?;
    store.migrate().await?;
    let backfilled = store.revisions(note.id, 10).await?;
    assert_eq!(backfilled.len(), 1);
    assert_eq!(
        (backfilled[0].revision, backfilled[0].status),
        (2, Status::Legacy)
    );

    // History goes away only with its note.
    sqlx::query("DELETE FROM memory_notes WHERE id=$1")
        .bind(note.id)
        .execute(&store.pool)
        .await?;
    assert!(store.revisions(note.id, 10).await?.is_empty());
    Ok(())
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
        lock: Vec::new(),
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
    // A whole vault's domains load together.
    let both = [domain.clone(), other.domain.clone()];
    assert_eq!(store.notes_in(&both, true).await?.len(), 3);
    assert_eq!(
        store.notes_in(&both, false).await?.len(),
        2,
        "the legacy note is left out"
    );
    assert_eq!(
        store.edges_in(&both).await?,
        store.edges(Some(&domain)).await?
    );
    assert!(store.notes_in(&[], true).await?.is_empty());
    let neighbors = store.neighbor_keys(&[note.id], |_| true).await?;
    assert_eq!(
        neighbors.get(&note.id).map(Vec::as_slice),
        Some(&["neighbor".to_owned()][..])
    );
    assert!(store.neighbor_keys(&[note.id], |_| false).await?.is_empty());
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

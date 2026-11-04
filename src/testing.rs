//! Note builders shared by unit tests.

use chrono::{DateTime, TimeZone, Utc};

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

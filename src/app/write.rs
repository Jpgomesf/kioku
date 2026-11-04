//! Saving notes from tools, and the lifecycle flags tools may change.

use std::path::Path;

use anyhow::{Context, Result};
use chrono::Utc;
use serde::Serialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::error::{UserError, conflict, invalid};
use crate::graph::{self, UnresolvedRelation};
use crate::model::{Note, NoteInput, Status};
use crate::secrets;

use super::{App, is_file_source};

/// Who is writing a note. Tools act for a model and may not overwrite notes
/// maintained as Markdown files; imports come from those files.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WriteOrigin {
    Tool,
    Import,
}

#[derive(Clone, Debug, Serialize)]
pub struct UpsertOutcome {
    pub id: Uuid,
    pub key: String,
    pub domain: String,
    pub revision: i64,
    pub status: Status,
    /// True when the key did not exist before.
    pub created: bool,
    /// False when the content was identical to what is already stored.
    pub changed: bool,
    /// False when the note is saved but its vector could not be written yet.
    pub indexed: bool,
    pub unresolved_relationships: Vec<UnresolvedRelation>,
    pub unresolved_count: usize,
}

/// Decide whether `input` may be written over `existing`. A note's source owns
/// its key. Tools may not touch notes that live in Markdown files, and an
/// import may take over a key only when the old file no longer exists (it was
/// moved or renamed).
pub(super) fn check_ownership(
    existing: Option<&Note>,
    input: &NoteInput,
    origin: WriteOrigin,
) -> Result<()> {
    let new_source = input.source.as_deref();
    let old_source = existing.and_then(|note| note.input.source.as_deref());
    if origin == WriteOrigin::Tool
        && let Some(path) = old_source.filter(|s| is_file_source(s))
    {
        conflict!(
            "memory {:?} in domain {:?} comes from the file {path}. Edit that file, then call memory_import, or save the new fact under another key",
            input.key,
            input.domain
        );
    }
    if origin == WriteOrigin::Tool && new_source.is_some_and(is_file_source) {
        invalid!(
            "source must say where the fact came from (for example \"user\" or a URL); file paths are reserved for notes imported from Markdown"
        );
    }
    if existing.is_none() {
        return Ok(());
    }
    match old_source {
        None => Ok(()),
        Some(old) if Some(old) == new_source => Ok(()),
        Some(old)
            if origin == WriteOrigin::Import && is_file_source(old) && !Path::new(old).exists() =>
        {
            Ok(())
        }
        Some(old) => conflict!(
            "key {:?} in domain {:?} already belongs to {old}; keep that source or choose another key",
            input.key,
            input.domain
        ),
    }
}

impl App {
    pub async fn upsert(&self, input: NoteInput, origin: WriteOrigin) -> Result<UpsertOutcome> {
        if let Err(error) = input.validate() {
            invalid!("{error}");
        }
        if origin == WriteOrigin::Tool
            && let Some(kind) = secrets::find(&input)
        {
            return Err(UserError::Refused(format!(
                "the note looks like it contains {kind}. Never store secret values; save where the secret lives instead, for example \"the Stripe key is in the team vault\""
            ))
            .into());
        }
        let existing = self.store.get(input.id()).await?;
        check_ownership(existing.as_ref(), &input, origin)?;
        let unchanged = existing
            .as_ref()
            .is_some_and(|note| note.input == input && note.vector_synced);
        // Embed first: if this fails, nothing has been written.
        let vector = if unchanged {
            None
        } else {
            Some(self.embed_note(&input).await?)
        };

        let _guard = self.store.mutation_lock().await?;
        // Another writer may have claimed the key while we were embedding.
        let current = self.store.get(input.id()).await?;
        check_ownership(current.as_ref(), &input, origin)?;
        let note = self.store.upsert(&input).await?;
        let notes = self.store.notes(Some(&input.domain), true).await?;
        let (edges, mut unresolved) = graph::resolve_edges_with_report(&notes);
        let unresolved_count = unresolved.len();
        unresolved.truncate(20);
        self.store.replace_edges(&input.domain, &edges).await?;
        let mut indexed = true;
        if !note.vector_synced {
            let vector = match vector {
                Some(vector) => vector,
                None => self.embed_note(&input).await?,
            };
            // The row is committed; a vector failure leaves it findable by
            // keyword and is repaired automatically, so report it, don't fail.
            match self.vector.upsert(&note, vector).await {
                Ok(()) => self.store.mark_synced(note.id, note.revision).await?,
                Err(error) => {
                    tracing::warn!(error = format!("{error:#}"), key = %input.key, "vector write failed after save");
                    indexed = false;
                }
            }
        }
        Ok(UpsertOutcome {
            id: note.id,
            key: input.key,
            domain: input.domain,
            revision: note.revision,
            status: note.status,
            created: existing.is_none(),
            changed: !unchanged,
            indexed,
            unresolved_relationships: unresolved,
            unresolved_count,
        })
    }

    pub async fn feedback(
        &self,
        id: Uuid,
        positive: bool,
        request_id: &str,
        domain: Option<&str>,
    ) -> Result<Value> {
        if request_id.trim().is_empty() || request_id.len() > 200 {
            invalid!("request_id must contain 1 to 200 characters");
        }
        self.require_note(id, domain).await?;
        let Some(applied) = self.store.feedback(id, positive, request_id).await? else {
            conflict!(
                "request_id {request_id:?} was already used for different feedback; use a new request_id for a new judgment, or omit it"
            );
        };
        Ok(json!({"id": id, "applied": applied, "positive": positive, "request_id": request_id}))
    }

    pub async fn set_legacy(&self, id: Uuid, legacy: bool, domain: Option<&str>) -> Result<Value> {
        let note = self.require_note(id, domain).await?;
        let wanted = if legacy {
            Status::Legacy
        } else {
            Status::Active
        };
        if note.status == wanted && note.vector_synced {
            return Ok(
                json!({"id": id, "key": note.input.key, "status": wanted, "changed": false, "deleted": false}),
            );
        }
        // A stale or missing vector is rebuilt along the way; embed before locking.
        let vector = if note.vector_synced {
            None
        } else {
            Some(self.embed_note(&note.input).await?)
        };
        let _guard = self.store.mutation_lock().await?;
        if note.status != wanted {
            if legacy {
                self.store
                    .set_retention(id, note.retention_score, Status::Legacy, Utc::now())
                    .await?;
            } else {
                self.store.restore(id).await?;
            }
        }
        let updated = self.store.get(id).await?.context("memory disappeared")?;
        let indexed = match vector {
            Some(vector) => self.vector.upsert(&updated, vector).await,
            None => self.vector.set_status(id, updated.status).await,
        };
        indexed.context(
            "the status changed in PostgreSQL, but the vector index could not be updated; it will be repaired automatically",
        )?;
        self.store.mark_synced(id, updated.revision).await?;
        Ok(
            json!({"id": id, "key": updated.input.key, "status": updated.status, "changed": note.status != wanted, "deleted": false}),
        )
    }

    /// Pin or unpin a memory. Pinned memories never age into legacy status.
    /// For a Markdown-backed note the frontmatter wins at its next import.
    pub async fn set_pinned(&self, id: Uuid, pinned: bool, domain: Option<&str>) -> Result<Value> {
        let note = self.require_note(id, domain).await?;
        let file_backed = note.input.source.as_deref().is_some_and(is_file_source);
        if note.input.pinned != pinned {
            let mut input = note.input.clone();
            input.pinned = pinned;
            self.upsert(input, WriteOrigin::Import).await?;
        }
        Ok(json!({
            "key": note.input.key,
            "domain": note.input.domain,
            "pinned": pinned,
            "note": file_backed.then(|| format!(
                "this note comes from {}; set `pinned: {pinned}` in its frontmatter too, or the next import resets it",
                note.input.source.as_deref().unwrap_or_default()
            )),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::sourced_note as note;

    #[test]
    fn ownership_rules() {
        let mut chat = note("decision", "body");
        chat.input.source = Some("user-approved chat decision".into());
        let mut update = chat.input.clone();
        update.body = "new body".into();
        assert!(check_ownership(Some(&chat), &update, WriteOrigin::Tool).is_ok());
        update.source = Some("another source".into());
        assert!(check_ownership(Some(&chat), &update, WriteOrigin::Tool).is_err());

        let mut file_backed = note("from-file", "body");
        file_backed.input.source = Some("/notes/from-file.md".into());
        let mut overwrite = file_backed.input.clone();
        overwrite.body = "rewritten by a tool".into();
        let error = check_ownership(Some(&file_backed), &overwrite, WriteOrigin::Tool)
            .unwrap_err()
            .to_string();
        assert!(error.contains("memory_import"), "{error}");

        let mut claim = note("new", "body").input;
        claim.source = Some("/etc/passwd".into());
        assert!(check_ownership(None, &claim, WriteOrigin::Tool).is_err());

        // A moved file takes over its key once the old path is gone.
        let mut moved = file_backed.clone();
        moved.input.source = Some("/definitely/missing/kioku-old-path.md".into());
        let mut relocated = moved.input.clone();
        relocated.source = Some("/new/location/from-file.md".into());
        assert!(check_ownership(Some(&moved), &relocated, WriteOrigin::Import).is_ok());
        let mut present = moved.clone();
        present.input.source = Some(
            std::env::current_dir()
                .unwrap()
                .join("Cargo.toml")
                .to_string_lossy()
                .into_owned(),
        );
        assert!(check_ownership(Some(&present), &relocated, WriteOrigin::Import).is_err());
    }
}

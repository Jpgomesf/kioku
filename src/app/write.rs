//! Saving notes from tools, and the lifecycle flags tools may change.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use anyhow::{Context, Result};
use chrono::Utc;
use serde::Serialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::error::{UserError, conflict, invalid};
use crate::graph::{self, UnresolvedRelation};
use crate::model::{Edge, Note, NoteInput, Status, VectorHit};
use crate::secrets;
use crate::vault::Viewer;

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
    /// At most 20, counted in full by `unresolved_count`. Without vault rules,
    /// the whole domain's; for a viewer with them, only this note's own.
    pub unresolved_relationships: Vec<UnresolvedRelation>,
    pub unresolved_count: usize,
    /// Active notes this one links to or is linked from, among those the
    /// caller may see. A note with none is reachable only by search, never
    /// through the graph.
    pub links: usize,
    /// A new note with no links, in a domain that has other notes it could
    /// link to.
    pub isolated: bool,
    /// For a note a tool just created: up to three active notes of its domain,
    /// not already linked to it, at least `MEMORY_SIMILAR_NOTE_SCORE` similar
    /// in meaning. One may hold the same fact, or be a note to link.
    pub similar: Vec<SimilarNote>,
}

/// A stored note close in meaning to one a tool just created.
#[derive(Clone, Debug, Serialize)]
pub struct SimilarNote {
    pub key: String,
    pub title: String,
    /// Cosine similarity to the new note, from 0 to 1.
    pub score: f64,
}

/// Notes a new note might repeat: active, visible to `viewer`, not `saved`
/// itself, and not already linked to it. Keys and titles by id.
fn similar_candidates(
    notes: &[Note],
    saved: Uuid,
    linked: &HashSet<Uuid>,
    viewer: Option<&Viewer>,
) -> HashMap<Uuid, (String, String)> {
    notes
        .iter()
        .filter(|other| {
            other.id != saved
                && other.status == Status::Active
                && !linked.contains(&other.id)
                && viewer.is_none_or(|viewer| viewer.sees(other))
        })
        .map(|other| {
            (
                other.id,
                (other.input.key.clone(), other.input.title.clone()),
            )
        })
        .collect()
}

/// The hits at least `threshold` similar that are candidates, at most three,
/// in the order given, with scores rounded to three decimals.
fn similar_from_hits(
    hits: Vec<VectorHit>,
    candidates: &HashMap<Uuid, (String, String)>,
    threshold: f64,
) -> Vec<SimilarNote> {
    hits.into_iter()
        .filter(|hit| hit.score >= threshold)
        .filter_map(|hit| {
            candidates.get(&hit.id).map(|(key, title)| SimilarNote {
                key: key.clone(),
                title: title.clone(),
                score: (hit.score * 1000.0).round() / 1000.0,
            })
        })
        .take(3)
        .collect()
}

/// Whether `viewer` may see an active note of the domain other than `saved`.
fn has_visible_peers(notes: &[Note], saved: Uuid, viewer: Option<&Viewer>) -> bool {
    notes.iter().any(|other| {
        other.id != saved
            && other.status == Status::Active
            && viewer.is_none_or(|viewer| viewer.sees(other))
    })
}

/// Active notes linked to or from `id` in either direction that `viewer` may see.
fn linked_notes(
    notes: &[Note],
    edges: &[Edge],
    id: Uuid,
    viewer: Option<&Viewer>,
) -> HashSet<Uuid> {
    let neighbors: HashSet<Uuid> = edges
        .iter()
        .filter_map(|edge| match (edge.source == id, edge.target == id) {
            (true, false) => Some(edge.target),
            (false, true) => Some(edge.source),
            _ => None,
        })
        .collect();
    notes
        .iter()
        .filter(|note| {
            neighbors.contains(&note.id)
                && note.status == Status::Active
                && viewer.is_none_or(|viewer| viewer.sees(note))
        })
        .map(|note| note.id)
        .collect()
}

/// Unresolved links a save reports, at most `limit`, and how many there are.
/// Without vault rules, the whole domain's, as always. For a viewer with
/// them, only the saved note's own, resolved against the notes it may see:
/// a reference to a hidden note's key, title, or alias reads as not found,
/// and one shared with a hidden note resolves to the visible one.
fn save_report(
    notes: Vec<Note>,
    saved: Uuid,
    domain_report: Vec<UnresolvedRelation>,
    viewer: Option<&Viewer>,
    limit: usize,
) -> (Vec<UnresolvedRelation>, usize) {
    let mut unresolved = match viewer.filter(|viewer| viewer.restricts_notes()) {
        Some(viewer) => {
            let visible: Vec<Note> = notes.into_iter().filter(|n| viewer.sees(n)).collect();
            graph::unresolved_for(&visible, saved)
        }
        None => domain_report,
    };
    // Filter first, then cut, so the saved note's own entries survive.
    let count = unresolved.len();
    unresolved.truncate(limit);
    (unresolved, count)
}

/// Decide whether `input` may be written over `existing`. A note's source owns
/// its key. Tools may not touch notes that live in Markdown files, and an
/// import may take over a key only when the old file no longer exists (it was
/// moved or renamed).
/// Whether the file a file source names still exists. A section of an OKF
/// concept records `<file>.md#<anchor>`, which belongs to its concept file.
fn source_file_exists(source: &str) -> bool {
    Path::new(source).exists()
        || source
            .rsplit_once('#')
            .is_some_and(|(file, _)| file.ends_with(".md") && Path::new(file).exists())
}

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
            if origin == WriteOrigin::Import && is_file_source(old) && !source_file_exists(old) =>
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
        self.upsert_as(input, origin, None).await
    }

    /// Save a note for `viewer`, whose vault rules decide which unresolved
    /// links the outcome reports (see [`save_report`]). The stored links are
    /// the same for every viewer.
    pub async fn upsert_as(
        &self,
        input: NoteInput,
        origin: WriteOrigin,
        viewer: Option<&Viewer>,
    ) -> Result<UpsertOutcome> {
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
        // Embed first: if this fails, nothing has been written. A note the
        // embedding service may not read is never sent to it.
        let embeds = self.embedder.reads(&input);
        let vector = if unchanged || !embeds {
            None
        } else {
            Some(self.embed_note(&input).await?)
        };
        // A new note from a tool: its vector also finds stored notes that may
        // hold the same fact.
        let probe = (origin == WriteOrigin::Tool && existing.is_none())
            .then(|| vector.clone())
            .flatten();

        let guard = self.store.mutation_lock().await?;
        // Another writer may have claimed the key while we were embedding.
        let current = self.store.get(input.id()).await?;
        check_ownership(current.as_ref(), &input, origin)?;
        let note = self.store.upsert(&input).await?;
        let notes = self.store.notes(Some(&input.domain), true).await?;
        let (edges, domain_report) = graph::resolve_edges_with_report(&notes);
        self.store.replace_edges(&input.domain, &edges).await?;
        let linked = linked_notes(&notes, &edges, note.id, viewer);
        let isolated =
            existing.is_none() && linked.is_empty() && has_visible_peers(&notes, note.id, viewer);
        let candidates = if probe.is_some() {
            similar_candidates(&notes, note.id, &linked, viewer)
        } else {
            HashMap::new()
        };
        // The other active notes stay out of the vector query, so they can't
        // take the places of candidates.
        let excluded: Vec<Uuid> = notes
            .iter()
            .filter(|other| other.status == Status::Active && !candidates.contains_key(&other.id))
            .map(|other| other.id)
            .collect();
        let (unresolved, unresolved_count) = save_report(notes, note.id, domain_report, viewer, 20);
        let mut indexed = true;
        if !note.vector_synced {
            // The row is committed; a vector failure leaves it findable by
            // keyword and is repaired automatically, so report it, don't fail.
            let written = if embeds {
                let vector = match vector {
                    Some(vector) => vector,
                    None => self.embed_note(&input).await?,
                };
                self.vector.upsert(&note, vector).await
            } else {
                // No vector: search finds it by keyword, label, and link.
                self.vector.delete(&[note.id]).await
            };
            match written {
                Ok(()) => self.store.mark_synced(note.id, note.revision).await?,
                Err(error) => {
                    tracing::warn!(error = format!("{error:#}"), key = %input.key, "vector write failed after save");
                    indexed = false;
                }
            }
        }
        drop(guard);
        let similar = match probe {
            Some(vector) if !candidates.is_empty() => {
                self.similar_notes(vector, &input.domain, &excluded, &candidates)
                    .await
            }
            _ => Vec::new(),
        };
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
            links: linked.len(),
            isolated,
            similar,
        })
    }

    /// Up to three of `candidates` at least `similar_note_score` similar to
    /// `vector`, most similar first. Every other active note of the domain is
    /// `excluded` from the query, so the top hits are candidates. A failed
    /// lookup only costs the hint.
    async fn similar_notes(
        &self,
        vector: Vec<f32>,
        domain: &str,
        excluded: &[Uuid],
        candidates: &HashMap<Uuid, (String, String)>,
    ) -> Vec<SimilarNote> {
        match self
            .vector
            .search(vector, Some(&[domain]), false, excluded, 3)
            .await
        {
            Ok(hits) => similar_from_hits(hits, candidates, self.config.similar_note_score),
            Err(error) => {
                tracing::debug!(error = format!("{error:#}"), "similar-note lookup failed");
                Vec::new()
            }
        }
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
        let embeds = self.embedder.reads(&note.input);
        let vector = if note.vector_synced || !embeds {
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
            None if embeds => self.vector.set_status(id, updated.status).await,
            None => self.vector.delete(&[id]).await,
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
    fn a_section_source_belongs_to_its_concept_file() {
        let dir = std::env::temp_dir().join(format!("kioku-owner-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("architecture.md");
        std::fs::write(&file, "text").unwrap();
        let section = format!("{}#router", file.display());
        assert!(
            source_file_exists(&section),
            "a section is owned while its file exists"
        );
        let mut existing = note("kb/architecture#router", "Router section");
        existing.input.source = Some(section.clone());
        let mut claim = existing.input.clone();
        claim.source = Some("/another/bundle/architecture.md#router".into());
        assert!(check_ownership(Some(&existing), &claim, WriteOrigin::Import).is_err());
        std::fs::remove_file(&file).unwrap();
        assert!(!source_file_exists(&section));
        assert!(check_ownership(Some(&existing), &claim, WriteOrigin::Import).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_vault_save_reports_its_own_links_as_its_viewer_sees_them() {
        use crate::access::Principal;
        use crate::vault::{Session, Vaults};
        let vaults = std::sync::Arc::new(
            Vaults::parse(
                "[[vault]]\nname = \"p\"\ndomains = [\"test\"]\nproviders = [\"local\", \"anthropic\"]\ndefault_domain = \"test\"\n",
                Path::new("/cfg/vaults.toml"),
                None,
            )
            .unwrap(),
        );
        let viewer = |provider: &str| {
            let principal = Principal::new("p", "read,write", "*")
                .unwrap()
                .with_vault(Some(provider), Some("p"))
                .unwrap();
            Viewer::new(
                &principal,
                &Session::for_principal(Some(&vaults), &principal),
            )
        };
        let mut hidden = note("passport", "body");
        hidden.input.title = "Passport renewal 2027".into();
        hidden.input.aliases = vec!["shared label".into()];
        hidden.input.lock = vec!["local".into()];
        let mut visible = note("visa", "body");
        visible.input.aliases = vec!["shared label".into()];
        let mut probe = note("probe", "body");
        probe.input.related = vec![
            "Passport renewal 2027".into(),
            "passport".into(),
            "shared label".into(),
            "visa".into(),
            "nowhere".into(),
        ];
        // Other notes' dangling links, more than the report's limit.
        let others: Vec<Note> = (0..30)
            .map(|i| {
                let mut other = note(&format!("other-{i:02}"), "body");
                other.input.related = vec![format!("missing-{i}")];
                other
            })
            .collect();
        let mut notes = vec![hidden, visible, probe.clone()];
        notes.extend(others);
        let (_, domain_report) = graph::resolve_edges_with_report(&notes);
        let report = |viewer: Option<&Viewer>| {
            let (unresolved, count) =
                save_report(notes.clone(), probe.id, domain_report.clone(), viewer, 20);
            let refs: Vec<(String, String)> = unresolved
                .iter()
                .map(|u| (u.reference.clone(), u.reason.clone()))
                .collect();
            (refs, count)
        };
        let pair = |reference: &str, reason: &str| (reference.to_owned(), reason.to_owned());

        let claude = viewer("anthropic");
        let (refs, count) = report(Some(&claude));
        assert_eq!(
            refs,
            [
                pair("Passport renewal 2027", "not_found"),
                pair("nowhere", "not_found"),
                pair("passport", "not_found"),
            ],
            "hidden labels must read as missing, and shared ones resolve"
        );
        assert_eq!(count, 3);

        let local = viewer("local");
        let (refs, _) = report(Some(&local));
        assert_eq!(
            refs,
            [
                pair("nowhere", "not_found"),
                pair("shared label", "ambiguous")
            ]
        );

        // Without vault rules the report is the whole domain's, cut to 20.
        let (refs, count) = report(None);
        assert_eq!((refs.len(), count), (20, 32));
    }

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

    fn edge(source: Uuid, target: Uuid) -> Edge {
        Edge {
            source,
            target,
            kind: "related".to_owned(),
            weight: 1.0,
        }
    }

    #[test]
    fn linked_notes_count_both_directions_and_only_active_notes() {
        let domain_note = crate::testing::note;
        let saved = domain_note("saved", "relay");
        let parent = domain_note("parent", "relay");
        let child = domain_note("child", "relay");
        let mut retired = domain_note("retired", "relay");
        retired.status = Status::Legacy;
        let stranger = domain_note("stranger", "relay");
        let notes = vec![
            saved.clone(),
            parent.clone(),
            child.clone(),
            retired.clone(),
            stranger.clone(),
        ];
        let edges = vec![
            edge(saved.id, parent.id),
            edge(child.id, saved.id),
            edge(saved.id, retired.id),
            edge(parent.id, stranger.id),
        ];
        let linked = linked_notes(&notes, &edges, saved.id, None);
        assert_eq!(linked, HashSet::from([parent.id, child.id]));
        assert!(linked_notes(&notes, &[], saved.id, None).is_empty());
    }

    /// A viewer for provider anthropic in a vault over domain "relay", so a
    /// note locked to local is hidden from it.
    fn anthropic_viewer() -> Viewer {
        use crate::vault::{Session, Vaults};
        let root = std::env::temp_dir().join(format!("kioku-viewer-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let text = format!(
            r#"
            [[vault]]
            name = "work"
            paths = ["{}"]
            domains = ["relay"]
            providers = ["local", "anthropic"]
            default_domain = "relay"
            "#,
            root.display()
        );
        let vaults =
            std::sync::Arc::new(Vaults::parse(&text, Path::new("/cfg/vaults.toml"), None).unwrap());
        let session = Session::for_folder(Some(&vaults), Some("anthropic"), Some(&root));
        std::fs::remove_dir_all(&root).ok();
        assert!(
            session.placement().is_some(),
            "the test session must be placed"
        );
        let principal = crate::access::Principal::new("local", "read,write,admin", "*").unwrap();
        Viewer::new(&principal, &session)
    }

    #[test]
    fn similar_candidates_leave_out_the_note_its_links_retired_notes_and_hidden_ones() {
        let domain_note = crate::testing::note;
        let saved = domain_note("saved", "relay");
        let linked_one = domain_note("linked", "relay");
        let open = domain_note("open", "relay");
        let mut locked = domain_note("locked", "relay");
        locked.input.lock = vec!["local".to_owned()];
        let mut retired = domain_note("retired", "relay");
        retired.status = Status::Legacy;
        let notes = vec![
            saved.clone(),
            linked_one.clone(),
            open.clone(),
            locked.clone(),
            retired.clone(),
        ];
        let linked = HashSet::from([linked_one.id]);
        let keys = |map: HashMap<Uuid, (String, String)>| {
            let mut keys: Vec<String> = map.into_values().map(|(key, _)| key).collect();
            keys.sort();
            keys
        };
        assert_eq!(
            keys(similar_candidates(&notes, saved.id, &linked, None)),
            ["locked", "open"]
        );
        let viewer = anthropic_viewer();
        assert_eq!(
            keys(similar_candidates(&notes, saved.id, &linked, Some(&viewer))),
            ["open"]
        );
        assert!(has_visible_peers(&notes, saved.id, Some(&viewer)));
        assert!(!has_visible_peers(
            &[saved.clone(), locked, retired],
            saved.id,
            Some(&viewer)
        ));
    }

    #[test]
    fn similar_hits_keep_candidates_over_the_threshold_at_most_three() {
        let ids: Vec<Uuid> = (0..6).map(|_| Uuid::new_v4()).collect();
        let candidates: HashMap<Uuid, (String, String)> = ids[..5]
            .iter()
            .enumerate()
            .map(|(i, id)| (*id, (format!("key-{i}"), format!("Title {i}"))))
            .collect();
        let hit = |id: Uuid, score: f64| VectorHit {
            id,
            score,
            revision: 1,
        };
        let hits = vec![
            hit(ids[5], 0.99), // not a candidate: linked, hidden, or the note itself
            hit(ids[0], 0.95),
            hit(ids[1], 0.912_345_6),
            hit(ids[2], 0.89), // under the threshold
            hit(ids[3], 0.93),
            hit(ids[4], 0.92),
        ];
        let similar = similar_from_hits(hits, &candidates, 0.9);
        let found: Vec<(&str, f64)> = similar.iter().map(|s| (s.key.as_str(), s.score)).collect();
        assert_eq!(found, [("key-0", 0.95), ("key-1", 0.912), ("key-3", 0.93)]);
        assert!(similar_from_hits(Vec::new(), &candidates, 0.9).is_empty());
    }
}

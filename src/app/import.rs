//! Importing Markdown notes and hydrating selected files.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, ensure};
use serde::Serialize;
use uuid::Uuid;

use crate::error::{UserError, invalid, not_found};
use crate::graph::{self, UnresolvedRelation};
use crate::markdown;
use crate::model::Status;

use super::write::{WriteOrigin, check_ownership};
use super::{App, document_text, too_long_context};

#[derive(Clone, Debug, Serialize)]
pub struct ImportedNote {
    pub id: Uuid,
    pub key: String,
    pub domain: String,
    pub revision: i64,
    pub status: Status,
}

#[derive(Clone, Debug, Serialize)]
pub struct ImportReport {
    pub imported: usize,
    pub notes: Vec<ImportedNote>,
    pub truncated: bool,
    pub unresolved_relationships: Vec<UnresolvedRelation>,
    pub unresolved_count: usize,
}

impl App {
    pub async fn ingest(&self, root: &Path, domain: &str) -> Result<ImportReport> {
        self.ingest_scoped(root, domain, false).await
    }

    async fn ingest_scoped(
        &self,
        root: &Path,
        domain: &str,
        strict_domain: bool,
    ) -> Result<ImportReport> {
        let root = root.to_path_buf();
        // Directory walks and file reads block, so keep them off the async executor.
        let files = tokio::task::spawn_blocking(move || read_markdown_tree(&root))
            .await
            .context("note import task failed")??;
        let mut inputs = Vec::new();
        let mut keys = HashSet::new();
        for (source, text) in files {
            let mut input = match markdown::parse_markdown(&text, &source, domain) {
                Ok(input) => input,
                Err(error) => invalid!("cannot import {source}: {error:#}"),
            };
            if strict_domain && input.domain != domain {
                invalid!(
                    "{source} declares domain {:?}, but the import is for domain {domain:?}; nothing was imported",
                    input.domain
                );
            }
            // File provenance comes from the actual location, never from frontmatter.
            input.source = Some(source.clone());
            if let Err(error) = input.validate() {
                invalid!("cannot import {source}: {error}");
            }
            if !keys.insert(input.id()) {
                invalid!(
                    "two files use key {:?} in domain {:?} (one is {source}); give each note its own key",
                    input.key,
                    input.domain
                );
            }
            inputs.push(input);
        }
        if inputs.is_empty() {
            not_found!("no Markdown notes found there");
        }
        inputs.sort_by(|a, b| (&a.domain, &a.key).cmp(&(&b.domain, &b.key)));

        // Validate ownership and embed changed notes before writing anything.
        let mut changed = Vec::new();
        for (index, input) in inputs.iter().enumerate() {
            let existing = self.store.get(input.id()).await?;
            check_ownership(existing.as_ref(), input, WriteOrigin::Import).with_context(|| {
                format!(
                    "cannot import {}",
                    input.source.as_deref().unwrap_or_default()
                )
            })?;
            if !existing.is_some_and(|note| note.input == *input && note.vector_synced) {
                changed.push(index);
            }
        }
        let texts: Vec<String> = changed.iter().map(|i| document_text(&inputs[*i])).collect();
        let vectors = match self.embedder.embed_documents(&texts).await {
            Ok(vectors) => vectors,
            Err(error) => {
                let culprit = crate::embedding::failed_index(&error).and_then(|i| changed.get(i));
                return Err(match culprit {
                    Some(i) => too_long_context(error, &inputs[*i]),
                    None => error.context("cannot embed the notes; nothing was imported"),
                });
            }
        };
        let mut pending: HashMap<Uuid, Vec<f32>> = changed
            .iter()
            .zip(vectors)
            .map(|(i, vector)| (inputs[*i].id(), vector))
            .collect();

        let _guard = self.store.mutation_lock().await?;
        let domains: HashSet<String> = inputs.iter().map(|input| input.domain.clone()).collect();
        let mut saved = Vec::with_capacity(inputs.len());
        for input in &inputs {
            let current = self.store.get(input.id()).await?;
            check_ownership(current.as_ref(), input, WriteOrigin::Import)?;
            saved.push(self.store.upsert(input).await?);
        }
        let mut unresolved = Vec::new();
        for domain in domains {
            let domain_notes = self.store.notes(Some(&domain), true).await?;
            let (edges, missing) = graph::resolve_edges_with_report(&domain_notes);
            self.store.replace_edges(&domain, &edges).await?;
            unresolved.extend(missing);
        }
        let mut batch = Vec::new();
        for note in saved.iter().filter(|note| !note.vector_synced) {
            let vector = match pending.remove(&note.id) {
                Some(vector) => vector,
                None => self.embed_note(&note.input).await?,
            };
            batch.push((note.clone(), vector));
        }
        self.vector.upsert_many(&batch).await.context(
            "the notes are saved, but the vector index could not be updated; it will be repaired automatically",
        )?;
        for (note, _) in &batch {
            self.store.mark_synced(note.id, note.revision).await?;
        }
        let unresolved_count = unresolved.len();
        unresolved.truncate(50);
        Ok(ImportReport {
            imported: saved.len(),
            notes: saved
                .into_iter()
                .map(|note| ImportedNote {
                    id: note.id,
                    key: note.input.key,
                    domain: note.input.domain,
                    revision: note.revision,
                    status: note.status,
                })
                .collect(),
            truncated: false,
            unresolved_relationships: unresolved,
            unresolved_count,
        })
    }

    pub async fn hydrate(
        &self,
        relative_path: Option<&str>,
        domain: Option<&str>,
    ) -> Result<ImportReport> {
        let root = self
            .config
            .notes_root
            .as_ref()
            .ok_or_else(|| UserError::InvalidArgument("importing Markdown is not configured on this server (MEMORY_NOTES_ROOT is not set)".into()))?
            .canonicalize()
            .context("the configured notes directory is missing")?;
        let relative = Path::new(relative_path.unwrap_or("."));
        if relative.is_absolute()
            || relative
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            invalid!(
                "path must be relative to the notes folder, without .. (got {:?}). Example: {{\"path\":\"my-project\"}}",
                relative.display().to_string()
            );
        }
        let Ok(selected) = root.join(relative).canonicalize() else {
            not_found!(
                "{:?} does not exist in the notes folder",
                relative.display().to_string()
            );
        };
        if !selected.starts_with(&root) {
            invalid!(
                "path {:?} resolves outside the notes folder",
                relative.display().to_string()
            );
        }
        let mut report = self
            .ingest_scoped(&selected, self.domain(domain), true)
            .await?;
        report.truncated = report.notes.len() > 20;
        report.notes.truncate(20);
        Ok(report)
    }
}

/// Read every visible Markdown file under `root` (or `root` itself if it is a
/// file). Hidden files and directories are skipped and symlinks are not followed.
fn read_markdown_tree(root: &Path) -> Result<Vec<(String, String)>> {
    ensure!(
        root.exists(),
        "input path {} does not exist",
        root.display()
    );
    let canonical = root.canonicalize()?;
    let mut files = Vec::new();
    for entry in walkdir::WalkDir::new(&canonical)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'))
    {
        let entry = entry?;
        if !entry.file_type().is_file() || entry.path().extension().is_none_or(|e| e != "md") {
            continue;
        }
        let path: PathBuf = entry.path().to_path_buf();
        // Re-check confinement per file in case a directory was swapped for a symlink.
        let real = path.canonicalize()?;
        ensure!(
            real.starts_with(&canonical),
            "{} resolves outside the import directory",
            path.display()
        );
        ensure!(
            entry.metadata()?.len() <= 32_768,
            "{} exceeds 32 KiB; split it into focused notes",
            path.display()
        );
        let source = real.to_string_lossy().into_owned();
        let text = std::fs::read_to_string(&real)
            .with_context(|| format!("cannot read {source} as UTF-8 text"))?;
        files.push((source, text));
        ensure!(files.len() <= 10_000, "an import is limited to 10000 notes");
    }
    Ok(files)
}

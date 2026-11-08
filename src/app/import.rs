//! Importing Markdown notes and hydrating selected files.
//!
//! A file that cannot be read, parsed, validated, owned, or embedded is
//! skipped and reported in [`ImportReport::failed`]; the other files import
//! normally. Only when every file fails is the import an error.
//!
//! One notes folder serves every vault, so an import for a vault session
//! reads only files whose frontmatter names their domain: a file that doesn't
//! could belong to any vault, and must not adopt the session's domain. Its
//! report lists only the notes, links, and failures of notes that session may
//! see. The others, including files that can't be read or parsed (their vault
//! is unknown), are counted, never named.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, ensure};
use serde::Serialize;
use uuid::Uuid;

use crate::embedding::{self, failed_index, is_too_long};
use crate::error::{UserError, invalid, not_found};
use crate::graph::{self, UnresolvedRelation};
use crate::markdown;
use crate::model::{Note, NoteInput, Status};
use crate::okf;
use crate::vault::Viewer;

use super::write::{WriteOrigin, check_ownership};
use super::{App, document_text};

/// Largest Markdown file an import reads.
const MAX_FILE_BYTES: u64 = 32_768;
/// Most files one import may read.
const MAX_FILES: usize = 10_000;
/// Failures named in the error when every file failed.
const LISTED_FAILURES: usize = 20;

#[derive(Clone, Debug, Serialize)]
pub struct ImportedNote {
    pub id: Uuid,
    pub key: String,
    pub domain: String,
    pub revision: i64,
    pub status: Status,
}

/// A file the import skipped, and why.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ImportFailure {
    /// Relative to the import root: the notes folder for `memory_import`, the
    /// given directory (or a given file's directory) for `kioku ingest`.
    pub path: String,
    pub reason: String,
    /// The viewer may not see this file's note, or the import couldn't tell
    /// whose note it is: counted, but never listed.
    #[serde(skip)]
    hidden: bool,
}

impl ImportFailure {
    fn new(path: String, reason: String, hidden: bool) -> Self {
        Self {
            path,
            reason,
            hidden,
        }
    }
}

/// Whether a failure about `input` (`None` when the file didn't parse) may
/// be listed to `viewer`. Without vault rules, everything is.
fn listed(viewer: Option<&Viewer>, input: Option<&NoteInput>) -> bool {
    viewer.is_none_or(|viewer| {
        !viewer.restricts_notes() || input.is_some_and(|input| viewer.sees_input(input))
    })
}

#[derive(Clone, Debug, Serialize)]
pub struct ImportReport {
    pub imported: usize,
    pub notes: Vec<ImportedNote>,
    pub truncated: bool,
    pub unresolved_relationships: Vec<UnresolvedRelation>,
    pub unresolved_count: usize,
    /// Skipped files, sorted by path.
    pub failed: Vec<ImportFailure>,
    /// Skipped files whose notes the viewer may not see, left out of `failed`.
    #[serde(skip)]
    pub hidden_failures: usize,
    /// What an OKF bundle import read and changed; absent for Markdown notes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub okf: Option<OkfImport>,
    /// Notes saved without a vector because the embedding service may not
    /// read them (`EMBEDDING_READER`); search finds them by keyword and link.
    #[serde(skip_serializing_if = "super::is_zero")]
    pub not_sent_to_embedder: usize,
}

/// How an import reads its path.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ImportFormat {
    /// An OKF bundle when the folder's `index.md` declares `okf_version`,
    /// focused Markdown notes otherwise.
    #[default]
    Auto,
    Markdown,
    /// An OKF bundle, even one whose `index.md` declares no version.
    Okf,
}

/// The OKF part of an import report.
#[derive(Clone, Debug, Serialize)]
pub struct OkfImport {
    #[serde(flatten)]
    pub read: okf::Summary,
    /// Notes made legacy because their concept is deprecated.
    pub retired: usize,
    /// Legacy notes made active again because their concept no longer is.
    pub restored: usize,
    /// Notes made legacy because their concept or section left the bundle.
    pub removed: usize,
}

impl ImportReport {
    /// For a vault session, what the failures counted but not listed are.
    pub fn unnamed_failures(&self) -> Option<String> {
        (self.hidden_failures > 0).then(|| {
            format!(
                "failed_count includes {} {}. With vaults, every imported file must name its domain",
                self.hidden_failures,
                unnamed(self.hidden_failures)
            )
        })
    }
}

/// A parsed, valid note and the path it is reported under.
struct Candidate {
    path: String,
    input: NoteInput,
}

impl Candidate {
    fn fail(self, reason: String, viewer: Option<&Viewer>) -> ImportFailure {
        let hidden = !listed(viewer, Some(&self.input));
        ImportFailure::new(self.path, reason, hidden)
    }
}

/// Markdown files found under an import root.
struct MarkdownTree {
    /// What reported paths are relative to: the root, or a file root's directory.
    base: PathBuf,
    /// Each file's canonical path, with its text or why it could not be read.
    files: Vec<(String, Result<String>)>,
}

impl App {
    pub async fn ingest(&self, root: &Path, domain: &str) -> Result<ImportReport> {
        self.ingest_as(root, domain, ImportFormat::Auto).await
    }

    /// Import `root` as `format` says. Only the command line imports OKF
    /// bundles: they carry no domain of their own.
    pub async fn ingest_as(
        &self,
        root: &Path,
        domain: &str,
        format: ImportFormat,
    ) -> Result<ImportReport> {
        let bundle = match format {
            ImportFormat::Okf => true,
            ImportFormat::Markdown => false,
            ImportFormat::Auto => {
                let dir = root.to_path_buf();
                tokio::task::spawn_blocking(move || okf::bundle_version(&dir))
                    .await
                    .context("note import task failed")?
                    .is_some()
            }
        };
        if bundle {
            self.ingest_okf(root, domain).await
        } else {
            self.ingest_scoped(root, domain, false, None, None).await
        }
    }

    /// Import an OKF bundle into `domain`, then bring each note's lifecycle
    /// in line with the bundle: deprecated concepts are legacy, others active,
    /// and notes whose concept or section left the bundle are retired.
    async fn ingest_okf(&self, root: &Path, domain: &str) -> Result<ImportReport> {
        let dir = root.to_path_buf();
        let owned_domain = domain.to_owned();
        let (bundle, conversion) = tokio::task::spawn_blocking(move || -> Result<_> {
            let bundle = okf::Bundle::read(&dir)?;
            let conversion = okf::convert(&bundle, &owned_domain);
            Ok((bundle, conversion))
        })
        .await
        .context("bundle import task failed")??;
        if bundle.paths().next().is_none() {
            not_found!("no OKF concepts found there");
        }
        let mut failed: Vec<ImportFailure> = conversion
            .failed
            .iter()
            .map(|(path, reason)| ImportFailure::new(path.clone(), reason.clone(), false))
            .collect();
        let failed_files: HashSet<String> = conversion
            .failed
            .into_iter()
            .map(|(path, _)| path)
            .collect();
        let made: HashSet<String> = conversion
            .notes
            .iter()
            .map(|n| n.input.key.clone())
            .collect();
        let deprecated: HashMap<String, bool> = conversion
            .notes
            .iter()
            .map(|n| (n.input.key.clone(), n.deprecated))
            .collect();
        let mut candidates = Vec::with_capacity(conversion.notes.len());
        for note in conversion.notes {
            match note.input.validate() {
                Ok(()) => candidates.push(Candidate {
                    path: note.path,
                    input: note.input,
                }),
                Err(error) => {
                    failed.push(ImportFailure::new(note.path, format!("{error:#}"), false))
                }
            }
        }
        let mut report = self.import_candidates(candidates, failed, None).await?;

        let mut okf_report = OkfImport {
            read: conversion.summary,
            retired: 0,
            restored: 0,
            removed: 0,
        };
        for note in &mut report.notes {
            let legacy = deprecated.get(&note.key).copied().unwrap_or(false);
            match (legacy, note.status) {
                (true, Status::Active) => okf_report.retired += 1,
                (false, Status::Legacy) => okf_report.restored += 1,
                _ => continue,
            }
            self.set_legacy(note.id, legacy, Some(domain)).await?;
            note.status = if legacy {
                Status::Legacy
            } else {
                Status::Active
            };
        }
        let prefix = format!("{}/", bundle.root.to_string_lossy());
        let present: HashSet<&str> = bundle.paths().collect();
        for note in self.store.notes(Some(domain), true).await? {
            if note.status != Status::Active || made.contains(&note.input.key) {
                continue;
            }
            let Some(source) = note.input.source.as_deref() else {
                continue;
            };
            let gone = match source.strip_prefix(&prefix) {
                // A note from this bundle: gone when its concept file is, or
                // when the file was read and no longer makes this note. A
                // file that failed this time keeps its notes as they are.
                Some(rest) => {
                    let file = if present.contains(rest) {
                        rest
                    } else {
                        rest.rsplit_once('#').map_or(rest, |(file, _)| file)
                    };
                    !present.contains(file) || !failed_files.contains(file)
                }
                // A note an earlier import of this bundle made from another
                // folder (the bundle moved): its source file no longer exists.
                None => okf_source_of(&note.input.key, source)
                    .is_some_and(|file| !Path::new(file).exists()),
            };
            if gone {
                self.set_legacy(note.id, true, Some(domain)).await?;
                okf_report.removed += 1;
            }
        }
        report.okf = Some(okf_report);
        report.truncated = report.notes.len() > 20;
        report.notes.truncate(20);
        Ok(report)
    }

    /// Import every Markdown file under `root`. With `strict_domain`, files
    /// whose frontmatter names another domain fail. Failure paths are shown
    /// relative to `base`, or to the root when it is `None`. With a viewer,
    /// the report names only notes it may see.
    async fn ingest_scoped(
        &self,
        root: &Path,
        domain: &str,
        strict_domain: bool,
        base: Option<&Path>,
        viewer: Option<&Viewer>,
    ) -> Result<ImportReport> {
        let root = root.to_path_buf();
        // Directory walks and file reads block, so keep them off the async executor.
        let tree = tokio::task::spawn_blocking(move || read_markdown_tree(&root))
            .await
            .context("note import task failed")??;
        if tree.files.is_empty() {
            not_found!("no Markdown notes found there");
        }
        let base = base.map_or(tree.base, Path::to_path_buf);
        let (candidates, failed) = prepare(tree.files, &base, domain, strict_domain, viewer);
        self.import_candidates(candidates, failed, viewer).await
    }

    /// Write `candidates`, valid notes in import order, adding to `failed`
    /// those that can't be owned or embedded. With a viewer, the report names
    /// only notes it may see.
    async fn import_candidates(
        &self,
        candidates: Vec<Candidate>,
        mut failed: Vec<ImportFailure>,
        viewer: Option<&Viewer>,
    ) -> Result<ImportReport> {
        // Check ownership and embed changed notes before writing anything.
        let mut owned = Vec::with_capacity(candidates.len());
        let mut changed = Vec::new();
        for candidate in candidates {
            let existing = self.store.get(candidate.input.id()).await?;
            if let Err(error) =
                check_ownership(existing.as_ref(), &candidate.input, WriteOrigin::Import)
            {
                failed.push(candidate.fail(format!("{error:#}"), viewer));
                continue;
            }
            // A note the embedding service may not read is never sent to it.
            if self.embedder.reads(&candidate.input)
                && !existing.is_some_and(|note| note.input == candidate.input && note.vector_synced)
            {
                changed.push(owned.len());
            }
            owned.push(candidate);
        }
        let texts: Vec<String> = changed
            .iter()
            .map(|i| document_text(&owned[*i].input))
            .collect();
        let vectors = embed_skipping_too_long(&texts, |batch| async move {
            self.embedder.embed_documents(&batch).await
        })
        .await
        .context("cannot embed the notes; nothing was imported")?;
        let mut pending: HashMap<Uuid, Vec<f32>> = HashMap::new();
        let mut too_long = HashSet::new();
        for (index, vector) in changed.iter().zip(vectors) {
            match vector {
                Some(vector) => {
                    pending.insert(owned[*index].input.id(), vector);
                }
                None => {
                    too_long.insert(*index);
                }
            }
        }
        let mut ready = Vec::with_capacity(owned.len());
        for (index, candidate) in owned.into_iter().enumerate() {
            if too_long.contains(&index) {
                let reason = too_long_reason(&candidate.input);
                failed.push(candidate.fail(reason, viewer));
            } else {
                ready.push(candidate);
            }
        }
        if ready.is_empty() {
            return Err(nothing_imported(failed));
        }

        let _guard = self.store.mutation_lock().await?;
        // Another writer may have claimed a key while we were embedding.
        let mut accepted = Vec::with_capacity(ready.len());
        for candidate in ready {
            let current = self.store.get(candidate.input.id()).await?;
            match check_ownership(current.as_ref(), &candidate.input, WriteOrigin::Import) {
                Ok(()) => accepted.push(candidate),
                Err(error) => failed.push(candidate.fail(format!("{error:#}"), viewer)),
            }
        }
        if accepted.is_empty() {
            return Err(nothing_imported(failed));
        }
        let domains: HashSet<String> = accepted.iter().map(|c| c.input.domain.clone()).collect();
        let mut saved = Vec::with_capacity(accepted.len());
        for candidate in &accepted {
            saved.push(self.store.upsert(&candidate.input).await?);
        }
        let mut unresolved = Vec::new();
        for domain in domains {
            let domain_notes = self.store.notes(Some(&domain), true).await?;
            let (edges, missing) = graph::resolve_edges_with_report(&domain_notes);
            self.store.replace_edges(&domain, &edges).await?;
            match viewer.filter(|viewer| viewer.restricts_notes()) {
                Some(viewer) => {
                    let visible: HashSet<Uuid> = domain_notes
                        .iter()
                        .filter(|note| viewer.sees(note))
                        .map(|note| note.id)
                        .collect();
                    unresolved.extend(missing.into_iter().filter(|u| visible.contains(&u.source)));
                }
                None => unresolved.extend(missing),
            }
        }
        let mut batch = Vec::new();
        let mut unsent = Vec::new();
        for note in saved.iter().filter(|note| !note.vector_synced) {
            if !self.embedder.reads(&note.input) {
                unsent.push(note);
                continue;
            }
            let vector = match pending.remove(&note.id) {
                Some(vector) => vector,
                None => self.embed_note(&note.input).await?,
            };
            batch.push((note.clone(), vector));
        }
        let unsent_ids: Vec<Uuid> = unsent.iter().map(|note| note.id).collect();
        self.vector.upsert_many(&batch).await.context(
            "the notes are saved, but the vector index could not be updated; it will be repaired automatically",
        )?;
        self.vector.delete(&unsent_ids).await.context(
            "the notes are saved, but the vector index could not be updated; it will be repaired automatically",
        )?;
        for note in batch
            .iter()
            .map(|(note, _)| note)
            .chain(unsent.iter().copied())
        {
            self.store.mark_synced(note.id, note.revision).await?;
        }
        let not_sent_to_embedder = unsent.len();
        let unresolved_count = unresolved.len();
        unresolved.truncate(50);
        let hidden_failures = failed.iter().filter(|f| f.hidden).count();
        failed.retain(|f| !f.hidden);
        failed.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(ImportReport {
            imported: saved.len(),
            notes: saved
                .into_iter()
                .filter(|note| listed(viewer, Some(&note.input)))
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
            failed,
            hidden_failures,
            okf: None,
            not_sent_to_embedder,
        })
    }

    /// Import from `MEMORY_NOTES_ROOT` for a tool: paths stay inside it, and
    /// every file must belong to `domain`.
    pub async fn hydrate(
        &self,
        relative_path: Option<&str>,
        domain: Option<&str>,
        viewer: Option<&Viewer>,
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
        if okf::enclosing_bundle(&selected, &root).is_some() {
            invalid!(
                "{:?} is in an OKF bundle; import the bundle from the command line, which names its domain: kioku ingest --path <bundle> --domain <domain>",
                relative.display().to_string()
            );
        }
        let mut report = self
            .ingest_scoped(
                &selected,
                self.domain(domain),
                true,
                Some(root.as_path()),
                viewer,
            )
            .await?;
        report.truncated = report.notes.len() > 20;
        report.notes.truncate(20);
        Ok(report)
    }

    /// Save notes and their vectors without rebuilding their domains' links,
    /// so a benchmark can grow a domain past what one load may hold. Each note
    /// is embedded unless the embedding service may not read it. The caller
    /// rebuilds the links ([`crate::store::Store::replace_edges`]).
    pub(crate) async fn save_unlinked(&self, inputs: &[NoteInput]) -> Result<Vec<Note>> {
        for input in inputs {
            input.validate()?;
        }
        let embedded: Vec<&NoteInput> = inputs.iter().filter(|i| self.embedder.reads(i)).collect();
        let texts: Vec<String> = embedded.iter().map(|i| document_text(i)).collect();
        let mut vectors: HashMap<Uuid, Vec<f32>> = embedded
            .iter()
            .map(|input| input.id())
            .zip(self.embedder.embed_documents(&texts).await?)
            .collect();
        let _guard = self.store.mutation_lock().await?;
        let mut saved = Vec::with_capacity(inputs.len());
        for input in inputs {
            saved.push(self.store.upsert(input).await?);
        }
        let batch: Vec<(Note, Vec<f32>)> = saved
            .iter()
            .filter_map(|note| Some((note.clone(), vectors.remove(&note.id)?)))
            .collect();
        self.vector.upsert_many(&batch).await?;
        for note in &saved {
            self.store.mark_synced(note.id, note.revision).await?;
        }
        Ok(saved)
    }
}

/// Parse and validate every file. Returns the notes that can be imported,
/// sorted by domain and key, and why the others can't. Files that claim the
/// same key all fail, since which one should win is not ours to guess.
fn prepare(
    files: Vec<(String, Result<String>)>,
    base: &Path,
    domain: &str,
    strict_domain: bool,
    viewer: Option<&Viewer>,
) -> (Vec<Candidate>, Vec<ImportFailure>) {
    let mut candidates = Vec::new();
    let mut failed = Vec::new();
    // With vault rules, a file must name its domain itself.
    let fallback = (!viewer.is_some_and(Viewer::restricts_notes)).then_some(domain);
    for (source, text) in files {
        let path = relative_path(base, &source);
        match text.and_then(|text| parse_file(&source, &text, fallback)) {
            Ok(input) if strict_domain && input.domain != domain => {
                let reason = format!(
                    "declares domain {:?}, but the import is for domain {domain:?}",
                    input.domain
                );
                let hidden = !listed(viewer, Some(&input));
                failed.push(ImportFailure::new(path, reason, hidden));
            }
            Ok(input) => candidates.push(Candidate { path, input }),
            Err(error) => {
                let hidden = !listed(viewer, None);
                failed.push(ImportFailure::new(path, format!("{error:#}"), hidden));
            }
        }
    }
    let mut paths_by_id: HashMap<Uuid, Vec<String>> = HashMap::new();
    for candidate in &candidates {
        paths_by_id
            .entry(candidate.input.id())
            .or_default()
            .push(candidate.path.clone());
    }
    let mut unique = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let mut others: Vec<&str> = paths_by_id
            .get(&candidate.input.id())
            .into_iter()
            .flatten()
            .map(String::as_str)
            .filter(|path| *path != candidate.path)
            .collect();
        if others.is_empty() {
            unique.push(candidate);
            continue;
        }
        others.sort_unstable();
        let reason = format!(
            "uses key {:?} in domain {:?}, as does {}; give each note its own key",
            candidate.input.key,
            candidate.input.domain,
            others.join(", ")
        );
        failed.push(candidate.fail(reason, viewer));
    }
    unique.sort_by(|a, b| (&a.input.domain, &a.input.key).cmp(&(&b.input.domain, &b.input.key)));
    (unique, failed)
}

/// One file's note. Its provenance is its real location, never its frontmatter.
/// Without a `domain`, the frontmatter must name one.
fn parse_file(source: &str, text: &str, domain: Option<&str>) -> Result<NoteInput> {
    let mut input = match domain {
        Some(domain) => markdown::parse_markdown(text, source, domain)?,
        None => markdown::parse_markdown_declared(text, source)?,
    };
    input.source = Some(source.to_owned());
    input.validate()?;
    Ok(input)
}

/// The concept file an OKF import recorded as the source of note `key`, when
/// `source` has that shape: the key's concept ID as the file's bundle path
/// (`…/<concept ID>.md`, plus `#<anchor>` for a section).
fn okf_source_of<'a>(key: &str, source: &'a str) -> Option<&'a str> {
    let (concept, anchor) = match key.split_once('#') {
        Some((concept, anchor)) => (concept, Some(anchor)),
        None => (key, None),
    };
    let file = match anchor {
        Some(anchor) => source.strip_suffix(&format!("#{anchor}"))?,
        None => source,
    };
    file.ends_with(&format!("/{concept}.md")).then_some(file)
}

/// `source` relative to `base` when it lies below it, otherwise as given.
fn relative_path(base: &Path, source: &str) -> String {
    Path::new(source)
        .strip_prefix(base)
        .ok()
        .filter(|path| !path.as_os_str().is_empty())
        .map_or_else(
            || source.to_owned(),
            |path| path.to_string_lossy().into_owned(),
        )
}

fn too_long_reason(input: &NoteInput) -> String {
    format!(
        "too long for the embedding model ({} bytes of text); split it into focused notes, one decision each, and link them with related",
        input.body.len()
    )
}

/// What the failures a vault session isn't told about are, after their count.
fn unnamed(count: usize) -> String {
    let files = if count == 1 { "file" } else { "files" };
    format!(
        "{files} not named here: notes this session may not see, or files whose vault can't be told because they name no domain in their frontmatter or can't be read or parsed"
    )
}

/// The error for an import in which every file failed.
fn nothing_imported(mut failed: Vec<ImportFailure>) -> anyhow::Error {
    failed.sort_by(|a, b| a.path.cmp(&b.path));
    let hidden = failed.iter().filter(|f| f.hidden).count();
    failed.retain(|f| !f.hidden);
    let mut listed: Vec<String> = failed
        .iter()
        .take(LISTED_FAILURES)
        .map(|failure| format!("{}: {}", failure.path, failure.reason))
        .collect();
    if failed.len() > LISTED_FAILURES {
        listed.push(format!("and {} more", failed.len() - LISTED_FAILURES));
    }
    if hidden > 0 {
        listed.push(format!("and {hidden} more {}", unnamed(hidden)));
    }
    UserError::InvalidArgument(format!(
        "nothing was imported; every file failed. {}",
        listed.join("; ")
    ))
    .into()
}

/// Embed `texts` in batches. A text the model reports as too long gets `None`
/// and the rest of its batch is embedded again without it; any other failure
/// is returned, so nothing is written when the service is down.
async fn embed_skipping_too_long<F, Fut>(
    texts: &[String],
    mut embed: F,
) -> Result<Vec<Option<Vec<f32>>>>
where
    F: FnMut(Vec<String>) -> Fut,
    Fut: Future<Output = Result<Vec<Vec<f32>>>>,
{
    let mut out: Vec<Option<Vec<f32>>> = vec![None; texts.len()];
    let indices: Vec<usize> = (0..texts.len()).collect();
    for chunk in indices.chunks(embedding::BATCH) {
        let mut remaining = chunk.to_vec();
        while !remaining.is_empty() {
            let batch = remaining.iter().map(|i| texts[*i].clone()).collect();
            match embed(batch).await {
                Ok(vectors) => {
                    ensure!(
                        vectors.len() == remaining.len(),
                        "the embedding service returned {} vectors for {} texts",
                        vectors.len(),
                        remaining.len()
                    );
                    for (index, vector) in remaining.iter().zip(vectors) {
                        out[*index] = Some(vector);
                    }
                    break;
                }
                Err(error) => {
                    let culprit = failed_index(&error)
                        .or_else(|| (is_too_long(&error) && remaining.len() == 1).then_some(0));
                    match culprit {
                        Some(offset) if offset < remaining.len() => {
                            remaining.remove(offset);
                        }
                        _ => return Err(error),
                    }
                }
            }
        }
    }
    Ok(out)
}

/// Read every visible Markdown file under `root` (or `root` itself if it is a
/// file). Hidden files and directories are skipped and symlinks are not
/// followed. A file that is too large or not UTF-8 is returned with its error;
/// a path escaping the root fails the whole walk.
fn read_markdown_tree(root: &Path) -> Result<MarkdownTree> {
    ensure!(
        root.exists(),
        "input path {} does not exist",
        root.display()
    );
    let canonical = root.canonicalize()?;
    let base = match canonical.parent() {
        Some(parent) if !canonical.is_dir() => parent.to_path_buf(),
        _ => canonical.clone(),
    };
    let mut files = Vec::new();
    // An OKF bundle inside the tree is not a folder of notes: its concepts
    // would get the wrong keys and lose their links. It is reported instead.
    let mut bundles: Vec<PathBuf> = Vec::new();
    for entry in walkdir::WalkDir::new(&canonical)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            if e.file_name().to_string_lossy().starts_with('.') {
                return false;
            }
            if e.file_type().is_dir() && okf::bundle_version(e.path()).is_some() {
                bundles.push(e.path().to_path_buf());
                return false;
            }
            true
        })
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
        let text = entry
            .metadata()
            .context("cannot read the file")
            .and_then(|metadata| read_note_file(&real, metadata.len()));
        files.push((real.to_string_lossy().into_owned(), text));
        ensure!(
            files.len() <= MAX_FILES,
            "an import is limited to {MAX_FILES} notes"
        );
    }
    for bundle in bundles {
        files.push((
            bundle.to_string_lossy().into_owned(),
            Err(anyhow::anyhow!(
                "an OKF bundle (its index.md declares okf_version); import it from the command line: kioku ingest --path <bundle> --domain <domain>"
            )),
        ));
    }
    Ok(MarkdownTree { base, files })
}

fn read_note_file(path: &Path, len: u64) -> Result<String> {
    ensure!(
        len <= MAX_FILE_BYTES,
        "exceeds 32 KiB; split it into focused notes"
    );
    std::fs::read_to_string(path).context("cannot read the file as UTF-8 text")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embedding::EmbedError;

    fn file(source: &str, text: &str) -> (String, Result<String>) {
        (source.to_owned(), Ok(text.to_owned()))
    }

    fn note(key: &str) -> String {
        format!("---\nkey: {key}\ntitle: {key}\n---\nEvidence for {key}.\n")
    }

    fn reasons(failed: &[ImportFailure]) -> Vec<(&str, &str)> {
        let mut out: Vec<_> = failed
            .iter()
            .map(|f| (f.path.as_str(), f.reason.as_str()))
            .collect();
        out.sort_unstable();
        out
    }

    #[test]
    fn bad_files_are_reported_and_good_ones_kept() {
        let files = vec![
            file("/notes/good.md", &note("good")),
            file("/notes/sub/broken.md", "---\nkey: [unclosed\n---\nBody.\n"),
            file(
                "/notes/elsewhere.md",
                "---\nkey: elsewhere\ndomain: other\n---\nBody.\n",
            ),
            file("/notes/empty.md", "---\nkey: empty\n---\n"),
            file("/notes/a.md", &note("twin")),
            file("/notes/b.md", &note("twin")),
            (
                "/notes/huge.md".to_owned(),
                Err(anyhow::anyhow!(
                    "exceeds 32 KiB; split it into focused notes"
                )),
            ),
        ];
        let (candidates, failed) = prepare(files, Path::new("/notes"), "local", true, None);
        assert_eq!(
            candidates
                .iter()
                .map(|c| c.path.as_str())
                .collect::<Vec<_>>(),
            ["good.md"]
        );
        assert_eq!(
            candidates[0].input.source.as_deref(),
            Some("/notes/good.md")
        );
        let reasons = reasons(&failed);
        let paths: Vec<&str> = reasons.iter().map(|(path, _)| *path).collect();
        assert_eq!(
            paths,
            [
                "a.md",
                "b.md",
                "elsewhere.md",
                "empty.md",
                "huge.md",
                "sub/broken.md"
            ]
        );
        assert!(reasons[0].1.contains("as does b.md"), "{}", reasons[0].1);
        assert!(reasons[1].1.contains("as does a.md"), "{}", reasons[1].1);
        assert!(reasons[2].1.contains("declares domain \"other\""));
        assert!(reasons[3].1.contains("body"), "{}", reasons[3].1);
        assert!(reasons[4].1.contains("32 KiB"));
        assert!(reasons[5].1.contains("invalid YAML frontmatter"));
    }

    #[test]
    fn a_vault_session_hears_only_about_its_own_notes() {
        use crate::access::Principal;
        use crate::vault::{Session, Vaults};
        let vaults = std::sync::Arc::new(
            Vaults::parse(
                "[[vault]]\nname = \"a\"\ndomains = [\"a\"]\nproviders = [\"anthropic\"]\ndefault_domain = \"a\"\n[[vault]]\nname = \"b\"\ndomains = [\"b\"]\nproviders = [\"anthropic\"]\ndefault_domain = \"b\"\n",
                Path::new("/cfg/vaults.toml"),
                None,
            )
            .unwrap(),
        );
        let principal = Principal::new("p", "read", "*")
            .unwrap()
            .with_vault(Some("anthropic"), Some("a"))
            .unwrap();
        let viewer = Viewer::new(
            &principal,
            &Session::for_principal(Some(&vaults), &principal),
        );
        let files = || {
            let locked = "---\nkey: secret\ndomain: a\nlock: [local]\n---\nBody.\n";
            vec![
                file("/notes/a1.md", "---\nkey: twin\ndomain: a\n---\nBody.\n"),
                file("/notes/a2.md", "---\nkey: twin\ndomain: a\n---\nBody.\n"),
                file("/notes/s1.md", locked),
                file("/notes/s2.md", locked),
                file("/notes/theirs.md", "---\nkey: t\ndomain: b\n---\nBody.\n"),
                file("/notes/broken.md", "---\nkey: [x\n---\nBody.\n"),
                // Vault b's file that relies on the import's domain.
                file(
                    "/notes/b/plain.md",
                    "---\nkey: plain\n---\nVault b's text.\n",
                ),
            ]
        };
        let (candidates, failed) = prepare(files(), Path::new("/notes"), "a", true, Some(&viewer));
        assert!(
            candidates.is_empty(),
            "a file without a domain must not join the session's domain"
        );
        let shown: Vec<&str> = failed
            .iter()
            .filter(|f| !f.hidden)
            .map(|f| f.path.as_str())
            .collect();
        assert_eq!(shown, ["a1.md", "a2.md"]);
        assert_eq!(failed.iter().filter(|f| f.hidden).count(), 5);
        let message = nothing_imported(failed).to_string();
        assert!(
            message.contains("and 5 more files not named here")
                && message.contains("name no domain"),
            "{message}"
        );
        assert!(
            !message.contains("theirs") && !message.contains("s1.md") && !message.contains("plain"),
            "{message}"
        );
        let (candidates, everything) = prepare(files(), Path::new("/notes"), "a", true, None);
        assert!(everything.iter().all(|f| !f.hidden) && everything.len() == 6);
        assert_eq!(
            candidates.len(),
            1,
            "without vaults the import's domain applies"
        );
        assert_eq!(candidates[0].input.domain, "a");
    }

    #[test]
    fn a_bundle_inside_a_notes_tree_is_reported_not_read_as_notes() {
        let root = std::env::temp_dir().join(format!("kioku-tree-{}", Uuid::new_v4()));
        let bundle = root.join("kb");
        std::fs::create_dir_all(bundle.join("decisions")).unwrap();
        std::fs::write(root.join("note.md"), note("plain")).unwrap();
        std::fs::write(bundle.join("index.md"), "---\nokf_version: \"0.2\"\n---\n").unwrap();
        std::fs::write(
            bundle.join("decisions/DEC-1.md"),
            "---\ntype: Decision\n---\nText.\n",
        )
        .unwrap();
        let tree = read_markdown_tree(&root).unwrap();
        let _ = std::fs::remove_dir_all(&root);
        let names: Vec<(String, bool)> = tree
            .files
            .iter()
            .map(|(path, text)| {
                let name = Path::new(path)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                (name, text.is_ok())
            })
            .collect();
        assert_eq!(
            names,
            [("note.md".to_owned(), true), ("kb".to_owned(), false)]
        );
        let reason = format!("{:#}", tree.files[1].1.as_ref().unwrap_err());
        assert!(
            reason.contains("OKF bundle") && reason.contains("kioku ingest"),
            "{reason}"
        );
    }

    #[test]
    fn an_okf_source_is_recognized_by_its_concept_id() {
        let source = "/old/place/kb/decisions/DEC-1.md";
        assert_eq!(okf_source_of("kb/decisions/DEC-1", source), Some(source));
        assert_eq!(
            okf_source_of(
                "kb/architecture#router",
                "/old/place/kb/architecture.md#router"
            ),
            Some("/old/place/kb/architecture.md")
        );
        assert_eq!(okf_source_of("kb/decisions/DEC-1", "/notes/DEC-1.md"), None);
        assert_eq!(okf_source_of("plain-key", "/notes/other.md"), None);
        assert_eq!(okf_source_of("kb/x#a", "/old/kb/x.md#b"), None);
    }

    #[test]
    fn only_reports_with_unnamed_failures_explain_them() {
        let report = |hidden_failures| ImportReport {
            imported: 1,
            notes: Vec::new(),
            truncated: false,
            unresolved_relationships: Vec::new(),
            unresolved_count: 0,
            failed: Vec::new(),
            hidden_failures,
            okf: None,
            not_sent_to_embedder: 0,
        };
        assert_eq!(report(0).unnamed_failures(), None);
        let hint = report(2).unnamed_failures().unwrap();
        assert!(
            hint.starts_with("failed_count includes 2 files not named here")
                && hint.contains("must name its domain"),
            "{hint}"
        );
        assert!(report(1).unnamed_failures().unwrap().contains("1 file not"));
    }

    #[test]
    fn a_plain_ingest_accepts_frontmatter_domains_and_sorts_notes() {
        let files = vec![
            file("/notes/z.md", &note("zeta")),
            file(
                "/notes/other.md",
                "---\nkey: alpha\ndomain: other\n---\nBody.\n",
            ),
            file("/notes/a.md", &note("alpha")),
        ];
        let (candidates, failed) = prepare(files, Path::new("/notes"), "local", false, None);
        assert!(failed.is_empty(), "{failed:?}");
        let order: Vec<_> = candidates
            .iter()
            .map(|c| (c.input.domain.as_str(), c.input.key.as_str()))
            .collect();
        assert_eq!(
            order,
            [("local", "alpha"), ("local", "zeta"), ("other", "alpha")]
        );
    }

    #[test]
    fn paths_are_shown_relative_to_the_import_root() {
        let base = Path::new("/notes");
        assert_eq!(relative_path(base, "/notes/a/b.md"), "a/b.md");
        assert_eq!(relative_path(base, "/elsewhere/c.md"), "/elsewhere/c.md");
        assert_eq!(relative_path(base, "/notes"), "/notes");
    }

    #[test]
    fn an_import_where_every_file_failed_is_an_invalid_argument() {
        let failed: Vec<ImportFailure> = (0..25)
            .rev()
            .map(|i| ImportFailure::new(format!("note-{i:02}.md"), "broken".into(), false))
            .collect();
        let error = nothing_imported(failed);
        let message = error.to_string();
        assert!(matches!(
            error.downcast_ref::<UserError>(),
            Some(UserError::InvalidArgument(_))
        ));
        assert!(message.starts_with("nothing was imported"), "{message}");
        assert!(
            message.contains("note-00.md: broken; note-01.md"),
            "{message}"
        );
        assert!(!message.contains("note-20.md"), "{message}");
        assert!(message.ends_with("and 5 more"), "{message}");
    }

    #[tokio::test]
    async fn notes_too_long_to_embed_are_skipped_and_the_rest_embedded() {
        let texts: Vec<String> = (0..40)
            .map(|i| {
                if [3, 4, 17].contains(&i) {
                    format!("too long {i}")
                } else {
                    format!("fine {i}")
                }
            })
            .collect();
        let mut calls = 0;
        let vectors = embed_skipping_too_long(&texts, |batch| {
            calls += 1;
            let culprit = batch.iter().position(|text| text.starts_with("too long"));
            async move {
                match culprit {
                    Some(index) => Err(EmbedError::TooLong {
                        model: "test".into(),
                        index: Some(index),
                    }
                    .into()),
                    None => Ok(batch.iter().map(|text| vec![text.len() as f32]).collect()),
                }
            }
        })
        .await
        .unwrap();
        let skipped: Vec<usize> = (0..texts.len()).filter(|i| vectors[*i].is_none()).collect();
        assert_eq!(skipped, [3, 4, 17]);
        assert_eq!(vectors[5], Some(vec![texts[5].len() as f32]));
        // Three batches, plus one retry per oversized note.
        assert_eq!(calls, 6);
    }

    #[tokio::test]
    async fn an_embedding_outage_fails_the_import() {
        let texts = vec!["fine".to_owned()];
        let error = embed_skipping_too_long(&texts, |_| async {
            Err(EmbedError::Unavailable("connection refused".into()).into())
        })
        .await
        .unwrap_err();
        assert!(matches!(
            error.downcast_ref::<EmbedError>(),
            Some(EmbedError::Unavailable(_))
        ));
    }

    #[test]
    fn unreadable_files_are_reported_without_stopping_the_walk() {
        let root = std::env::temp_dir().join(format!("kioku-import-{}", Uuid::new_v4()));
        std::fs::create_dir_all(root.join(".hidden")).unwrap();
        let canonical = root.canonicalize().unwrap();
        std::fs::write(root.join("good.md"), note("good")).unwrap();
        std::fs::write(root.join("huge.md"), "x".repeat(40_000)).unwrap();
        std::fs::write(root.join("binary.md"), [0xff, 0xfe, 0x00]).unwrap();
        std::fs::write(root.join(".hidden/skipped.md"), note("hidden")).unwrap();
        std::fs::write(root.join("notes.txt"), "not Markdown").unwrap();
        let tree = read_markdown_tree(&root).unwrap();
        let single = read_markdown_tree(&root.join("good.md")).unwrap();
        std::fs::remove_dir_all(&root).unwrap();

        assert_eq!(tree.base, canonical);
        assert_eq!(single.base, canonical);
        let mut outcome: Vec<(String, Result<(), String>)> = tree
            .files
            .into_iter()
            .map(|(source, text)| {
                (
                    relative_path(&tree.base, &source),
                    text.map(|_| ()).map_err(|e| format!("{e:#}")),
                )
            })
            .collect();
        outcome.sort();
        assert_eq!(outcome.len(), 3, "{outcome:?}");
        assert!(
            outcome[0].0 == "binary.md"
                && outcome[0].1.as_ref().is_err_and(|e| e.contains("UTF-8"))
        );
        assert_eq!(outcome[1], ("good.md".to_owned(), Ok(())));
        assert!(
            outcome[2].0 == "huge.md" && outcome[2].1.as_ref().is_err_and(|e| e.contains("32 KiB"))
        );
    }
}

//! Importing Markdown notes and hydrating selected files.
//!
//! A file that cannot be read, parsed, validated, owned, or embedded is
//! skipped and reported in [`ImportReport::failed`]; the other files import
//! normally. Only when every file fails is the import an error.

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
use crate::model::{NoteInput, Status};

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
}

/// A parsed, valid note and the path it is reported under.
struct Candidate {
    path: String,
    input: NoteInput,
}

impl Candidate {
    fn fail(self, reason: String) -> ImportFailure {
        ImportFailure {
            path: self.path,
            reason,
        }
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
        self.ingest_scoped(root, domain, false, None).await
    }

    /// Import every Markdown file under `root`. With `strict_domain`, files
    /// whose frontmatter names another domain fail. Failure paths are shown
    /// relative to `base`, or to the root when it is `None`.
    async fn ingest_scoped(
        &self,
        root: &Path,
        domain: &str,
        strict_domain: bool,
        base: Option<&Path>,
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
        let (candidates, mut failed) = prepare(tree.files, &base, domain, strict_domain);

        // Check ownership and embed changed notes before writing anything.
        let mut owned = Vec::with_capacity(candidates.len());
        let mut changed = Vec::new();
        for candidate in candidates {
            let existing = self.store.get(candidate.input.id()).await?;
            if let Err(error) =
                check_ownership(existing.as_ref(), &candidate.input, WriteOrigin::Import)
            {
                failed.push(candidate.fail(format!("{error:#}")));
                continue;
            }
            if !existing.is_some_and(|note| note.input == candidate.input && note.vector_synced) {
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
                failed.push(candidate.fail(reason));
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
                Err(error) => failed.push(candidate.fail(format!("{error:#}"))),
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
        failed.sort_by(|a, b| a.path.cmp(&b.path));
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
            failed,
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
            .ingest_scoped(&selected, self.domain(domain), true, Some(root.as_path()))
            .await?;
        report.truncated = report.notes.len() > 20;
        report.notes.truncate(20);
        Ok(report)
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
) -> (Vec<Candidate>, Vec<ImportFailure>) {
    let mut candidates = Vec::new();
    let mut failed = Vec::new();
    for (source, text) in files {
        let path = relative_path(base, &source);
        match text.and_then(|text| parse_file(&source, &text, domain, strict_domain)) {
            Ok(input) => candidates.push(Candidate { path, input }),
            Err(error) => failed.push(ImportFailure {
                path,
                reason: format!("{error:#}"),
            }),
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
        failed.push(candidate.fail(reason));
    }
    unique.sort_by(|a, b| (&a.input.domain, &a.input.key).cmp(&(&b.input.domain, &b.input.key)));
    (unique, failed)
}

/// One file's note. Its provenance is its real location, never its frontmatter.
fn parse_file(source: &str, text: &str, domain: &str, strict_domain: bool) -> Result<NoteInput> {
    let mut input = markdown::parse_markdown(text, source, domain)?;
    ensure!(
        !strict_domain || input.domain == domain,
        "declares domain {:?}, but the import is for domain {domain:?}",
        input.domain
    );
    input.source = Some(source.to_owned());
    input.validate()?;
    Ok(input)
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

/// The error for an import in which every file failed.
fn nothing_imported(mut failed: Vec<ImportFailure>) -> anyhow::Error {
    failed.sort_by(|a, b| a.path.cmp(&b.path));
    let mut listed: Vec<String> = failed
        .iter()
        .take(LISTED_FAILURES)
        .map(|failure| format!("{}: {}", failure.path, failure.reason))
        .collect();
    if failed.len() > LISTED_FAILURES {
        listed.push(format!("and {} more", failed.len() - LISTED_FAILURES));
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
        let (candidates, failed) = prepare(files, Path::new("/notes"), "local", true);
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
    fn a_plain_ingest_accepts_frontmatter_domains_and_sorts_notes() {
        let files = vec![
            file("/notes/z.md", &note("zeta")),
            file(
                "/notes/other.md",
                "---\nkey: alpha\ndomain: other\n---\nBody.\n",
            ),
            file("/notes/a.md", &note("alpha")),
        ];
        let (candidates, failed) = prepare(files, Path::new("/notes"), "local", false);
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
            .map(|i| ImportFailure {
                path: format!("note-{i:02}.md"),
                reason: "broken".into(),
            })
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

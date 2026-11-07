//! Building and reading the code map ([`crate::codemap`]). [`update_repo`]
//! and [`lookup_file`] take the store and a [`CodePlace`], so they run
//! without the rest of the application; [`App::code_place`] places a checkout
//! by its folder, as a session there would be placed.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use anyhow::Result;
use serde::Serialize;

use super::{App, is_zero};
use crate::codemap::{
    self, Change, CodeFile, FileSet, Language, MAX_FILE_BYTES, MAX_NEIGHBOURS, MAX_SHOWN_SYMBOLS,
    PurposeSource, Repository, Source, Summarizer, Symbol,
};
use crate::error::UserError;
use crate::store::{CodeMapChange, Store};
use crate::vault::{Provider, Session, Vaults, Viewer};

/// Files read from git at once, so a large repository is never in memory whole.
const READ_CHUNK: usize = 200;

/// Where a checkout's map lives.
pub struct CodePlace {
    pub repo: Repository,
    /// The domain the checkout's folder places local models in.
    pub domain: String,
    /// Folders inside the checkout, relative to its root, that other vault
    /// or area rules place elsewhere. Their files stay out of this map.
    pub excluded: Vec<String>,
}

impl CodePlace {
    /// Whether this map may hold the file at `path`, relative to the root.
    pub fn covers(&self, path: &str) -> bool {
        covers(&self.excluded, path)
    }
}

fn covers(excluded: &[String], path: &str) -> bool {
    !excluded
        .iter()
        .any(|folder| path == folder || path.starts_with(&format!("{folder}/")))
}

/// How an update runs.
pub struct UpdateOptions {
    /// Parse every file again, not only those that changed.
    pub full: bool,
    pub summarizer: Option<Summarizer>,
    /// Most files one update sends to the summarizer.
    pub summary_limit: usize,
}

#[derive(Debug, Default, Serialize)]
pub struct PurposeCounts {
    pub doc: usize,
    pub model: usize,
    pub missing: usize,
}

#[derive(Debug, Serialize)]
pub struct UpdateReport {
    /// The checkout's name: its remote, else its folder's name.
    pub repo: String,
    pub root: String,
    pub domain: String,
    pub commit: String,
    /// Source files in the map after the update.
    pub files: usize,
    /// Files this update parsed.
    pub parsed: usize,
    /// Entries this update wrote, new or changed.
    pub updated: usize,
    pub removed: usize,
    /// Files the summarizer wrote a purpose for.
    pub summarized: usize,
    pub purposes: PurposeCounts,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

/// A file's entry for a model that is about to read it.
#[derive(Debug, Serialize)]
pub struct FileMap {
    pub repo: String,
    pub domain: String,
    pub path: String,
    pub language: Language,
    pub purpose: Option<String>,
    pub purpose_source: Option<PurposeSource>,
    pub symbols: Vec<Symbol>,
    #[serde(skip_serializing_if = "is_zero")]
    pub more_symbols: usize,
    pub neighbours: Vec<Neighbour>,
    /// True when the file changed since the map described it, so this
    /// lookup parsed it again.
    pub reparsed: bool,
}

#[derive(Debug, Serialize)]
pub struct Neighbour {
    pub path: String,
    pub relation: Relation,
    pub purpose: Option<String>,
    /// Its first definitions, when it has no purpose.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub defines: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Relation {
    Imports,
    ImportedBy,
}

/// What an update reads before it plans.
struct PlanInput {
    base: Option<String>,
    full: bool,
    excluded: Vec<String>,
    existing: HashMap<String, CodeFile>,
    /// Most files to summarize; 0 without a summarizer.
    summary_limit: usize,
}

/// What an update will save, worked out from git off the async runtime.
struct Plan {
    head: String,
    upserts: Vec<CodeFile>,
    removed: Vec<String>,
    parsed: usize,
    /// Files to summarize, in order: files that changed and have no doc
    /// comment, then files that have no purpose at all.
    sources: Vec<Source>,
}

/// The texts of `paths` at `commit`. A path that is too large or not text
/// goes to `unreadable`.
fn read_texts(
    repo: &Repository,
    commit: &str,
    paths: &[String],
    unreadable: &mut HashSet<String>,
) -> Result<Vec<(String, Language, String)>> {
    let contents = repo.contents(commit, paths)?;
    let mut out = Vec::new();
    for (path, content) in paths.iter().zip(contents) {
        match (
            Language::for_path(path),
            content.and_then(|bytes| String::from_utf8(bytes).ok()),
        ) {
            (Some(language), Some(text)) => out.push((path.clone(), language, text)),
            _ => {
                unreadable.insert(path.clone());
            }
        }
    }
    Ok(out)
}

fn plan_update(repo: &Repository, input: &PlanInput) -> Result<Plan> {
    let head = repo.head()?.ok_or_else(|| {
        UserError::InvalidArgument(format!("{} has no commits yet", repo.root().display()))
    })?;
    let files = FileSet::new(
        repo.files_at(&head)?
            .into_iter()
            .filter(|path| covers(&input.excluded, path)),
    );
    let existing = &input.existing;
    // Without a usable base, everything is parsed. So it is when a file was
    // added, deleted or renamed: that can change what other, untouched
    // files' imports resolve to. Entries that come out the same aren't saved.
    let changes = match input
        .base
        .as_deref()
        .filter(|commit| !input.full && repo.has_commit(commit))
    {
        Some(commit) => Some(repo.changes(commit, &head)?),
        None => None,
    };
    let reshaped = changes.as_ref().is_none_or(|changes| {
        changes.iter().any(|change| match change {
            Change::Deleted(path) => existing.contains_key(path),
            Change::Changed(path) => files.contains(path) && !existing.contains_key(path),
        })
    });
    let mut wanted: BTreeSet<String> = if reshaped {
        files.paths().map(str::to_owned).collect()
    } else {
        changes
            .into_iter()
            .flatten()
            .filter_map(|change| match change {
                Change::Changed(path) => Some(path),
                Change::Deleted(_) => None,
            })
            .filter(|path| files.contains(path))
            .collect()
    };
    // Files the map lacks (a failed or an older update) are parsed as well.
    wanted.extend(
        files
            .paths()
            .filter(|path| !existing.contains_key(*path))
            .map(str::to_owned),
    );
    let wanted: Vec<String> = wanted.into_iter().collect();
    let mut plan = Plan {
        head: head.clone(),
        upserts: Vec::new(),
        removed: Vec::new(),
        parsed: 0,
        sources: Vec::new(),
    };
    let mut unreadable: HashSet<String> = HashSet::new();
    for chunk in wanted.chunks(READ_CHUNK) {
        for (path, language, text) in read_texts(repo, &head, chunk, &mut unreadable)? {
            let previous = existing.get(&path);
            let changed = previous.is_none_or(|old| old.digest != codemap::digest(&text));
            let file = CodeFile::build(&path, language, &text, &files, previous);
            plan.parsed += 1;
            if changed
                && file.purpose_source != Some(PurposeSource::Doc)
                && plan.sources.len() < input.summary_limit
                && crate::secrets::find_in_text(&text).is_none()
            {
                plan.sources.push(Source {
                    path: path.clone(),
                    language,
                    text,
                });
            }
            if previous != Some(&file) {
                plan.upserts.push(file);
            }
        }
    }
    // Then files that have no purpose yet, also from earlier updates.
    if plan.sources.len() < input.summary_limit {
        let parsed: HashSet<&str> = wanted.iter().map(String::as_str).collect();
        let mut backfill: Vec<String> = existing
            .values()
            .filter(|file| {
                file.purpose.is_none()
                    && files.contains(&file.path)
                    && !parsed.contains(file.path.as_str())
            })
            .map(|file| file.path.clone())
            .collect();
        backfill.sort();
        'chunks: for chunk in backfill.chunks(READ_CHUNK) {
            for (path, language, text) in read_texts(repo, &head, chunk, &mut unreadable)? {
                if crate::secrets::find_in_text(&text).is_some() {
                    continue;
                }
                plan.sources.push(Source {
                    path,
                    language,
                    text,
                });
                if plan.sources.len() >= input.summary_limit {
                    break 'chunks;
                }
            }
        }
    }
    plan.removed = existing
        .keys()
        .filter(|path| !files.contains(path) || unreadable.contains(*path))
        .cloned()
        .collect();
    Ok(plan)
}

/// Bring a checkout's map up to HEAD: parse the files that changed since the
/// last update (every file the first time, with `full`, or when files came
/// or went), drop the files HEAD no longer has, and ask the summarizer for
/// the purposes that are missing.
pub async fn update_repo(
    store: &Store,
    place: CodePlace,
    options: &UpdateOptions,
) -> Result<UpdateReport> {
    let CodePlace {
        repo,
        domain,
        excluded,
    } = place;
    let name = repo.name();
    let root = repo.root().display().to_string();
    let started_from = store.code_map_commit(&domain, &root).await?;
    let existing: HashMap<String, CodeFile> = store
        .code_map_files(&domain, &root)
        .await?
        .into_iter()
        .map(|file| (file.path.clone(), file))
        .collect();
    let input = PlanInput {
        base: started_from.clone().flatten(),
        full: options.full,
        excluded,
        existing,
        summary_limit: if options.summarizer.is_some() {
            options.summary_limit
        } else {
            0
        },
    };
    let (mut plan, existing) = tokio::task::spawn_blocking(move || -> Result<_> {
        let plan = plan_update(&repo, &input)?;
        Ok((plan, input.existing))
    })
    .await??;

    let mut notes = Vec::new();
    let mut summarized = 0;
    if let Some(summarizer) = &options.summarizer
        && !plan.sources.is_empty()
    {
        let summarizer = summarizer.clone();
        let repo_name = name.clone();
        let sources = std::mem::take(&mut plan.sources);
        let (purposes, errors) =
            tokio::task::spawn_blocking(move || summarizer.summarize(&repo_name, &sources)).await?;
        notes.extend(
            errors
                .into_iter()
                .map(|error| format!("summarizer: {error}")),
        );
        for (path, purpose) in purposes {
            let index = match plan.upserts.iter().position(|file| file.path == path) {
                Some(index) => index,
                None => match existing.get(&path) {
                    Some(old) => {
                        plan.upserts.push(old.clone());
                        plan.upserts.len() - 1
                    }
                    None => continue,
                },
            };
            let entry = &mut plan.upserts[index];
            if entry.purpose_source == Some(PurposeSource::Doc) {
                continue;
            }
            entry.purpose = Some(purpose);
            entry.purpose_source = Some(PurposeSource::Model);
            summarized += 1;
        }
    }

    let change = CodeMapChange {
        domain: &domain,
        root: &root,
        name: &name,
        started_from: started_from.as_ref().map(|commit| commit.as_deref()),
        commit: &plan.head,
        upserts: &plan.upserts,
        removed: &plan.removed,
    };
    if !store.save_code_map(&change).await? {
        notes.push(
            "another update saved this checkout's map first, so this one saved nothing".to_owned(),
        );
        let purposes = count_purposes(existing.values());
        return Ok(UpdateReport {
            repo: name,
            root,
            domain,
            commit: plan.head,
            files: existing.len(),
            parsed: 0,
            updated: 0,
            removed: 0,
            summarized: 0,
            purposes,
            notes,
        });
    }
    let (files, purposes) = {
        let mut map: HashMap<&str, &CodeFile> = existing
            .iter()
            .filter(|(path, _)| !plan.removed.contains(path))
            .map(|(path, file)| (path.as_str(), file))
            .collect();
        map.extend(plan.upserts.iter().map(|file| (file.path.as_str(), file)));
        (map.len(), count_purposes(map.values().copied()))
    };
    Ok(UpdateReport {
        repo: name,
        root,
        domain,
        commit: plan.head,
        files,
        parsed: plan.parsed,
        updated: plan.upserts.len(),
        removed: plan.removed.len(),
        summarized,
        purposes,
        notes,
    })
}

fn count_purposes<'a>(files: impl IntoIterator<Item = &'a CodeFile>) -> PurposeCounts {
    let mut counts = PurposeCounts::default();
    for file in files {
        match file.purpose_source {
            Some(PurposeSource::Doc) => counts.doc += 1,
            Some(PurposeSource::Model) => counts.model += 1,
            None => counts.missing += 1,
        }
    }
    counts
}

/// The text of a working-tree file the code map may describe.
fn read_source(file: &Path) -> Result<String> {
    let size = std::fs::metadata(file)
        .map_err(|_| UserError::NotFound(format!("{} does not exist", file.display())))?
        .len();
    if size > MAX_FILE_BYTES as u64 {
        return Err(UserError::InvalidArgument(format!(
            "{} is larger than the {} KB the code map reads",
            file.display(),
            MAX_FILE_BYTES / 1024
        ))
        .into());
    }
    String::from_utf8(std::fs::read(file)?).map_err(|_| {
        UserError::InvalidArgument(format!("{} is not UTF-8 text", file.display())).into()
    })
}

/// `path`'s entry in a checkout's map, with its neighbours. A file whose
/// content changed since the map described it, or that the map lacks, is
/// parsed from the working tree first and saved, keeping any model-written
/// purpose until the next update.
pub async fn lookup_file(store: &Store, place: CodePlace, path: &str) -> Result<FileMap> {
    let language = Language::for_path(path).ok_or_else(|| {
        let names: Vec<&str> = Language::ALL
            .iter()
            .map(|language| language.as_str())
            .collect();
        UserError::InvalidArgument(format!(
            "{path} is not a source file the code map covers ({})",
            names.join(", ")
        ))
    })?;
    if !place.covers(path) {
        return Err(UserError::Refused(format!(
            "{path} is in a folder that another vault or area rule places, so this checkout's code map doesn't cover it"
        ))
        .into());
    }
    let CodePlace {
        repo,
        domain,
        excluded,
    } = place;
    let name = repo.name();
    let root = repo.root().display().to_string();
    let stored = store
        .code_map_files_at(&domain, &root, &[path.to_owned()])
        .await?
        .into_iter()
        .next();
    let file_path = repo.root().join(path);
    let text = tokio::task::spawn_blocking(move || read_source(&file_path)).await??;
    let (file, reparsed) = match stored {
        Some(file) if file.digest == codemap::digest(&text) => (file, false),
        previous => {
            let owned = path.to_owned();
            let file = tokio::task::spawn_blocking(move || -> Result<CodeFile> {
                let tracked = repo.tracked()?;
                let files =
                    FileSet::new(tracked.into_iter().filter(|path| covers(&excluded, path)));
                Ok(CodeFile::build(
                    &owned,
                    language,
                    &text,
                    &files,
                    previous.as_ref(),
                ))
            })
            .await??;
            store
                .refresh_code_file(&domain, &root, &name, &file)
                .await?;
            (file, true)
        }
    };
    let imported = store
        .code_map_files_at(&domain, &root, &file.imports)
        .await?;
    let importers = store
        .code_map_importers(&domain, &root, path, i64::try_from(MAX_NEIGHBOURS)?)
        .await?;
    let neighbours = neighbours(&file.imports, &imported, &importers);
    let shown: Vec<Symbol> = file
        .main_symbols(MAX_SHOWN_SYMBOLS)
        .into_iter()
        .cloned()
        .collect();
    Ok(FileMap {
        repo: name,
        domain,
        path: file.path.clone(),
        language,
        purpose: file.purpose.clone(),
        purpose_source: file.purpose_source,
        more_symbols: file.symbols.len() - shown.len(),
        symbols: shown,
        neighbours,
        reparsed,
    })
}

/// Up to [`MAX_NEIGHBOURS`] files around one: some it imports, then some
/// that import it, then more it imports while there is room.
pub(crate) fn neighbours(
    imports: &[String],
    imported: &[CodeFile],
    importers: &[CodeFile],
) -> Vec<Neighbour> {
    let describe = |path: &str, relation: Relation, file: Option<&CodeFile>| Neighbour {
        path: path.to_owned(),
        relation,
        purpose: file.and_then(|file| file.purpose.clone()),
        defines: match file {
            Some(file) if file.purpose.is_none() => file
                .main_symbols(5)
                .into_iter()
                .map(|symbol| symbol.name.clone())
                .collect(),
            _ => Vec::new(),
        },
    };
    let entry = |path: &String| imported.iter().find(|file| file.path == *path);
    let mut out: Vec<Neighbour> = imports
        .iter()
        .take(3)
        .map(|path| describe(path, Relation::Imports, entry(path)))
        .collect();
    for file in importers {
        if out.len() >= MAX_NEIGHBOURS {
            break;
        }
        if !out.iter().any(|neighbour| neighbour.path == file.path) {
            out.push(describe(&file.path, Relation::ImportedBy, Some(file)));
        }
    }
    for path in imports.iter().skip(3) {
        if out.len() >= MAX_NEIGHBOURS {
            break;
        }
        if !out.iter().any(|neighbour| neighbour.path == *path) {
            out.push(describe(path, Relation::Imports, entry(path)));
        }
    }
    out
}

/// The domain `folder` places local models in, or why it places them nowhere.
fn local_domain(vaults: &Arc<Vaults>, folder: &Path) -> Result<String, String> {
    match Session::for_folder(Some(vaults), Some(Provider::Local.as_str()), Some(folder)) {
        Session::Placed(placement) => Ok(placement.default_domain().to_owned()),
        Session::Refused(reason) => Err(reason),
        Session::Open => Err("no vaults file is in use".to_owned()),
    }
}

impl App {
    /// Where the map of the checkout enclosing `path` lives: the domain its
    /// folder places local models in, less any folders inside it that place
    /// them elsewhere. Without a vaults file, the default domain.
    pub fn code_place(&self, path: &Path) -> Result<CodePlace> {
        let repo = Repository::discover(path)?;
        let Some(vaults) = &self.config.vaults else {
            return Ok(CodePlace {
                repo,
                domain: self.config.default_domain.clone(),
                excluded: Vec::new(),
            });
        };
        let domain = local_domain(vaults, repo.root()).map_err(|reason| {
            UserError::Refused(format!(
                "Kioku keeps no code map for {}, because local models can't be placed there: {reason}",
                repo.root().display()
            ))
        })?;
        let excluded = vaults
            .folders_within(repo.root())
            .into_iter()
            .filter(|folder| {
                local_domain(vaults, &repo.root().join(folder))
                    .ok()
                    .as_deref()
                    != Some(domain.as_str())
            })
            .collect();
        Ok(CodePlace {
            repo,
            domain,
            excluded,
        })
    }

    /// Whether models from `provider` may read `domain`, where the folder
    /// `root` is placed: its vault allows the provider and no lock keeps it out.
    fn provider_reads(&self, root: &Path, domain: &str, provider: Provider) -> bool {
        let Some(vaults) = &self.config.vaults else {
            return true;
        };
        let session = Session::for_folder(Some(vaults), Some(provider.as_str()), Some(root));
        Viewer::new(&self.config.principal, &session)
            .sees_domain(domain)
            .unwrap_or(false)
    }

    /// Update the map of the checkout enclosing `folder` (see [`update_repo`]).
    /// The summarizer runs only if its provider may read the checkout's
    /// domain. Maps this checkout left in another domain, as when its area
    /// changed, and maps of the same repository whose folder is gone, are dropped.
    pub async fn codemap_update(
        &self,
        folder: &Path,
        mut options: UpdateOptions,
    ) -> Result<UpdateReport> {
        let place = self.code_place(folder)?;
        let mut notes = Vec::new();
        if let Some(summarizer) = &options.summarizer
            && !self.provider_reads(place.repo.root(), &place.domain, summarizer.provider)
        {
            notes.push(format!(
                "no purposes were written: models from provider {} may not read domain {}",
                summarizer.provider, place.domain
            ));
            options.summarizer = None;
        }
        let root = place.repo.root().display().to_string();
        for (domain, other) in self.store.code_maps_named(&place.repo.name()).await? {
            let moved = other == root && domain != place.domain;
            let gone = other != root && domain == place.domain && !Path::new(&other).exists();
            if moved || gone {
                let files = self.store.drop_code_map(&domain, &other).await?;
                let why = if moved {
                    "its area changed"
                } else {
                    "its folder is gone"
                };
                notes.push(format!(
                    "dropped the map of {files} files at {other} in domain {domain}: {why}"
                ));
            }
        }
        let mut report = update_repo(&self.store, place, &options).await?;
        notes.append(&mut report.notes);
        report.notes = notes;
        Ok(report)
    }

    /// The map entry of a file of a checkout (see [`lookup_file`]).
    pub async fn codemap_lookup(&self, place: CodePlace, path: &str) -> Result<FileMap> {
        lookup_file(&self.store, place, path).await
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use super::*;
    use crate::testing::ScratchDatabase;

    fn entry(path: &str, purpose: Option<&str>, symbols: &[&str]) -> CodeFile {
        CodeFile {
            path: path.to_owned(),
            language: Language::Rust,
            digest: codemap::digest(path),
            purpose: purpose.map(str::to_owned),
            purpose_source: purpose.map(|_| PurposeSource::Doc),
            symbols: symbols
                .iter()
                .enumerate()
                .map(|(index, name)| Symbol {
                    name: (*name).to_owned(),
                    kind: "fn".to_owned(),
                    line: u32::try_from(index + 1).unwrap(),
                    signature: format!("pub fn {name}()"),
                    public: true,
                })
                .collect(),
            imports: Vec::new(),
        }
    }

    #[test]
    fn neighbours_take_some_imports_then_importers() {
        let imports: Vec<String> = ["a.rs", "b.rs", "c.rs", "d.rs"].map(str::to_owned).to_vec();
        let imported = [
            entry("a.rs", Some("Does A."), &[]),
            entry("b.rs", None, &["one", "two"]),
        ];
        let importers = [
            entry("a.rs", Some("Does A."), &[]),
            entry("x.rs", Some("Uses it."), &[]),
            entry("d.rs", None, &[]),
        ];
        let out = neighbours(&imports, &imported, &importers);
        let shape: Vec<(&str, Relation)> =
            out.iter().map(|n| (n.path.as_str(), n.relation)).collect();
        // d.rs both imports and is imported: listed once.
        assert_eq!(
            shape,
            vec![
                ("a.rs", Relation::Imports),
                ("b.rs", Relation::Imports),
                ("c.rs", Relation::Imports),
                ("x.rs", Relation::ImportedBy),
                ("d.rs", Relation::ImportedBy),
            ]
        );
        assert_eq!(out[0].purpose.as_deref(), Some("Does A."));
        assert_eq!(out[1].defines, vec!["one", "two"]);
        assert!(out[2].purpose.is_none() && out[2].defines.is_empty());
        let many: Vec<String> = (0..9).map(|i| format!("m{i}.rs")).collect();
        assert_eq!(neighbours(&many, &[], &importers).len(), MAX_NEIGHBOURS);
    }

    #[test]
    fn excluded_folders_are_not_covered() {
        let excluded = vec!["services/billing".to_owned()];
        assert!(!covers(&excluded, "services/billing"));
        assert!(!covers(&excluded, "services/billing/api.py"));
        assert!(covers(&excluded, "services/billing-old/api.py"));
        assert!(covers(&excluded, "app/main.py"));
        assert!(covers(&[], "anything.rs"));
    }

    fn git(dir: &Path, args: &[&str]) -> Result<()> {
        let status = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=Test", "-c", "user.email=test@example.com"])
            .args([
                "-c",
                "commit.gpgsign=false",
                "-c",
                "init.defaultBranch=main",
            ])
            .args(args)
            .output()?;
        anyhow::ensure!(status.status.success(), "git {args:?} failed");
        Ok(())
    }

    fn write(dir: &Path, path: &str, text: &str) -> Result<()> {
        let file = dir.join(path);
        std::fs::create_dir_all(file.parent().unwrap())?;
        std::fs::write(file, text)?;
        Ok(())
    }

    fn place(root: &Path) -> Result<CodePlace> {
        Ok(CodePlace {
            repo: Repository::discover(root)?,
            domain: "test".to_owned(),
            excluded: Vec::new(),
        })
    }

    /// Creates and drops its own database on the server in MEMORY_TEST_DATABASE_URL.
    #[tokio::test]
    #[ignore = "requires PostgreSQL; set MEMORY_TEST_DATABASE_URL"]
    async fn postgres_code_map_follows_commits() -> Result<()> {
        let scratch = ScratchDatabase::create().await?;
        let store = Store::connect(&scratch.url).await?;
        store.migrate().await?;
        let dir =
            std::env::temp_dir().join(format!("kioku-codemap-{}", uuid::Uuid::new_v4().simple()));
        let outcome = code_map_checks(&store, &dir).await;
        let _ = std::fs::remove_dir_all(&dir);
        scratch.drop_database().await?;
        outcome
    }

    async fn code_map_checks(store: &Store, dir: &Path) -> Result<()> {
        let root = dir.join("one").join("repo");
        write(&root, "pkg/__init__.py", "")?;
        write(
            &root,
            "pkg/store.py",
            "\"\"\"Keeps the records.\"\"\"\ndef save():\n    pass\n",
        )?;
        write(
            &root,
            "pkg/api.py",
            "from .store import save\n\ndef handle():\n    save()\n",
        )?;
        write(&root, "README.md", "# Not code\n")?;
        git(&root, &["init", "-q"])?;
        git(&root, &["add", "."])?;
        git(&root, &["commit", "-q", "-m", "first"])?;
        // A stand-in summarizer that names each file it is asked about.
        write(
            dir,
            "summarize.py",
            "import json, sys\nrequest = json.load(sys.stdin)\nprint(json.dumps({\"purposes\": [{\"path\": f[\"path\"], \"purpose\": \"Handles \" + f[\"path\"] + \".\"} for f in request[\"files\"]]}))\n",
        )?;
        let summarizer = Summarizer {
            program: PathBuf::from("python3"),
            args: vec![dir.join("summarize.py").display().to_string()],
            provider: Provider::Local,
        };
        let summaries = |limit: usize| UpdateOptions {
            full: false,
            summarizer: Some(summarizer.clone()),
            summary_limit: limit,
        };
        let plain = UpdateOptions {
            full: false,
            summarizer: None,
            summary_limit: 10,
        };

        let report = update_repo(store, place(&root)?, &summaries(10)).await?;
        assert_eq!(
            (report.files, report.parsed, report.updated, report.removed),
            (3, 3, 3, 0)
        );
        assert_eq!(
            (
                report.purposes.doc,
                report.purposes.model,
                report.summarized
            ),
            (1, 2, 2)
        );
        assert_eq!(report.repo, "repo");

        let api = lookup_file(store, place(&root)?, "pkg/api.py").await?;
        assert_eq!(api.purpose.as_deref(), Some("Handles pkg/api.py."));
        assert_eq!(api.purpose_source, Some(PurposeSource::Model));
        assert!(!api.reparsed);
        assert_eq!(api.neighbours.len(), 1);
        assert_eq!(api.neighbours[0].path, "pkg/store.py");
        assert_eq!(api.neighbours[0].relation, Relation::Imports);
        assert_eq!(
            api.neighbours[0].purpose.as_deref(),
            Some("Keeps the records.")
        );
        let records = lookup_file(store, place(&root)?, "pkg/store.py").await?;
        assert_eq!(records.neighbours[0].path, "pkg/api.py");
        assert_eq!(records.neighbours[0].relation, Relation::ImportedBy);

        // A commit that changes one file and deletes another: every file is
        // parsed again, and only what changed is written.
        write(
            &root,
            "pkg/store.py",
            "\"\"\"Keeps the records and their history.\"\"\"\ndef save():\n    pass\n\ndef history():\n    pass\n",
        )?;
        git(&root, &["rm", "-q", "pkg/__init__.py"])?;
        git(&root, &["commit", "-q", "-am", "second"])?;
        let report = update_repo(store, place(&root)?, &plain).await?;
        assert_eq!(
            (report.files, report.parsed, report.updated, report.removed),
            (2, 2, 1, 1)
        );
        let records = lookup_file(store, place(&root)?, "pkg/store.py").await?;
        assert_eq!(
            records.purpose.as_deref(),
            Some("Keeps the records and their history.")
        );
        assert!(
            records
                .symbols
                .iter()
                .any(|symbol| symbol.name == "history")
        );

        // An edit not yet committed is parsed on lookup; the model's purpose stays.
        write(
            &root,
            "pkg/api.py",
            "from .store import save, history\n\ndef handle():\n    save()\n\ndef audit():\n    history()\n",
        )?;
        let api = lookup_file(store, place(&root)?, "pkg/api.py").await?;
        assert!(api.reparsed);
        assert_eq!(api.purpose.as_deref(), Some("Handles pkg/api.py."));
        assert!(api.symbols.iter().any(|symbol| symbol.name == "audit"));
        assert!(
            !lookup_file(store, place(&root)?, "pkg/api.py")
                .await?
                .reparsed
        );

        // Committing what the lookup already saw writes nothing.
        git(&root, &["commit", "-q", "-am", "third"])?;
        let report = update_repo(store, place(&root)?, &plain).await?;
        assert_eq!((report.parsed, report.updated), (1, 0));

        // A rename leaves api.py untouched, but its import no longer resolves:
        // the stale neighbour goes. Renaming back brings it back.
        git(&root, &["mv", "pkg/store.py", "pkg/records.py"])?;
        git(&root, &["commit", "-q", "-m", "rename"])?;
        update_repo(store, place(&root)?, &plain).await?;
        assert!(
            lookup_file(store, place(&root)?, "pkg/api.py")
                .await?
                .neighbours
                .is_empty()
        );
        git(&root, &["mv", "pkg/records.py", "pkg/store.py"])?;
        git(&root, &["commit", "-q", "-m", "rename back"])?;
        update_repo(store, place(&root)?, &plain).await?;
        let api = lookup_file(store, place(&root)?, "pkg/api.py").await?;
        assert_eq!(api.neighbours.len(), 1);
        assert_eq!(api.neighbours[0].path, "pkg/store.py");

        // A second checkout with the same folder name keeps its own map.
        let other = dir.join("two").join("repo");
        write(&other, "solo.py", "\"\"\"Stands alone.\"\"\"\n")?;
        git(&other, &["init", "-q"])?;
        git(&other, &["add", "."])?;
        git(&other, &["commit", "-q", "-m", "first"])?;
        let report = update_repo(store, place(&other)?, &plain).await?;
        assert_eq!((report.repo.as_str(), report.files), ("repo", 1));
        assert_eq!(update_repo(store, place(&root)?, &plain).await?.files, 2);

        // A file that looks like it holds a credential is never summarized,
        // and doesn't use up the limit: the next file gets the purpose.
        let token = format!("{}{}", "ghp_", "a".repeat(36));
        write(
            &root,
            "pkg/a_settings.py",
            &format!("TOKEN = \"{token}\"\n"),
        )?;
        write(&root, "pkg/b_tools.py", "def tool():\n    pass\n")?;
        git(&root, &["add", "."])?;
        git(&root, &["commit", "-q", "-m", "more"])?;
        let report = update_repo(store, place(&root)?, &summaries(1)).await?;
        assert_eq!(report.summarized, 1);
        let tools = lookup_file(store, place(&root)?, "pkg/b_tools.py").await?;
        assert_eq!(tools.purpose.as_deref(), Some("Handles pkg/b_tools.py."));
        let settings = lookup_file(store, place(&root)?, "pkg/a_settings.py").await?;
        assert_eq!(settings.purpose, None);

        // A folder other rules place elsewhere stays out of the map.
        write(&root, "area/inner.py", "\"\"\"Another area's code.\"\"\"\n")?;
        git(&root, &["add", "."])?;
        git(&root, &["commit", "-q", "-m", "area"])?;
        let fenced = || -> Result<CodePlace> {
            Ok(CodePlace {
                excluded: vec!["area".to_owned()],
                ..place(&root)?
            })
        };
        let report = update_repo(store, fenced()?, &plain).await?;
        assert!(
            store
                .code_map_files(&report.domain, &report.root)
                .await?
                .iter()
                .all(|file| !file.path.starts_with("area/"))
        );
        assert!(
            lookup_file(store, fenced()?, "area/inner.py")
                .await
                .is_err()
        );

        // A save that started from an older commit is refused.
        let refused = store
            .save_code_map(&CodeMapChange {
                domain: "test",
                root: &report.root,
                name: &report.repo,
                started_from: Some(Some("0000000")),
                commit: "1111111",
                upserts: &[],
                removed: &[],
            })
            .await?;
        assert!(!refused);
        assert!(
            lookup_file(store, place(&root)?, "README.md")
                .await
                .is_err()
        );
        Ok(())
    }
}

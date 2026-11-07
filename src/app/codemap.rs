//! Building and reading the code map ([`crate::codemap`]). [`update_repo`] and
//! [`lookup_file`] take the store and the domain a repository is placed in,
//! so they run without the rest of the application; [`App`] places the
//! repository by its folder and checks which provider may read it.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;

use anyhow::Result;
use serde::Serialize;

use super::{App, is_zero};
use crate::codemap::{
    self, Change, CodeFile, FileSet, Language, MAX_FILE_BYTES, MAX_NEIGHBOURS, MAX_SHOWN_SYMBOLS,
    PurposeSource, Repository, Source, Summarizer, Symbol,
};
use crate::error::UserError;
use crate::store::{CodeMapChange, Store};
use crate::vault::{Provider, Session, Viewer};

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
    pub repo: String,
    pub domain: String,
    pub commit: String,
    /// Source files in the map after the update.
    pub files: usize,
    /// Files parsed by this update.
    pub parsed: usize,
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

/// What an update read from git, off the async runtime.
struct Scan {
    head: String,
    files: FileSet,
    /// Files to parse, with their text at HEAD.
    texts: Vec<(String, Language, String)>,
    /// Unchanged files with no purpose, to summarize.
    backfill: Vec<(String, Language, String)>,
    /// Source files that are too large or not text.
    unreadable: Vec<String>,
}

fn scan_repo(
    repo: &Repository,
    base: Option<&str>,
    full: bool,
    known: &HashSet<String>,
    backfill: &[String],
) -> Result<Scan> {
    let head = repo.head()?.ok_or_else(|| {
        UserError::InvalidArgument(format!("{} has no commits yet", repo.root().display()))
    })?;
    let files = FileSet::new(repo.files_at(&head)?);
    let mut wanted: BTreeSet<String> = match base.filter(|commit| !full && repo.has_commit(commit))
    {
        Some(commit) => repo
            .changes(commit, &head)?
            .into_iter()
            .filter_map(|change| match change {
                Change::Changed(path) => Some(path),
                Change::Deleted(_) => None,
            })
            .filter(|path| files.contains(path))
            .collect(),
        None => files.paths().map(str::to_owned).collect(),
    };
    // Files the map lacks (a failed or older update) are parsed as well.
    wanted.extend(
        files
            .paths()
            .filter(|path| !known.contains(*path))
            .map(str::to_owned),
    );
    let wanted: Vec<String> = wanted.into_iter().collect();
    let backfill: Vec<String> = backfill
        .iter()
        .filter(|path| files.contains(path) && !wanted.contains(path))
        .cloned()
        .collect();
    let read = |paths: Vec<String>,
                unreadable: &mut Vec<String>|
     -> Result<Vec<(String, Language, String)>> {
        let contents = repo.contents(&head, &paths)?;
        let mut out = Vec::new();
        for (path, content) in paths.into_iter().zip(contents) {
            let (Some(language), Some(text)) = (
                Language::for_path(&path),
                content.and_then(|bytes| String::from_utf8(bytes).ok()),
            ) else {
                unreadable.push(path);
                continue;
            };
            out.push((path, language, text));
        }
        Ok(out)
    };
    let mut unreadable = Vec::new();
    let texts = read(wanted, &mut unreadable)?;
    let backfill = read(backfill, &mut unreadable)?;
    Ok(Scan {
        head,
        files,
        texts,
        backfill,
        unreadable,
    })
}

/// Bring `domain`'s map of `repo` up to HEAD: parse the files that changed
/// since the last update (every file the first time, or with `full`), drop
/// the files HEAD no longer has, and ask the summarizer for the purposes
/// that are missing.
pub async fn update_repo(
    store: &Store,
    repo: Repository,
    domain: &str,
    options: &UpdateOptions,
) -> Result<UpdateReport> {
    let name = repo.name();
    let root = repo.root().display().to_string();
    let started_from = store.code_repo_commit(domain, &name).await?;
    let existing: HashMap<String, CodeFile> = store
        .code_files(domain, &name)
        .await?
        .into_iter()
        .map(|file| (file.path.clone(), file))
        .collect();
    let known: HashSet<String> = existing.keys().cloned().collect();
    let mut backfill: Vec<String> = match options.summarizer {
        Some(_) => existing
            .values()
            .filter(|file| file.purpose.is_none())
            .map(|file| file.path.clone())
            .collect(),
        None => Vec::new(),
    };
    backfill.sort();
    backfill.truncate(options.summary_limit);
    let base = started_from.clone().flatten();
    let full = options.full;
    let scan = tokio::task::spawn_blocking(move || {
        scan_repo(&repo, base.as_deref(), full, &known, &backfill)
    })
    .await??;

    let mut upserts: Vec<CodeFile> = Vec::new();
    let mut texts: HashMap<String, (Language, String)> = HashMap::new();
    for (path, language, text) in scan.texts {
        let previous = existing.get(&path);
        if !full && previous.is_some_and(|old| old.digest == codemap::digest(&text)) {
            continue;
        }
        upserts.push(CodeFile::build(
            &path,
            language,
            &text,
            &scan.files,
            previous,
        ));
        texts.insert(path, (language, text));
    }
    let parsed = upserts.len();
    let removed: Vec<String> = existing
        .keys()
        .filter(|path| !scan.files.contains(path) || scan.unreadable.contains(path))
        .cloned()
        .collect();

    let mut notes = Vec::new();
    let mut summarized = 0;
    if let Some(summarizer) = &options.summarizer {
        // Changed files without a doc comment first, then old files without
        // any purpose; never a file that looks like it holds a credential.
        let mut sources: Vec<Source> = upserts
            .iter()
            .filter(|file| file.purpose_source != Some(PurposeSource::Doc))
            .filter_map(|file| {
                let (language, text) = texts.get(&file.path)?;
                Some(Source {
                    path: file.path.clone(),
                    language: *language,
                    text: text.clone(),
                })
            })
            .chain(
                scan.backfill
                    .into_iter()
                    .map(|(path, language, text)| Source {
                        path,
                        language,
                        text,
                    }),
            )
            .filter(|source| crate::secrets::find_in_text(&source.text).is_none())
            .collect();
        sources.truncate(options.summary_limit);
        if !sources.is_empty() {
            let summarizer = summarizer.clone();
            let repo_name = name.clone();
            let (purposes, errors) =
                tokio::task::spawn_blocking(move || summarizer.summarize(&repo_name, &sources))
                    .await?;
            notes.extend(
                errors
                    .into_iter()
                    .map(|error| format!("summarizer: {error}")),
            );
            summarized = purposes.len();
            for (path, purpose) in purposes {
                let index = match upserts.iter().position(|file| file.path == path) {
                    Some(index) => index,
                    None => match existing.get(&path) {
                        Some(old) => {
                            upserts.push(old.clone());
                            upserts.len() - 1
                        }
                        None => continue,
                    },
                };
                upserts[index].purpose = Some(purpose);
                upserts[index].purpose_source = Some(PurposeSource::Model);
            }
        }
    }

    let change = CodeMapChange {
        domain,
        repo: &name,
        root: &root,
        started_from: started_from.as_ref().map(|commit| commit.as_deref()),
        commit: &scan.head,
        upserts: &upserts,
        removed: &removed,
    };
    if !store.save_code_map(&change).await? {
        notes.push(
            "another update saved this repository's map first, so this one saved nothing"
                .to_owned(),
        );
        return Ok(UpdateReport {
            repo: name,
            domain: domain.to_owned(),
            commit: scan.head,
            files: existing.len(),
            parsed: 0,
            removed: 0,
            summarized: 0,
            purposes: count_purposes(existing.values()),
            notes,
        });
    }
    let mut map: HashMap<&str, &CodeFile> = existing
        .iter()
        .filter(|(path, _)| !removed.contains(path))
        .map(|(path, file)| (path.as_str(), file))
        .collect();
    map.extend(upserts.iter().map(|file| (file.path.as_str(), file)));
    Ok(UpdateReport {
        repo: name,
        domain: domain.to_owned(),
        commit: scan.head,
        files: map.len(),
        parsed,
        removed: removed.len(),
        summarized,
        purposes: count_purposes(map.values().copied()),
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

/// `path`'s entry in `domain`'s map of `repo`, with its neighbours. A file
/// whose content changed since the map described it, or that the map lacks,
/// is parsed from the working tree first and saved; a model-written purpose
/// survives until the next update.
pub async fn lookup_file(
    store: &Store,
    repo: Repository,
    domain: &str,
    path: &str,
) -> Result<FileMap> {
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
    let name = repo.name();
    let root = repo.root().display().to_string();
    let stored = store
        .code_files_at(domain, &name, &[path.to_owned()])
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
                let files = FileSet::new(repo.tracked()?);
                Ok(CodeFile::build(
                    &owned,
                    language,
                    &text,
                    &files,
                    previous.as_ref(),
                ))
            })
            .await??;
            store.save_code_file(domain, &name, &root, &file).await?;
            (file, true)
        }
    };
    let imported = store.code_files_at(domain, &name, &file.imports).await?;
    let importers = store
        .code_importers(domain, &name, path, i64::try_from(MAX_NEIGHBOURS)?)
        .await?;
    let neighbours = neighbours(&file.imports, &imported, &importers);
    let shown: Vec<Symbol> = file
        .main_symbols(MAX_SHOWN_SYMBOLS)
        .into_iter()
        .cloned()
        .collect();
    Ok(FileMap {
        repo: name,
        domain: domain.to_owned(),
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
        out.push(describe(path, Relation::Imports, entry(path)));
    }
    out
}

impl App {
    /// The repository enclosing `path`, and the domain its map lives in: the
    /// area, else the vault default, that its folder places local models
    /// in. Without a vaults file, the default domain.
    pub fn code_place(&self, path: &Path) -> Result<(Repository, String)> {
        let repo = Repository::discover(path)?;
        let Some(vaults) = &self.config.vaults else {
            return Ok((repo, self.config.default_domain.clone()));
        };
        match Session::for_folder(Some(vaults), Some(Provider::Local.as_str()), Some(repo.root())) {
            Session::Placed(placement) => {
                let domain = placement.default_domain().to_owned();
                Ok((repo, domain))
            }
            Session::Refused(reason) => Err(UserError::Refused(format!(
                "Kioku keeps no code map for {}, because local models can't be placed there: {reason}",
                repo.root().display()
            ))
            .into()),
            Session::Open => Ok((repo, self.config.default_domain.clone())),
        }
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

    /// Update the map of the repository enclosing `folder` (see [`update_repo`]).
    /// The summarizer runs only if its provider may read the repository's
    /// domain. A map the same folder left in another domain, as when its
    /// area changed, is dropped.
    pub async fn codemap_update(
        &self,
        folder: &Path,
        mut options: UpdateOptions,
    ) -> Result<UpdateReport> {
        let (repo, domain) = self.code_place(folder)?;
        let mut notes = Vec::new();
        if let Some(summarizer) = &options.summarizer
            && !self.provider_reads(repo.root(), &domain, summarizer.provider)
        {
            notes.push(format!(
                "no purposes were written: models from provider {} may not read domain {domain}",
                summarizer.provider
            ));
            options.summarizer = None;
        }
        let name = repo.name();
        let root = repo.root().display().to_string();
        for (other, other_root) in self.store.code_repo_roots(&name).await? {
            if other != domain && other_root == root {
                let files = self.store.drop_code_repo(&other, &name).await?;
                notes.push(format!(
                    "dropped the map of {files} files this folder had in domain {other}"
                ));
            }
        }
        let mut report = update_repo(&self.store, repo, &domain, &options).await?;
        notes.append(&mut report.notes);
        report.notes = notes;
        Ok(report)
    }

    /// The map entry of a file in `domain`'s map of `repo` (see [`lookup_file`]).
    pub async fn codemap_lookup(
        &self,
        repo: Repository,
        domain: &str,
        path: &str,
    ) -> Result<FileMap> {
        lookup_file(&self.store, repo, domain, path).await
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
        ];
        let out = neighbours(&imports, &imported, &importers);
        let shape: Vec<(&str, Relation)> =
            out.iter().map(|n| (n.path.as_str(), n.relation)).collect();
        assert_eq!(
            shape,
            vec![
                ("a.rs", Relation::Imports),
                ("b.rs", Relation::Imports),
                ("c.rs", Relation::Imports),
                ("x.rs", Relation::ImportedBy),
                ("d.rs", Relation::Imports),
            ]
        );
        assert_eq!(out[0].purpose.as_deref(), Some("Does A."));
        assert_eq!(out[1].defines, vec!["one", "two"]);
        assert!(out[2].purpose.is_none() && out[2].defines.is_empty());
        let many: Vec<String> = (0..9).map(|i| format!("m{i}.rs")).collect();
        assert_eq!(neighbours(&many, &[], &importers).len(), MAX_NEIGHBOURS);
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
        let root = dir.join("repo");
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
        let with_summaries = UpdateOptions {
            full: false,
            summarizer: Some(summarizer),
            summary_limit: 10,
        };
        let plain = UpdateOptions {
            full: false,
            summarizer: None,
            summary_limit: 10,
        };
        let discover = || Repository::discover(&root);

        let report = update_repo(store, discover()?, "test", &with_summaries).await?;
        assert_eq!((report.files, report.parsed, report.removed), (3, 3, 0));
        assert_eq!(
            (
                report.purposes.doc,
                report.purposes.model,
                report.summarized
            ),
            (1, 2, 2)
        );

        let api = lookup_file(store, discover()?, "test", "pkg/api.py").await?;
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
        let records = lookup_file(store, discover()?, "test", "pkg/store.py").await?;
        assert_eq!(records.neighbours[0].path, "pkg/api.py");
        assert_eq!(records.neighbours[0].relation, Relation::ImportedBy);

        // A commit that changes one file and deletes another.
        write(
            &root,
            "pkg/store.py",
            "\"\"\"Keeps the records and their history.\"\"\"\ndef save():\n    pass\n\ndef history():\n    pass\n",
        )?;
        git(&root, &["rm", "-q", "pkg/__init__.py"])?;
        git(&root, &["commit", "-q", "-am", "second"])?;
        let report = update_repo(store, discover()?, "test", &plain).await?;
        assert_eq!((report.files, report.parsed, report.removed), (2, 1, 1));
        let records = lookup_file(store, discover()?, "test", "pkg/store.py").await?;
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
        let api = lookup_file(store, discover()?, "test", "pkg/api.py").await?;
        assert!(api.reparsed);
        assert_eq!(api.purpose.as_deref(), Some("Handles pkg/api.py."));
        assert!(api.symbols.iter().any(|symbol| symbol.name == "audit"));
        let again = lookup_file(store, discover()?, "test", "pkg/api.py").await?;
        assert!(!again.reparsed);

        // Nothing new to parse, and a save that started from an older commit is refused.
        git(&root, &["commit", "-q", "-am", "third"])?;
        let report = update_repo(store, discover()?, "test", &plain).await?;
        assert_eq!(report.parsed, 0);
        let refused = store
            .save_code_map(&CodeMapChange {
                domain: "test",
                repo: &report.repo,
                root: "/elsewhere",
                started_from: Some(Some("0000000")),
                commit: "1111111",
                upserts: &[],
                removed: &[],
            })
            .await?;
        assert!(!refused);
        assert!(
            lookup_file(store, discover()?, "test", "README.md")
                .await
                .is_err()
        );
        Ok(())
    }
}

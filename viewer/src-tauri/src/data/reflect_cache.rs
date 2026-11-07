//! Past Reflect runs from `~/.cache/kioku-reflect/<domain, / as ->.json`,
//! which the reflect skill writes. Two layouts are read: `{"runs": [...]}`
//! with full runs, or the skill's `{"topics": {name: {"at": date}}}` record,
//! where each date becomes one run without findings.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Deserialize;

use crate::commands::reflect::ReflectRun;
use crate::error::CommandResult;

/// The harness the reflect skill runs in.
pub const SKILL_HARNESS: &str = "claude-code";

#[derive(Deserialize)]
struct CacheFile {
    #[serde(default)]
    runs: Vec<ReflectRun>,
    #[serde(default)]
    topics: BTreeMap<String, TopicMark>,
}

#[derive(Deserialize)]
struct TopicMark {
    #[serde(default)]
    at: Option<String>,
}

pub fn cache_dir(home: &Path) -> PathBuf {
    home.join(".cache").join("kioku-reflect")
}

/// The cache file's name for `domain`, or `None` when the skill's naming
/// cannot give it a safe file name (such a domain has no cache).
pub fn file_stem(domain: &str) -> Option<String> {
    let stem = domain.trim().replace('/', "-");
    let safe = !stem.is_empty()
        && !stem.starts_with('.')
        && stem
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'));
    safe.then_some(stem)
}

/// Runs in `text` for `domain`, newest first. `topics` marks carry no domain,
/// so they become runs only when `with_topics` says the file is this domain's
/// alone.
pub fn parse_runs(
    text: &str,
    domain: &str,
    stem: &str,
    with_topics: bool,
) -> Result<Vec<ReflectRun>> {
    let file: CacheFile = serde_json::from_str(text).context("the Reflect cache is not valid")?;
    let mut runs: Vec<ReflectRun> = file
        .runs
        .into_iter()
        .filter(|run| run.domain == domain)
        .collect();
    let dates: BTreeSet<String> = if with_topics {
        file.topics.into_values().filter_map(|t| t.at).collect()
    } else {
        BTreeSet::new()
    };
    for date in dates {
        let id = format!("{stem}-{date}");
        if runs.iter().all(|run| run.id != id) {
            runs.push(ReflectRun {
                id,
                domain: domain.to_owned(),
                started_at: date.clone(),
                finished_at: Some(date),
                harness: SKILL_HARNESS.to_owned(),
                findings: Vec::new(),
            });
        }
    }
    runs.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(runs)
}

/// A domain's cache file: its name and text.
pub struct Cache {
    pub stem: String,
    pub text: String,
}

/// The cache under `home` for `domain`; `None` when there is none.
pub fn read(home: &Path, domain: &str) -> CommandResult<Option<Cache>> {
    let Some(stem) = file_stem(domain) else {
        return Ok(None);
    };
    let path = cache_dir(home).join(format!("{stem}.json"));
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(Cache { stem, text })),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(anyhow::Error::new(error)
            .context(format!("cannot read {}", path.display()))
            .into()),
    }
}

impl Cache {
    /// Whether the file has `topics` marks, the only part whose owner depends
    /// on the other known domains. Callers skip the domain lookup otherwise.
    pub fn has_topic_marks(&self) -> bool {
        serde_json::from_str::<CacheFile>(&self.text).is_ok_and(|file| !file.topics.is_empty())
    }

    /// Runs for `domain`. `others` are the known domains: one that maps to
    /// the same file name (as `a/b` and `a-b` do) makes `topics` ambiguous.
    pub fn runs(&self, domain: &str, others: &[String]) -> CommandResult<Vec<ReflectRun>> {
        let shared = others.iter().any(|other| {
            other != domain && file_stem(other).as_deref() == Some(self.stem.as_str())
        });
        Ok(parse_runs(&self.text, domain, &self.stem, !shared)?)
    }
}

/// Runs for `domain` in the cache under `home`; none when there is no cache.
/// The command fetches `others` lazily; tests pass them directly.
#[cfg(test)]
pub fn list(home: &Path, domain: &str, others: &[String]) -> CommandResult<Vec<ReflectRun>> {
    match read(home, domain)? {
        Some(cache) => cache.runs(domain, others),
        None => Ok(Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stems_reject_paths() {
        assert_eq!(
            file_stem("personal/kioku").as_deref(),
            Some("personal-kioku")
        );
        assert!(file_stem("../x").is_none());
        assert!(file_stem("a\\b").is_none());
        assert!(file_stem("").is_none());
    }

    #[test]
    fn unnameable_domains_have_no_runs() -> CommandResult<()> {
        let home = Path::new("/nonexistent-kioku-viewer-home");
        assert!(list(home, "client work", &[])?.is_empty());
        assert!(list(home, "team:alpha", &[])?.is_empty());
        Ok(())
    }

    #[test]
    fn shared_files_keep_topic_marks_to_themselves() -> Result<()> {
        let text = r#"{"topics":{"search":{"at":"2026-11-04"}}}"#;
        assert!(parse_runs(text, "a-b", "a-b", false)?.is_empty());
        let dir = std::env::temp_dir().join(format!("kioku-viewer-reflect-{}", std::process::id()));
        std::fs::create_dir_all(cache_dir(&dir))?;
        std::fs::write(cache_dir(&dir).join("a-b.json"), text)?;
        let alone = list(&dir, "a-b", &["a-b".to_owned()]);
        let shared = list(&dir, "a-b", &["a/b".to_owned(), "a-b".to_owned()]);
        std::fs::remove_dir_all(&dir)?;
        assert_eq!(alone.map(|r| r.len()).ok(), Some(1));
        assert_eq!(shared.map(|r| r.len()).ok(), Some(0));
        Ok(())
    }

    #[test]
    fn topic_marks_become_one_run_per_date() -> Result<()> {
        let text = r#"{"topics":{"architecture":{"commit":"abc","at":"2026-11-01"},
            "storage":{"commit":"abc","at":"2026-11-01"},"search":{"at":"2026-11-04"}}}"#;
        let runs = parse_runs(text, "demo", "demo", true)?;
        let ids: Vec<&str> = runs.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["demo-2026-11-04", "demo-2026-11-01"]);
        assert!(runs[0].findings.is_empty());
        Ok(())
    }

    #[test]
    fn full_runs_are_read_and_filtered() -> Result<()> {
        let text = r#"{"runs":[{"id":"r1","domain":"demo","startedAt":"2026-11-02T09:00:00Z",
            "finishedAt":null,"harness":"claude-code","findings":[{"id":"f1","state":"confirmed",
            "text":"Two notes disagree","noteKeys":["a","b"]}]},
            {"id":"r2","domain":"local","startedAt":"2026-11-03","finishedAt":null,
            "harness":"claude-code","findings":[]}]}"#;
        let runs = parse_runs(text, "demo", "demo", true)?;
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].findings[0].note_keys, ["a", "b"]);
        Ok(())
    }

    #[test]
    fn only_topic_marks_need_the_domain_list() {
        let cache = |text: &str| Cache {
            stem: "demo".to_owned(),
            text: text.to_owned(),
        };
        assert!(cache(r#"{"topics":{"search":{"at":"2026-11-04"}}}"#).has_topic_marks());
        assert!(!cache(r#"{"runs":[]}"#).has_topic_marks());
        assert!(!cache(r#"{"topics":{}}"#).has_topic_marks());
        assert!(!cache("not json").has_topic_marks());
    }

    #[test]
    fn a_missing_cache_has_no_runs() -> CommandResult<()> {
        let runs = list(Path::new("/nonexistent-kioku-viewer-home"), "demo", &[])?;
        assert!(runs.is_empty());
        Ok(())
    }
}

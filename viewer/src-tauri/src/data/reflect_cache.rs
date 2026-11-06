//! Past Reflect runs from `~/.cache/kioku-reflect/<domain, / as ->.json`,
//! which the reflect skill writes. Two layouts are read: `{"runs": [...]}`
//! with full runs, or the skill's `{"topics": {name: {"at": date}}}` record,
//! where each date becomes one run without findings.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Deserialize;

use crate::commands::reflect::ReflectRun;
use crate::error::{CommandError, CommandResult};

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

/// The cache file's name for `domain`.
pub fn file_stem(domain: &str) -> CommandResult<String> {
    let stem = domain.trim().replace('/', "-");
    let safe = !stem.is_empty()
        && !stem.starts_with('.')
        && stem
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if safe {
        Ok(stem)
    } else {
        Err(CommandError::invalid_argument(format!(
            "{domain:?} is not an area name"
        )))
    }
}

/// Runs in `text` for `domain`, newest first.
pub fn parse_runs(text: &str, domain: &str, stem: &str) -> Result<Vec<ReflectRun>> {
    let file: CacheFile = serde_json::from_str(text).context("the Reflect cache is not valid")?;
    let mut runs: Vec<ReflectRun> = file
        .runs
        .into_iter()
        .filter(|run| run.domain == domain)
        .collect();
    let dates: BTreeSet<String> = file.topics.into_values().filter_map(|t| t.at).collect();
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

/// Runs for `domain` in the cache under `home`; none when there is no cache.
pub fn list(home: &Path, domain: &str) -> CommandResult<Vec<ReflectRun>> {
    let stem = file_stem(domain)?;
    let path = cache_dir(home).join(format!("{stem}.json"));
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(anyhow::Error::new(error)
                .context(format!("cannot read {}", path.display()))
                .into());
        }
    };
    Ok(parse_runs(&text, domain, &stem)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stems_reject_paths() {
        assert_eq!(
            file_stem("personal/kioku").ok().as_deref(),
            Some("personal-kioku")
        );
        assert!(file_stem("../x").is_err());
        assert!(file_stem("a\\b").is_err());
        assert!(file_stem("").is_err());
    }

    #[test]
    fn topic_marks_become_one_run_per_date() -> Result<()> {
        let text = r#"{"topics":{"architecture":{"commit":"abc","at":"2026-11-01"},
            "storage":{"commit":"abc","at":"2026-11-01"},"search":{"at":"2026-11-04"}}}"#;
        let runs = parse_runs(text, "demo", "demo")?;
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
        let runs = parse_runs(text, "demo", "demo")?;
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].findings[0].note_keys, ["a", "b"]);
        Ok(())
    }

    #[test]
    fn a_missing_cache_has_no_runs() -> CommandResult<()> {
        let runs = list(Path::new("/nonexistent-kioku-viewer-home"), "demo")?;
        assert!(runs.is_empty());
        Ok(())
    }
}

//! Vaults and visibility: `get_vaults_config`, `preview_visibility`,
//! `apply_visibility`, `list_access_requests`. `apply_visibility` writes the vaults file,
//! only after the person at the Mac confirms with Touch ID or the Mac password.

use std::future::Future;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::areas::read_vaults;
use crate::auth;
use crate::data::{env, vaults_file, vaults_write, visibility};
use crate::error::{CommandError, CommandResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultArea {
    pub domain: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultConfig {
    pub name: String,
    pub paths: Vec<String>,
    pub git_remotes: Vec<String>,
    pub domains: Vec<String>,
    pub providers: Vec<String>,
    pub areas: Vec<VaultArea>,
    /// Where new notes go when no area matches, such as "local".
    pub default_domain: Option<String>,
    pub apps: Vec<VaultApp>,
}

/// One app that may read a vault, with its one switch.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultApp {
    /// App id, such as "claude-code".
    pub id: String,
    pub name: String,
    /// Provider id written to the vault's providers list.
    pub provider: String,
    /// One line, such as "Anthropic models".
    pub description: String,
    pub can_read: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultsConfig {
    pub vaults: Vec<VaultConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisibilityChange {
    pub vault: String,
    pub app: String,
    pub can_read: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiffLineKind {
    Add,
    Remove,
    Context,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCheck {
    pub label: String,
    pub passed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisibilityPreview {
    pub summary: Vec<String>,
    pub diff: Vec<DiffLine>,
    pub checks: Vec<PreviewCheck>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessRequest {
    pub id: String,
    pub app: String,
    pub vault: String,
    pub reason: String,
    pub requested_at: String,
}

/// The vaults file, or an empty list when there is none.
#[tauri::command]
pub async fn get_vaults_config() -> CommandResult<VaultsConfig> {
    Ok(read_vaults()?
        .map(|parsed| parsed.to_config())
        .unwrap_or(VaultsConfig { vaults: Vec::new() }))
}

/// The change and its diff, built in memory and checked with kioku's parser.
#[tauri::command]
pub async fn preview_visibility(
    changes: Vec<VisibilityChange>,
) -> CommandResult<VisibilityPreview> {
    let file = vaults_file::VaultsFile::read()?;
    let text = file.text.ok_or_else(|| {
        CommandError::not_found(format!(
            "There is no vaults file at {}.",
            file.path.display()
        ))
    })?;
    // A hosted embedding service reads what its provider may read.
    let embedding_reader = env::load_config()
        .ok()
        .map(|config| config.embedding_reader)
        .filter(|reader| *reader != kioku::vault::Provider::Local);
    visibility::preview(&text, &file.path, &changes, embedding_reader)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedVisibility {
    /// Where the old file was backed up, home-relative; none when nothing changed.
    pub backup: Option<String>,
}

/// Writes the change, after the person at the Mac confirms it with Touch ID or the Mac
/// password. Nothing is written when the check is cancelled or the file changed meanwhile.
#[tauri::command]
pub async fn apply_visibility(changes: Vec<VisibilityChange>) -> CommandResult<AppliedVisibility> {
    if !auth::available() {
        return Err(CommandError::read_only());
    }
    let file = vaults_file::VaultsFile::read()?;
    apply_to(&file.path, &changes, auth::confirm).await
}

/// `apply_visibility` on the vaults file at `path`, with `confirm` asking the person (the
/// Touch ID prompt, or a stand-in in tests).
async fn apply_to<F, Fut>(
    path: &Path,
    changes: &[VisibilityChange],
    confirm: F,
) -> CommandResult<AppliedVisibility>
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = CommandResult<()>>,
{
    let planned = read_vaults_text(path)?;
    // The review's own text and checks: a change it would refuse never reaches the prompt.
    let next = visibility::apply_text(&planned, path, changes)?;
    if next == planned {
        return Ok(AppliedVisibility { backup: None });
    }
    confirm(reason(changes)).await?;
    // Write only over the text that was reviewed and confirmed.
    if read_vaults_text(path)? != planned {
        return Err(CommandError::conflict(
            "The vaults file changed while you confirmed, so nothing was written. Review the change again.",
        ));
    }
    let backup = vaults_write::write_backup(path, &planned)?;
    vaults_write::replace(path, &next)?;
    Ok(AppliedVisibility {
        backup: Some(home_relative(&backup)),
    })
}

fn read_vaults_text(path: &Path) -> CommandResult<String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(CommandError::not_found(
            format!("There is no vaults file at {}.", path.display()),
        )),
        Err(error) => Err(CommandError::unavailable(format!(
            "cannot read {}: {error}",
            path.display()
        ))),
    }
}

/// `~/…` for paths in the home folder, as the rest of the viewer shows them.
fn home_relative(path: &Path) -> String {
    match env::home().and_then(|home| path.strip_prefix(home).ok().map(Path::to_path_buf)) {
        Some(rest) => format!("~/{}", rest.display()),
        None => path.display().to_string(),
    }
}

/// Completes macOS's "Kioku is trying to …" the way the review's title asks its question.
fn reason(changes: &[VisibilityChange]) -> String {
    let mut vaults: Vec<&str> = Vec::new();
    for change in changes {
        if !vaults.contains(&change.vault.as_str()) {
            vaults.push(&change.vault);
        }
    }
    match changes {
        [only] => {
            let app = vaults_file::app(&only.app).map_or(only.app.as_str(), |spec| spec.name);
            if only.can_read {
                format!("let {app} read {}", only.vault)
            } else {
                format!("stop {app} reading {}", only.vault)
            }
        }
        _ if vaults.len() > NAMED_VAULTS => {
            format!("change who can read {} vaults", vaults.len())
        }
        _ => format!("change who can read {}", list_names(&vaults)),
    }
}

/// Vaults the prompt names one by one; past this, it counts them (the review does the same).
const NAMED_VAULTS: usize = 3;

/// "a", "a and b", "a, b and c".
fn list_names(names: &[&str]) -> String {
    match names {
        [] => String::new(),
        [only] => (*only).to_owned(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// Never writes: answering a request is read-only in this build.
#[tauri::command]
pub async fn respond_access_request(id: String, approve: bool) -> CommandResult<()> {
    let _ = (id, approve);
    Err(CommandError::read_only())
}

#[tauri::command]
pub async fn list_access_requests() -> CommandResult<Vec<AccessRequest>> {
    // Kioku has no request queue yet, so there is never one waiting.
    Ok(Vec::new())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::data::vaults_file::tests::SAMPLE;

    // Every write test runs `apply_to` on a scratch copy with a stand-in for the prompt: the
    // real command would read the live vaults file and ask for Touch ID.

    fn change(vault: &str, app: &str, can_read: bool) -> VisibilityChange {
        VisibilityChange {
            vault: vault.into(),
            app: app.into(),
            can_read,
        }
    }

    /// A folder holding a copy of the sample vaults file; the test removes it.
    fn scratch(name: &str) -> std::io::Result<(PathBuf, PathBuf)> {
        let folder = std::env::temp_dir().join(format!(
            "kioku-viewer-apply-{name}-{}-{}",
            std::process::id(),
            chrono::Local::now()
                .timestamp_nanos_opt()
                .unwrap_or_default()
        ));
        std::fs::create_dir_all(&folder)?;
        let file = folder.join("vaults.toml");
        std::fs::write(&file, SAMPLE)?;
        Ok((folder, file))
    }

    fn backups(folder: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(folder.join("backups"))
            .map(|entries| entries.filter_map(|e| e.ok().map(|e| e.path())).collect())
            .unwrap_or_default()
    }

    #[tokio::test]
    async fn writes_after_the_person_confirms_with_a_backup_first() -> anyhow::Result<()> {
        let (folder, file) = scratch("confirmed")?;
        let asked = Arc::new(Mutex::new(None::<String>));
        let seen = Arc::clone(&asked);
        let applied = apply_to(&file, &[change("personal", "codex", true)], move |reason| {
            if let Ok(mut slot) = seen.lock() {
                *slot = Some(reason);
            }
            async { Ok(()) }
        })
        .await?;
        let asked = asked.lock().map(|slot| slot.clone()).unwrap_or_default();
        assert_eq!(asked.as_deref(), Some("let Codex read personal"));
        let text = std::fs::read_to_string(&file)?;
        assert!(text.contains(r#"providers = ["anthropic", "local", "openai"]"#));
        let saved = backups(&folder);
        assert_eq!(saved.len(), 1);
        assert_eq!(std::fs::read_to_string(&saved[0])?, SAMPLE);
        assert!(applied.backup.is_some_and(|b| b.ends_with(".toml")));
        std::fs::remove_dir_all(folder)?;
        Ok(())
    }

    #[tokio::test]
    async fn a_cancelled_check_writes_nothing() -> anyhow::Result<()> {
        let (folder, file) = scratch("cancelled")?;
        let result = apply_to(&file, &[change("personal", "codex", true)], |_| async {
            Err(CommandError::cancelled())
        })
        .await;
        assert_eq!(result.err().map(|e| e.code), Some("cancelled".to_owned()));
        assert_eq!(std::fs::read_to_string(&file)?, SAMPLE);
        assert!(backups(&folder).is_empty());
        std::fs::remove_dir_all(folder)?;
        Ok(())
    }

    #[tokio::test]
    async fn a_file_changed_during_the_check_is_left_alone() -> anyhow::Result<()> {
        let (folder, file) = scratch("conflict")?;
        let edited = SAMPLE.replace("# Demo vaults", "# Edited while the prompt was open");
        let target = file.clone();
        let text = edited.clone();
        let result = apply_to(&file, &[change("personal", "codex", true)], move |_| {
            let written = std::fs::write(&target, &text);
            async move { written.map_err(|e| CommandError::unavailable(e.to_string())) }
        })
        .await;
        assert_eq!(result.err().map(|e| e.code), Some("conflict".to_owned()));
        assert_eq!(std::fs::read_to_string(&file)?, edited);
        assert!(backups(&folder).is_empty());
        std::fs::remove_dir_all(folder)?;
        Ok(())
    }

    #[tokio::test]
    async fn a_change_the_review_refuses_never_asks() -> anyhow::Result<()> {
        let (folder, file) = scratch("refused")?;
        let asked = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&asked);
        // work's only reader is Kilo on this Mac: turning it off leaves no app that can read it.
        let result = apply_to(&file, &[change("work", "kilo", false)], move |_| {
            flag.store(true, Ordering::SeqCst);
            async { Ok(()) }
        })
        .await;
        assert_eq!(
            result.err().map(|e| e.code),
            Some("invalid_argument".to_owned())
        );
        assert!(!asked.load(Ordering::SeqCst));
        assert_eq!(std::fs::read_to_string(&file)?, SAMPLE);
        std::fs::remove_dir_all(folder)?;
        Ok(())
    }

    #[test]
    fn the_prompt_asks_like_the_review_title() {
        assert_eq!(
            reason(&[change("personal", "codex", true)]),
            "let Codex read personal"
        );
        assert_eq!(
            reason(&[change("work", "kilo", false)]),
            "stop Kilo with local models reading work"
        );
        assert_eq!(
            reason(&[
                change("personal", "codex", true),
                change("work", "codex", true)
            ]),
            "change who can read personal and work"
        );
        let many: Vec<VisibilityChange> = (0..5)
            .map(|i| change(&format!("client-{i}"), "codex", true))
            .collect();
        assert_eq!(reason(&many), "change who can read 5 vaults");
    }

    #[tokio::test]
    async fn answering_requests_stays_read_only() {
        let err = respond_access_request("r1".into(), true).await.err();
        assert_eq!(err.map(|e| e.code), Some("read_only".to_owned()));
    }

    #[test]
    fn preview_writes_kebab_case_kinds() -> Result<(), serde_json::Error> {
        let line = DiffLine {
            kind: DiffLineKind::Remove,
            text: "x".into(),
        };
        assert_eq!(serde_json::to_value(line)?["kind"], "remove");
        Ok(())
    }
}

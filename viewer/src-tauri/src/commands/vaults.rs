//! Vaults and visibility: `get_vaults_config`, `preview_visibility`,
//! `apply_visibility`, `list_access_requests`. Read-only in this build.

use serde::{Deserialize, Serialize};

use super::areas::read_vaults;
use crate::data::{env, vaults_file, visibility};
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

/// Never writes: vault changes are read-only in this build.
#[tauri::command]
pub async fn apply_visibility(changes: Vec<VisibilityChange>) -> CommandResult<()> {
    let _ = changes;
    Err(CommandError::read_only())
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
    use super::*;

    #[tokio::test]
    async fn writes_stay_read_only() {
        let change = VisibilityChange {
            vault: "personal".into(),
            app: "codex".into(),
            can_read: true,
        };
        let err = apply_visibility(vec![change]).await.err();
        assert_eq!(err.map(|e| e.code), Some("read_only".to_owned()));
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

//! Reflect: `list_reflect_runs`, `get_reflect_settings`, `start_reflect`.

use serde::{Deserialize, Serialize};

use kioku::vault::Provider;

use super::areas::read_vaults;
use crate::data::{env, reflect_cache, vaults_file};
use crate::error::{CommandError, CommandResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FindingState {
    Confirmed,
    Unverified,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub id: String,
    pub state: FindingState,
    pub text: String,
    pub note_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflectRun {
    pub id: String,
    pub domain: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub harness: String,
    pub findings: Vec<Finding>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReflectMode {
    Manual,
    Automatic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HarnessStatus {
    Ready,
    NeedsSkill,
    NotConnected,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Harness {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub vaults_readable: Vec<String>,
    pub status: HarnessStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflectRoles {
    pub worker: String,
    pub reviewer: String,
    /// Harness id that writes the report.
    pub report: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AfterSaves {
    /// Run after this many new saves.
    pub threshold: u32,
    /// Saves since the last run.
    pub so_far: u32,
}

/// When Automatic mode runs. Each field is off when false or null.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflectTriggers {
    pub after_import: bool,
    /// Local time of the nightly run, such as "02:00".
    pub nightly_at: Option<String>,
    pub after_saves: Option<AfterSaves>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReflectPermission {
    ReportOnly,
    ProposeFixes,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflectSettings {
    pub mode: ReflectMode,
    pub harnesses: Vec<Harness>,
    pub roles: ReflectRoles,
    pub triggers: ReflectTriggers,
    pub permission: ReflectPermission,
}

#[tauri::command]
pub async fn list_reflect_runs(domain: String) -> CommandResult<Vec<ReflectRun>> {
    match env::home() {
        Some(home) => reflect_cache::list(&home, &domain),
        None => Ok(Vec::new()),
    }
}

/// The default settings, with each harness's readable vaults from the vaults
/// file. Nothing stores settings yet, so Reflect is manual and report-only.
pub(crate) fn default_settings(
    parsed: Option<&vaults_file::Parsed>,
    skill_installed: bool,
) -> ReflectSettings {
    let readable = |provider: Provider| -> Vec<String> {
        parsed
            .map(|parsed| {
                parsed
                    .vaults
                    .iter()
                    .filter(|v| vaults_file::providers(&v.providers).contains(&provider))
                    .map(|v| v.name.clone())
                    .collect()
            })
            .unwrap_or_default()
    };
    let harnesses = vec![
        Harness {
            id: reflect_cache::SKILL_HARNESS.to_owned(),
            name: "Claude Code".to_owned(),
            provider: vaults_file::provider_label(Provider::Anthropic).to_owned(),
            vaults_readable: readable(Provider::Anthropic),
            status: if skill_installed {
                HarnessStatus::Ready
            } else {
                HarnessStatus::NeedsSkill
            },
        },
        Harness {
            id: "kilo".to_owned(),
            name: "Kilo with local models".to_owned(),
            provider: vaults_file::provider_label(Provider::Local).to_owned(),
            vaults_readable: readable(Provider::Local),
            status: HarnessStatus::NotConnected,
        },
    ];
    let lead = reflect_cache::SKILL_HARNESS.to_owned();
    ReflectSettings {
        mode: ReflectMode::Manual,
        harnesses,
        roles: ReflectRoles {
            worker: lead.clone(),
            reviewer: lead.clone(),
            report: lead,
        },
        triggers: ReflectTriggers {
            after_import: false,
            nightly_at: None,
            after_saves: None,
        },
        permission: ReflectPermission::ReportOnly,
    }
}

#[tauri::command]
pub async fn get_reflect_settings() -> CommandResult<ReflectSettings> {
    let parsed = read_vaults()?;
    let skill =
        env::home().is_some_and(|home| home.join(".claude/skills/reflect/SKILL.md").is_file());
    Ok(default_settings(parsed.as_ref(), skill))
}

/// Never runs: starting a run launches agents that may write, so it stays
/// with the reflect skill in this build.
#[tauri::command]
pub async fn start_reflect(domain: String) -> CommandResult<ReflectRun> {
    let _ = domain;
    Err(CommandError::read_only())
}

/// Never writes: settings are read-only in this build.
#[tauri::command]
pub async fn save_reflect_settings(settings: ReflectSettings) -> CommandResult<()> {
    let _ = settings;
    Err(CommandError::read_only())
}

/// Never writes: findings are read-only in this build.
#[tauri::command]
pub async fn dismiss_finding(run: String, finding: String) -> CommandResult<()> {
    let _ = (run, finding);
    Err(CommandError::read_only())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enums_match_the_typescript_strings() -> Result<(), serde_json::Error> {
        assert_eq!(
            serde_json::to_string(&HarnessStatus::NeedsSkill)?,
            r#""needs-skill""#
        );
        let triggers = ReflectTriggers {
            after_import: true,
            nightly_at: Some("02:00".into()),
            after_saves: Some(AfterSaves {
                threshold: 25,
                so_far: 5,
            }),
        };
        let json = serde_json::to_value(triggers)?;
        assert_eq!(json["nightlyAt"], "02:00");
        assert_eq!(json["afterSaves"]["soFar"], 5);
        assert_eq!(
            serde_json::to_string(&ReflectPermission::ReportOnly)?,
            r#""report-only""#
        );
        Ok(())
    }

    #[test]
    fn defaults_are_manual_and_read_vaults_from_the_file() -> anyhow::Result<()> {
        let parsed = vaults_file::parse(vaults_file::tests::SAMPLE)?;
        let s = default_settings(Some(&parsed), false);
        assert_eq!(s.mode, ReflectMode::Manual);
        assert_eq!(s.harnesses[0].vaults_readable, ["personal"]);
        assert_eq!(s.harnesses[0].status, HarnessStatus::NeedsSkill);
        assert_eq!(s.harnesses[1].vaults_readable, ["personal", "work"]);
        assert_eq!(s.harnesses[0].provider, "Anthropic");
        assert_eq!(s.harnesses[1].provider, "Runs on this Mac");
        let json = serde_json::to_value(&s)?;
        assert_eq!(json["triggers"]["afterSaves"], serde_json::Value::Null);
        assert_eq!(json["harnesses"][0]["vaultsReadable"][0], "personal");
        Ok(())
    }
}

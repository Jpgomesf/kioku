//! The vaults file as the viewer shows it. kioku's own parser
//! (`kioku::vault::Vaults`) checks it but keeps its fields private, so the
//! fields are read here with a lenient twin of its TOML layout. Never written.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use kioku::access::Pattern;
use kioku::vault::{Provider, Vaults};
use serde::Deserialize;

use crate::commands::vaults::{VaultApp, VaultArea, VaultConfig, VaultsConfig};
use crate::data::env;

#[derive(Debug, Deserialize)]
struct FileToml {
    #[serde(default)]
    vault: Vec<VaultToml>,
    #[serde(default)]
    area: Vec<AreaToml>,
    #[serde(default)]
    lock: Vec<LockToml>,
}

#[derive(Debug, Deserialize)]
struct LockToml {
    #[serde(default)]
    domains: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct VaultToml {
    pub name: String,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub git_remotes: Vec<String>,
    #[serde(default)]
    pub domains: Vec<String>,
    #[serde(default)]
    pub providers: Vec<String>,
    #[serde(default)]
    pub default_domain: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AreaToml {
    domain: String,
    #[serde(default)]
    paths: Vec<String>,
}

/// An app with one visibility switch, and the provider it reads as.
pub struct AppSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub provider: Provider,
    pub description: &'static str,
}

/// Every app the Vaults page lists. Apps that share a provider share a switch
/// in kioku, so turning one on turns the others on too.
pub const APPS: [AppSpec; 8] = [
    AppSpec {
        id: "claude-code",
        name: "Claude Code",
        provider: Provider::Anthropic,
        description: "Anthropic models",
    },
    AppSpec {
        id: "claude-desktop",
        name: "Claude Desktop",
        provider: Provider::Anthropic,
        description: "Anthropic models",
    },
    AppSpec {
        id: "kilo",
        name: "Kilo with local models",
        provider: Provider::Local,
        description: "Runs on this Mac, nothing leaves it",
    },
    AppSpec {
        id: "codex",
        name: "Codex",
        provider: Provider::OpenAi,
        description: "OpenAI models",
    },
    AppSpec {
        id: "gemini",
        name: "Gemini CLI",
        provider: Provider::Google,
        description: "Google models",
    },
    AppSpec {
        id: "kimi",
        name: "Kimi",
        provider: Provider::Moonshot,
        description: "Moonshot models",
    },
    AppSpec {
        id: "deepseek",
        name: "DeepSeek",
        provider: Provider::DeepSeek,
        description: "DeepSeek models",
    },
    AppSpec {
        id: "other",
        name: "Other apps",
        provider: Provider::Other,
        description: "Any other hosted model",
    },
];

/// A provider in the words the Reflect page shows next to an app.
pub fn provider_label(provider: Provider) -> &'static str {
    match provider {
        Provider::Anthropic => "Anthropic",
        Provider::Local => "Runs on this Mac",
        Provider::OpenAi => "OpenAI",
        Provider::Google => "Google",
        Provider::Moonshot => "Moonshot",
        Provider::DeepSeek => "DeepSeek",
        Provider::Other => "Hosted model",
    }
}

pub fn app(id: &str) -> Option<&'static AppSpec> {
    APPS.iter().find(|app| app.id == id)
}

/// The names of the apps that read as `provider`, joined for a sentence.
pub fn app_names(provider: Provider) -> String {
    let names: Vec<&str> = APPS
        .iter()
        .filter(|app| app.provider == provider)
        .map(|app| app.name)
        .collect();
    match names.as_slice() {
        [] => provider.as_str().to_owned(),
        [one] => (*one).to_owned(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// Providers as kioku parses them; unknown names are left out.
pub fn providers(list: &[String]) -> Vec<Provider> {
    list.iter()
        .filter_map(|name| Provider::parse(name).ok())
        .collect()
}

/// The vaults file's path and text, or `None` text when it doesn't exist.
pub struct VaultsFile {
    pub path: PathBuf,
    pub text: Option<String>,
}

impl VaultsFile {
    pub fn read() -> Result<Self> {
        let path = env::vaults_file_path()?;
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => Some(text),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("cannot read vaults file {}", path.display()));
            }
        };
        Ok(Self { path, text })
    }
}

/// Check `text` with kioku's own rules, exactly as the server would at startup.
pub fn validate(text: &str, file: &Path) -> Result<Vaults> {
    Vaults::parse(text, file, env::home().as_deref())
}

/// The vaults file's fields, after kioku accepts it.
pub struct Parsed {
    pub vaults: Vec<VaultToml>,
    areas: Vec<AreaToml>,
    locks: Vec<LockToml>,
}

pub fn parse(text: &str) -> Result<Parsed> {
    let file: FileToml = toml::from_str(text).context("invalid vaults file")?;
    Ok(Parsed {
        vaults: file.vault,
        areas: file.area,
        locks: file.lock,
    })
}

fn owns(vault: &VaultToml, domain: &str) -> bool {
    vault
        .domains
        .iter()
        .filter_map(|source| Pattern::parse(source).ok())
        .any(|pattern| pattern.matches(domain))
}

impl Parsed {
    /// The vault whose domain patterns match `domain`, if exactly one does.
    pub fn owner(&self, domain: &str) -> Option<&VaultToml> {
        let mut owners = self.vaults.iter().filter(|vault| owns(vault, domain));
        match (owners.next(), owners.next()) {
            (Some(only), None) => Some(only),
            _ => None,
        }
    }

    /// Configured area domains of `vault`.
    pub fn area_domains<'a>(&'a self, vault: &'a str) -> impl Iterator<Item = &'a str> {
        self.areas
            .iter()
            .filter(move |area| self.owner(&area.domain).is_some_and(|v| v.name == vault))
            .map(|area| area.domain.as_str())
    }

    /// Areas of `vault` that `provider` may not read although the vault lists
    /// it, because a `[[lock]]` leaves the provider out. Uses kioku's own
    /// rules (`checked`), over the configured areas and the domains locks name.
    pub fn locked_areas(&self, checked: &Vaults, vault: &str, provider: Provider) -> Vec<String> {
        let mut out: Vec<String> = self
            .area_domains(vault)
            .chain(
                self.locks
                    .iter()
                    .flat_map(|lock| lock.domains.iter().map(String::as_str))
                    .filter(|domain| self.owner(domain).is_some_and(|v| v.name == vault)),
            )
            .filter(|domain| !checked.admits(domain, provider))
            .map(str::to_owned)
            .collect();
        out.sort();
        out.dedup();
        out
    }

    pub fn to_config(&self) -> VaultsConfig {
        let vaults = self
            .vaults
            .iter()
            .map(|vault| {
                let readers = providers(&vault.providers);
                VaultConfig {
                    name: vault.name.clone(),
                    paths: vault.paths.clone(),
                    git_remotes: vault.git_remotes.clone(),
                    domains: vault.domains.clone(),
                    providers: vault.providers.clone(),
                    areas: self
                        .areas
                        .iter()
                        .filter(|area| {
                            self.owner(&area.domain)
                                .is_some_and(|owner| owner.name == vault.name)
                        })
                        .map(|area| VaultArea {
                            domain: area.domain.clone(),
                            paths: area.paths.clone(),
                        })
                        .collect(),
                    default_domain: vault.default_domain.clone(),
                    apps: APPS
                        .iter()
                        .map(|app| VaultApp {
                            id: app.id.to_owned(),
                            name: app.name.to_owned(),
                            provider: app.provider.as_str().to_owned(),
                            description: app.description.to_owned(),
                            can_read: readers.contains(&app.provider),
                        })
                        .collect(),
                }
            })
            .collect();
        VaultsConfig { vaults }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) const SAMPLE: &str = r#"# Demo vaults
[[vault]]
name = "personal"
paths = ["/home/me"]
domains = ["personal", "personal/*", "local", "demo"]
providers = ["anthropic", "local"]
default_domain = "local"

[[vault]]
name = "work"
paths = ["/home/me/work"]
domains = ["work", "work/*"]
providers = [
  "local",
]
default_domain = "work"

[[area]]
domain = "personal/kioku"
paths = ["/home/me/projects/kioku"]
"#;

    #[test]
    fn sample_passes_kiokus_parser() -> Result<()> {
        validate(SAMPLE, Path::new("/cfg/vaults.toml"))?;
        Ok(())
    }

    #[test]
    fn config_lists_areas_and_switches() -> Result<()> {
        let parsed = parse(SAMPLE)?;
        assert_eq!(
            parsed.owner("personal/kioku").map(|v| v.name.as_str()),
            Some("personal")
        );
        assert_eq!(
            parsed.owner("work/demo").map(|v| v.name.as_str()),
            Some("work")
        );
        assert!(parsed.owner("elsewhere").is_none());
        let config = parsed.to_config();
        let personal = &config.vaults[0];
        assert_eq!(personal.areas.len(), 1);
        assert_eq!(personal.default_domain.as_deref(), Some("local"));
        let reads = |id: &str| personal.apps.iter().any(|a| a.id == id && a.can_read);
        assert!(reads("claude-code") && reads("claude-desktop") && reads("kilo"));
        assert!(!reads("codex"));
        let json = serde_json::to_value(&config)?;
        assert_eq!(json["vaults"][0]["gitRemotes"], serde_json::json!([]));
        assert_eq!(json["vaults"][0]["apps"][0]["canRead"], true);
        assert_eq!(json["vaults"][0]["apps"][0]["provider"], "anthropic");
        Ok(())
    }

    pub(crate) const LOCKED: &str = r#"[[vault]]
name = "personal"
paths = ["/home/me"]
domains = ["personal", "personal/*"]
providers = ["anthropic", "local"]  # trusted apps
default_domain = "personal"

[[area]]
domain = "personal/kioku"
paths = ["/home/me/projects/kioku"]

[[lock]]
domains = ["personal/kioku"]
providers = ["local"]
"#;

    #[test]
    fn locks_hide_areas_from_providers() -> Result<()> {
        let checked = validate(LOCKED, Path::new("/cfg/vaults.toml"))?;
        let parsed = parse(LOCKED)?;
        assert_eq!(
            parsed.locked_areas(&checked, "personal", Provider::Anthropic),
            ["personal/kioku"]
        );
        assert!(
            parsed
                .locked_areas(&checked, "personal", Provider::Local)
                .is_empty()
        );
        Ok(())
    }

    #[test]
    fn app_names_join_shared_providers() {
        assert_eq!(
            app_names(Provider::Anthropic),
            "Claude Code and Claude Desktop"
        );
        assert_eq!(app_names(Provider::OpenAi), "Codex");
    }
}

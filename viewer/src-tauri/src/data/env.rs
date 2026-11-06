//! Kioku's settings for the viewer: the env file named by `KIOKU_ENV_FILE`, or
//! in development builds the checkout's `.env`, layered over the process
//! environment. The process environment is never modified, and no value is
//! ever logged or put in an error message.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow};
use kioku::config::Config;

/// Where the vaults file is looked for when `MEMORY_VAULTS_FILE` is unset.
const DEFAULT_VAULTS_FILE: &str = "~/.config/kioku/vaults.toml";

/// The env file to read, if any.
pub fn env_file() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("KIOKU_ENV_FILE").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(path));
    }
    if cfg!(debug_assertions) {
        let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.env");
        if dev.is_file() {
            return Some(dev);
        }
    }
    None
}

/// The env file's variables. Parse errors name the file only: dotenvy's own
/// messages can quote the offending line, which may hold a secret.
pub fn overrides() -> Result<HashMap<String, String>> {
    let Some(file) = env_file() else {
        return Ok(HashMap::new());
    };
    let unreadable = || anyhow!("cannot read the Kioku env file {}", file.display());
    let entries = dotenvy::from_path_iter(&file).map_err(|_| unreadable())?;
    entries
        .map(|entry| entry.map_err(|_| unreadable()))
        .collect()
}

/// A variable from the env file, or else from the process environment.
fn lookup(overrides: &HashMap<String, String>, name: &str) -> Option<String> {
    overrides
        .get(name)
        .cloned()
        .or_else(|| std::env::var(name).ok())
        .filter(|value| !value.is_empty())
}

/// Kioku's configuration, read exactly as the kioku CLI reads it.
pub fn load_config() -> Result<Config> {
    Config::from_env_with(&overrides()?).context("invalid Kioku settings")
}

/// The home folder.
pub fn home() -> Option<PathBuf> {
    std::env::home_dir().filter(|path| !path.as_os_str().is_empty())
}

/// The vaults file kioku reads: `MEMORY_VAULTS_FILE`, or
/// `~/.config/kioku/vaults.toml`.
pub fn vaults_file_path() -> Result<PathBuf> {
    let overrides = overrides()?;
    let text =
        lookup(&overrides, "MEMORY_VAULTS_FILE").unwrap_or_else(|| DEFAULT_VAULTS_FILE.to_owned());
    kioku::vault::expand_home(&text, home().as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_prefers_the_env_file_and_skips_empty_values() {
        let mut map = HashMap::new();
        map.insert("KIOKU_VIEWER_TEST_UNSET".to_owned(), "from-file".to_owned());
        map.insert("KIOKU_VIEWER_TEST_EMPTY".to_owned(), String::new());
        assert_eq!(
            lookup(&map, "KIOKU_VIEWER_TEST_UNSET").as_deref(),
            Some("from-file")
        );
        assert_eq!(lookup(&map, "KIOKU_VIEWER_TEST_EMPTY"), None);
    }
}

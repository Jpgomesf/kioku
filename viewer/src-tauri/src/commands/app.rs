//! App info and updates: `get_app_info`, `check_for_updates`, `list_release_notes`.

use serde::{Deserialize, Serialize};

use crate::error::CommandResult;

/// The channel this build ships on.
pub const CHANNEL: UpdateChannel = UpdateChannel::Stable;

/// The changelog, read at compile time so the notes always match the build.
const CHANGELOG: &str = include_str!("../../../CHANGELOG.md");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateChannel {
    Stable,
    Beta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub channel: UpdateChannel,
    /// True while every command that would change a vault returns `read_only`.
    pub read_only: bool,
    /// True once a person can confirm changes with Touch ID or a password.
    pub can_authenticate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// False until signing keys and an update endpoint exist.
    pub configured: bool,
    pub current: String,
    pub latest: Option<String>,
    pub available: bool,
    pub checked_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseNote {
    pub version: String,
    /// The release date as written, or none for an unreleased build.
    pub date: Option<String>,
    pub title: String,
    pub changes: Vec<String>,
}

fn app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_owned(),
        channel: CHANNEL,
        read_only: true,
        can_authenticate: false,
    }
}

/// Updates are not configured until signing keys exist (see RELEASING.md), so this never
/// touches the network: no check ran, nothing is known about a newer version.
fn update_status() -> UpdateStatus {
    UpdateStatus {
        configured: false,
        current: env!("CARGO_PKG_VERSION").to_owned(),
        latest: None,
        available: false,
        checked_at: None,
    }
}

/// Parses Keep a Changelog Markdown. Each `## [X.Y.Z] - DATE` starts a release; its first
/// plain line is the title and every `- `, `* ` or `+ ` bullet is a change. An indented line
/// right after a bullet continues it. Any other `## ` heading (`[Unreleased]` included) ends
/// the current release, and link reference lines (`[label]: url`) are skipped.
fn parse_changelog(text: &str) -> Vec<ReleaseNote> {
    let mut notes: Vec<ReleaseNote> = Vec::new();
    let mut current: Option<usize> = None;
    let mut after_bullet = false;
    for raw in text.lines() {
        let line = raw.trim();
        if let Some(heading) = line.strip_prefix("## ") {
            current = parse_release_heading(heading).map(|note| {
                notes.push(note);
                notes.len() - 1
            });
            after_bullet = false;
            continue;
        }
        let Some(note) = current.and_then(|index| notes.get_mut(index)) else {
            continue;
        };
        if line.is_empty() || line.starts_with('#') || is_link_reference(line) {
            after_bullet = false;
            continue;
        }
        if let Some(change) = strip_bullet(line) {
            note.changes.push(change.trim().to_owned());
            after_bullet = true;
        } else if after_bullet && raw.starts_with(char::is_whitespace) {
            if let Some(last) = note.changes.last_mut() {
                last.push(' ');
                last.push_str(line);
            }
        } else {
            if note.title.is_empty() && note.changes.is_empty() {
                note.title = line.to_owned();
            }
            after_bullet = false;
        }
    }
    notes
}

fn strip_bullet(line: &str) -> Option<&str> {
    ["- ", "* ", "+ "]
        .iter()
        .find_map(|marker| line.strip_prefix(marker))
}

/// `[label]: <url>`, the link definitions Keep a Changelog puts at the bottom.
fn is_link_reference(line: &str) -> bool {
    line.strip_prefix('[')
        .and_then(|rest| rest.split_once("]:"))
        .is_some_and(|(label, url)| {
            !label.is_empty() && (url.is_empty() || url.starts_with(char::is_whitespace))
        })
}

fn parse_release_heading(heading: &str) -> Option<ReleaseNote> {
    let rest = heading.strip_prefix('[')?;
    let (version, rest) = rest.split_once(']')?;
    if version.eq_ignore_ascii_case("unreleased") {
        return None;
    }
    let date = rest.trim().trim_start_matches(['-', '–']).trim();
    Some(ReleaseNote {
        version: version.trim().to_owned(),
        date: (!date.is_empty() && !date.eq_ignore_ascii_case("unreleased"))
            .then(|| date.to_owned()),
        title: String::new(),
        changes: Vec::new(),
    })
}

#[tauri::command]
pub async fn get_app_info() -> CommandResult<AppInfo> {
    Ok(app_info())
}

#[tauri::command]
pub async fn check_for_updates() -> CommandResult<UpdateStatus> {
    Ok(update_status())
}

#[tauri::command]
pub async fn list_release_notes() -> CommandResult<Vec<ReleaseNote>> {
    Ok(parse_changelog(CHANGELOG))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_info_reports_the_package_version() {
        let info = app_info();
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(info.channel, UpdateChannel::Stable);
        assert!(info.read_only);
        assert!(!info.can_authenticate);
    }

    #[test]
    fn update_status_is_not_configured() {
        let status = update_status();
        assert!(!status.configured);
        assert!(!status.available);
        assert_eq!(status.latest, None);
        assert_eq!(status.checked_at, None);
    }

    #[test]
    fn the_bundled_changelog_lists_this_version() {
        let notes = parse_changelog(CHANGELOG);
        let Some(first) = notes.first() else {
            panic!("CHANGELOG.md has no release");
        };
        assert_eq!(first.version, env!("CARGO_PKG_VERSION"));
        assert!(!first.title.is_empty());
        assert!(!first.changes.is_empty());
    }

    #[test]
    fn parses_releases_titles_and_wrapped_bullets() {
        let text = "# Changelog\n\nIntro.\n\n## [Unreleased]\n\n- skipped\n\n\
                    ## [0.2.0] - 2026-12-01\n\nSecond.\n\n### Added\n\n- One\n  continued\n- Two\n\n\
                    ## [0.1.0] - Unreleased\n\n### Fixed\n\n- Three\n";
        let notes = parse_changelog(text);
        assert_eq!(
            notes,
            vec![
                ReleaseNote {
                    version: "0.2.0".into(),
                    date: Some("2026-12-01".into()),
                    title: "Second.".into(),
                    changes: vec!["One continued".into(), "Two".into()],
                },
                ReleaseNote {
                    version: "0.1.0".into(),
                    date: None,
                    title: String::new(),
                    changes: vec!["Three".into()],
                },
            ]
        );
    }

    #[test]
    fn skips_link_references_other_sections_and_loose_paragraphs() {
        let text = "## [0.3.0] - 2026-12-02\n\n- One\n- Two\n\nA closing paragraph.\n\n\
                    ## Notes\n\n- not a change\n\n\
                    ## [0.2.0] - 2026-12-01\n\n* star bullet\n+ plus bullet\n\n\
                    ## [Unreleased]\n\n- also skipped\n\n\
                    ## [0.1.0] - 2026-11-01\n\n- Last bullet\n\n\
                    [Unreleased]: https://github.com/x/y/compare/v0.3.0...HEAD\n\
                    [0.3.0]: https://github.com/x/y/compare/v0.2.0...v0.3.0\n\
                    [0.1.0]: https://github.com/x/y/releases/tag/v0.1.0\n";
        let notes = parse_changelog(text);
        let changes: Vec<Vec<String>> = notes.iter().map(|n| n.changes.clone()).collect();
        assert_eq!(
            changes,
            vec![
                vec!["One".to_owned(), "Two".to_owned()],
                vec!["star bullet".to_owned(), "plus bullet".to_owned()],
                vec!["Last bullet".to_owned()],
            ]
        );
        assert!(notes.iter().all(|n| n.title.is_empty()));
    }

    #[test]
    fn a_line_after_a_blank_does_not_continue_a_bullet() {
        let notes = parse_changelog("## [0.1.0] - 2026-11-01\n\n- One\n\n  indented later\n");
        assert_eq!(
            notes.first().map(|n| n.changes.clone()),
            Some(vec!["One".to_owned()])
        );
    }

    #[test]
    fn serializes_camel_case() -> Result<(), serde_json::Error> {
        let json = serde_json::to_value(update_status())?;
        assert!(json.get("checkedAt").is_some());
        assert_eq!(serde_json::to_value(CHANNEL)?, "stable");
        Ok(())
    }
}

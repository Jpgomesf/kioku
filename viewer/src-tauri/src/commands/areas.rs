//! Vaults and areas: `list_vaults`, `list_areas`.

use serde::{Deserialize, Serialize};

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use kioku::model::Status;
use kioku::vault::Provider;
use tauri::State;

use crate::data::counts::{self, Tally};
use crate::data::{notes, vaults_file};
use crate::error::CommandResult;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vault {
    pub name: String,
    pub domains: Vec<String>,
    pub providers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Area {
    pub domain: String,
    pub label: String,
    pub vault: String,
    pub note_count: u32,
    pub legacy_count: u32,
    /// Where the area's notes are imported from, if anywhere.
    pub source: Option<String>,
}

/// The vault name shown when there is no vaults file (kioku's open mode).
const OPEN_VAULT: &str = kioku::vault::OPEN_LABEL;

/// The parsed vaults file, after kioku's parser accepts it; `None` without one.
pub(crate) fn read_vaults() -> CommandResult<Option<vaults_file::Parsed>> {
    let file = vaults_file::VaultsFile::read()?;
    let Some(text) = file.text else {
        return Ok(None);
    };
    vaults_file::validate(&text, &file.path)?;
    Ok(Some(vaults_file::parse(&text)?))
}

fn to_vaults(parsed: Option<&vaults_file::Parsed>) -> Vec<Vault> {
    match parsed {
        Some(parsed) => parsed
            .vaults
            .iter()
            .map(|vault| Vault {
                name: vault.name.clone(),
                domains: vault.domains.clone(),
                providers: vault.providers.clone(),
            })
            .collect(),
        None => vec![Vault {
            name: OPEN_VAULT.to_owned(),
            domains: vec!["*".to_owned()],
            providers: Provider::ALL
                .iter()
                .map(|p| p.as_str().to_owned())
                .collect(),
        }],
    }
}

/// The area's label without its vault: `personal/kioku` in `personal` is `kioku`.
pub(crate) fn label(domain: &str, vault: &str) -> String {
    domain
        .strip_prefix(vault)
        .and_then(|rest| rest.strip_prefix('/'))
        .filter(|rest| !rest.is_empty())
        .unwrap_or(domain)
        .to_owned()
}

/// The folder every note of an area was imported from, if they share one.
fn common_source(sources: &[String]) -> Option<String> {
    let first = Path::new(sources.first()?).parent()?;
    let mut common: PathBuf = first.to_path_buf();
    for source in &sources[1..] {
        while !Path::new(source).starts_with(&common) {
            if !common.pop() {
                return None;
            }
        }
    }
    let text = common.to_string_lossy().into_owned();
    (!text.is_empty() && text != "/").then_some(text)
}

/// Areas from the notes' domains and the vaults file's areas, by vault then label.
pub(crate) fn build_areas(
    rows: &[Tally],
    parsed: Option<&vaults_file::Parsed>,
    notes_root: Option<&Path>,
) -> Vec<Area> {
    #[derive(Default)]
    struct Tally {
        active: u32,
        legacy: u32,
        sources: Vec<String>,
        unsourced: bool,
    }
    let mut tallies: BTreeMap<String, Tally> = BTreeMap::new();
    for row in rows {
        let tally = tallies.entry(row.domain.clone()).or_default();
        match row.status {
            Status::Active => tally.active += row.count,
            Status::Legacy => tally.legacy += row.count,
        }
        tally.unsourced |= row.unsourced;
        tally.sources.extend(
            row.sources
                .iter()
                .filter_map(|source| notes::display_source(Some(source), notes_root)),
        );
    }
    if let Some(parsed) = parsed {
        for vault in &parsed.vaults {
            for domain in parsed.area_domains(&vault.name) {
                tallies.entry(domain.to_owned()).or_default();
            }
        }
    }
    let mut areas: Vec<Area> = tallies
        .into_iter()
        .filter_map(|(domain, tally)| {
            let vault = match parsed {
                Some(parsed) => parsed.owner(&domain)?.name.clone(),
                None => OPEN_VAULT.to_owned(),
            };
            Some(Area {
                label: label(&domain, &vault),
                source: if tally.unsourced {
                    None
                } else {
                    common_source(&tally.sources)
                },
                note_count: tally.active,
                legacy_count: tally.legacy,
                domain,
                vault,
            })
        })
        .collect();
    areas.sort_by(|a, b| (&a.vault, &a.label).cmp(&(&b.vault, &b.label)));
    areas
}

#[tauri::command]
pub async fn list_vaults() -> CommandResult<Vec<Vault>> {
    Ok(to_vaults(read_vaults()?.as_ref()))
}

#[tauri::command]
pub async fn list_areas(state: State<'_, AppState>) -> CommandResult<Vec<Area>> {
    let parsed = read_vaults()?;
    let services = state.read_only().await?;
    let rows = counts::tallies(&services.pool).await?;
    Ok(build_areas(
        &rows,
        parsed.as_ref(),
        services.config.notes_root.as_deref(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::notes::tests::note;
    use crate::data::vaults_file::tests::SAMPLE;

    #[test]
    fn labels_never_repeat_the_vault() {
        assert_eq!(label("personal/kioku", "personal"), "kioku");
        assert_eq!(label("personal", "personal"), "personal");
        assert_eq!(label("demo", "personal"), "demo");
        assert_eq!(label("personalia", "personal"), "personalia");
    }

    #[test]
    fn areas_count_notes_and_include_configured_ones() -> anyhow::Result<()> {
        let parsed = vaults_file::parse(SAMPLE)?;
        let mut retired = note("demo", "b", &[], None);
        retired.status = Status::Legacy;
        let notes = vec![
            note("demo", "a", &[], Some("/notes/demo/a.md")),
            retired,
            note("local", "c", &[], Some("/notes/local/x/c.md")),
            note("local", "d", &[], Some("/notes/local/y/d.md")),
            note("elsewhere", "e", &[], None),
        ];
        let areas = build_areas(
            &counts::from_notes(&notes),
            Some(&parsed),
            Some(Path::new("/notes")),
        );
        let names: Vec<&str> = areas.iter().map(|a| a.domain.as_str()).collect();
        assert_eq!(names, ["demo", "personal/kioku", "local"]);
        assert_eq!((areas[0].note_count, areas[0].legacy_count), (1, 1));
        assert_eq!(areas[0].source, None);
        assert_eq!(areas[1].label, "kioku");
        assert_eq!(areas[1].note_count, 0);
        assert_eq!(areas[2].source.as_deref(), Some("local"));
        let json = serde_json::to_value(&areas[0])?;
        assert_eq!(json["noteCount"], 1);
        assert_eq!(json["legacyCount"], 1);
        Ok(())
    }

    #[test]
    fn open_mode_has_one_vault() {
        let vaults = to_vaults(None);
        assert_eq!(vaults.len(), 1);
        assert_eq!(vaults[0].domains, ["*"]);
    }
}

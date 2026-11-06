//! Search: `search_notes`.

use serde::{Deserialize, Serialize};

use super::notes::NoteSummary;
use tauri::State;

use super::areas::read_vaults;
use crate::data::search;
use crate::error::{CommandError, CommandResult};
use crate::state::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MatchedBy {
    Label,
    Text,
    Meaning,
    Linked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub note: NoteSummary,
    pub score: f64,
    /// Every signal that matched, such as words and meaning together.
    pub matched_by: Vec<MatchedBy>,
    /// Title of the note this hit was reached from, for link-filled results.
    pub linked_from: Option<String>,
    pub snippet: String,
}

/// Search one area, or every area of a vault.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchScope {
    Domain(String),
    Vault(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub scope: SearchScope,
    pub text: String,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub include_legacy: bool,
}

/// Results when the query names no limit.
const DEFAULT_LIMIT: u32 = 10;
/// Most results one search returns, as in kioku.
const MAX_LIMIT: u32 = 20;

/// Check the query text and limit as kioku does.
fn checked(query: &SearchQuery) -> CommandResult<(&str, usize)> {
    let text = query.text.trim();
    if text.is_empty() || text.len() > 4000 {
        return Err(CommandError::invalid_argument(
            "Search text must be 1 to 4000 bytes.",
        ));
    }
    // A limit is "at most": kioku ranks at most MAX_LIMIT hits.
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    Ok((text, usize::try_from(limit).unwrap_or(20)))
}

#[tauri::command]
pub async fn search_notes(
    state: State<'_, AppState>,
    query: SearchQuery,
) -> CommandResult<Vec<SearchHit>> {
    let (text, limit) = checked(&query)?;
    let services = state.read_only().await?;
    let domains: Vec<String> = match &query.scope {
        SearchScope::Domain(domain) => vec![domain.clone()],
        SearchScope::Vault(vault) => {
            let parsed = read_vaults()?;
            let all = services.store.domains().await?;
            match parsed {
                Some(parsed) => {
                    if !parsed.vaults.iter().any(|v| &v.name == vault) {
                        return Err(CommandError::not_found(format!("No vault {vault:?}.")));
                    }
                    all.into_iter()
                        .filter(|d| parsed.owner(d).is_some_and(|v| &v.name == vault))
                        .collect()
                }
                None => all,
            }
        }
    };
    if domains.is_empty() {
        return Ok(Vec::new());
    }
    Ok(search::search(services, text, &domains, limit, query.include_legacy).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_reads_domain_or_vault() -> Result<(), serde_json::Error> {
        let q: SearchQuery = serde_json::from_str(r#"{"scope":{"vault":"personal"},"text":"x"}"#)?;
        assert_eq!(q.scope, SearchScope::Vault("personal".into()));
        assert!(!q.include_legacy);
        Ok(())
    }

    #[test]
    fn limits_and_text_are_checked() -> Result<(), serde_json::Error> {
        let q: SearchQuery = serde_json::from_str(r#"{"scope":{"domain":"demo"},"text":"  "}"#)?;
        assert!(checked(&q).is_err());
        let q: SearchQuery =
            serde_json::from_str(r#"{"scope":{"domain":"demo"},"text":"x","limit":21}"#)?;
        assert_eq!(checked(&q).ok(), Some(("x", 20)));
        let q: SearchQuery =
            serde_json::from_str(r#"{"scope":{"domain":"demo"},"text":"x","limit":50}"#)?;
        assert_eq!(checked(&q).ok(), Some(("x", 20)));
        let q: SearchQuery = serde_json::from_str(r#"{"scope":{"domain":"demo"},"text":" x "}"#)?;
        assert_eq!(checked(&q).ok(), Some(("x", 10)));
        Ok(())
    }
}

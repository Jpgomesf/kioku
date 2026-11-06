//! Notes: `list_notes`, `get_note`.

use serde::{Deserialize, Serialize};

use kioku::model::NoteInput;
use tauri::State;

use crate::data::notes::{self, NoteFilter};
use crate::data::{links, scope};
use crate::error::{CommandError, CommandResult};
use crate::state::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NoteStatus {
    Active,
    Legacy,
    Draft,
}

/// A status filter: one status, or `all`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StatusFilter {
    Active,
    Legacy,
    Draft,
    All,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NoteOrigin {
    File,
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub key: String,
    pub domain: String,
    pub title: String,
    /// A lowercase type id such as `decision`, or `note` when nothing names one.
    pub kind: String,
    pub status: NoteStatus,
    pub origin: NoteOrigin,
    pub tags: Vec<String>,
    pub link_count: u32,
    /// Open Reflect findings that name this note.
    pub finding_count: u32,
    /// Where an imported note came from, such as a knowledge base name.
    pub source: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub target_key: String,
    pub target_domain: String,
    /// The target note's title, when it could be read.
    pub target_title: Option<String>,
    pub relation: String,
    pub suggested: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    /// The note's content revision; a status change keeps it.
    pub revision: i64,
    pub at: String,
    pub summary: String,
    pub origin: NoteOrigin,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub key: String,
    pub domain: String,
    pub title: String,
    pub body: String,
    /// A lowercase type id such as `decision`, or `note` when nothing names one.
    pub kind: String,
    pub status: NoteStatus,
    pub origin: NoteOrigin,
    pub aliases: Vec<String>,
    pub tags: Vec<String>,
    pub links: Vec<Link>,
    /// Newest first, at most `REVISIONS`.
    pub revisions: Vec<Revision>,
    /// The note's current content revision.
    pub revision: i64,
    /// The file an imported note came from, relative to the notes root when under it.
    pub source_path: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteQuery {
    pub domain: String,
    #[serde(default)]
    pub kinds: Option<Vec<String>>,
    #[serde(default)]
    pub status: Option<StatusFilter>,
    #[serde(default)]
    pub origin: Option<NoteOrigin>,
    /// Only notes changed on or after this ISO date.
    #[serde(default)]
    pub since: Option<String>,
    /// Filter text over titles, keys and tags.
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

/// History entries shown on a note.
const REVISIONS: i64 = 20;

#[tauri::command]
pub async fn list_notes(
    state: State<'_, AppState>,
    query: NoteQuery,
) -> CommandResult<Vec<NoteSummary>> {
    let filter = NoteFilter::new(&query)?;
    if filter.matches_nothing() {
        return Ok(Vec::new());
    }
    let services = state.read_only().await?;
    scope::ensure_fits(
        &services.pool,
        std::slice::from_ref(&query.domain),
        filter.needs_legacy(),
    )
    .await?;
    let domain = Some(query.domain.as_str());
    let all = services.store.notes(domain, filter.needs_legacy()).await?;
    let links = notes::link_counts(&services.store.edges(domain).await?);
    let root = services.config.notes_root.as_deref();
    let mut out: Vec<NoteSummary> = all
        .iter()
        .filter(|note| filter.keeps(note))
        .map(|note| notes::summary(note, links.get(&note.id).copied().unwrap_or(0), root))
        .collect();
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.key.cmp(&b.key)));
    out.truncate(filter.limit);
    Ok(out)
}

#[tauri::command]
pub async fn get_note(
    state: State<'_, AppState>,
    domain: String,
    key: String,
) -> CommandResult<Note> {
    let services = state.read_only().await?;
    let id = NoteInput::id_for(&domain, &key);
    let note = match services.store.get(id).await? {
        Some(note) if note.input.domain == domain => note,
        _ => {
            return Err(CommandError::not_found(format!(
                "No note {key:?} in {domain:?}."
            )));
        }
    };
    let edges = links::edges_of(&services.pool, id).await?;
    let mut neighbour_ids: Vec<_> = edges
        .iter()
        .flat_map(|edge| [edge.source, edge.target])
        .filter(|other| *other != id)
        .collect();
    neighbour_ids.sort_unstable();
    neighbour_ids.dedup();
    let neighbours = links::labels(&services.pool, &neighbour_ids).await?;
    let labels = neighbours
        .iter()
        .map(|n| (n.id, (n.domain.as_str(), n.key.as_str(), n.title.as_str())))
        .collect();
    let origin = notes::origin_of(&note.input);
    // One extra entry tells whether the oldest shown line was the first save.
    let history = services.store.revisions(id, REVISIONS + 1).await?;
    let shown = usize::try_from(REVISIONS).unwrap_or(20);
    let input = &note.input;
    Ok(Note {
        key: input.key.clone(),
        domain: input.domain.clone(),
        title: input.title.clone(),
        body: input.body.clone(),
        kind: notes::kind_of(input),
        status: notes::status_of(note.status),
        origin,
        aliases: input.aliases.clone(),
        tags: input.tags.clone(),
        links: notes::links_of(id, &edges, &labels),
        revisions: notes::revisions_of(&history, origin, shown),
        revision: note.revision,
        source_path: notes::display_source(
            input.source.as_deref(),
            services.config.notes_root.as_deref(),
        ),
        updated_at: notes::timestamp(note.updated_at),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_reads_camel_case_json() -> Result<(), serde_json::Error> {
        let q: NoteQuery = serde_json::from_str(
            r#"{"domain":"demo","kinds":["decision","design-review"],"status":"all","limit":5}"#,
        )?;
        assert_eq!(
            q.kinds,
            Some(vec!["decision".to_owned(), "design-review".to_owned()])
        );
        assert_eq!(q.status, Some(StatusFilter::All));
        Ok(())
    }

    #[test]
    fn summary_writes_camel_case() -> Result<(), serde_json::Error> {
        let s = NoteSummary {
            key: "k".into(),
            domain: "demo".into(),
            title: "t".into(),
            kind: "design-review".into(),
            status: NoteStatus::Active,
            origin: NoteOrigin::File,
            tags: vec![],
            link_count: 2,
            finding_count: 0,
            source: None,
            updated_at: "2026-11-06".into(),
        };
        let json = serde_json::to_value(s)?;
        assert_eq!(json["linkCount"], 2);
        assert_eq!(json["updatedAt"], "2026-11-06");
        assert_eq!(json["findingCount"], 0);
        assert_eq!(json["kind"], "design-review");
        Ok(())
    }
}

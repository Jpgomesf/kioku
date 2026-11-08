//! Mapping Kioku notes to the viewer's note types, and the list filters.

use std::collections::HashMap;
use std::path::Path;

use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use kioku::model::{Edge, Note, NoteInput, NoteRevision, Status};
use uuid::Uuid;

use crate::commands::notes::{
    Link, NoteOrigin, NoteQuery, NoteStatus, NoteSummary, Revision, StatusFilter,
};
use crate::error::{CommandError, CommandResult};

/// Most notes one list returns.
pub const MAX_LIST: u32 = 10_000;

/// ISO 8601 in UTC, to the second.
pub fn timestamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// Type words a tag names on its own, in priority order. Exact matches only:
/// a synonym such as `adr` or `pr` is a type only through a `kind:` tag.
const KNOWN_TYPES: [&str; 12] = [
    "decision",
    "question",
    "fix",
    "gotcha",
    "convention",
    "preference",
    "topic",
    "item",
    "issue",
    "ticket",
    "pull-request",
    "todo",
];

/// What a note is called when nothing names its type.
pub const UNTYPED: &str = "note";

/// A note's type id. An explicit `kind:` or `type:` tag wins, then the type
/// an OKF import gave it, then the first known type word among its tags.
/// Runs once per listed note, so it allocates only the answer.
pub fn kind_of(input: &NoteInput) -> String {
    let explicit = input.tags.iter().find_map(|tag| {
        let tag = tag.trim();
        let (prefix, rest) = tag.split_at_checked(5)?;
        // Check the prefix first, so untyped tags allocate nothing.
        if !(prefix.eq_ignore_ascii_case("kind:") || prefix.eq_ignore_ascii_case("type:")) {
            return None;
        }
        let kind = kioku::okf::type_tag(rest);
        (!kind.is_empty()).then_some(kind)
    });
    explicit
        .or_else(|| kioku::okf::imported_type(input))
        .or_else(|| {
            KNOWN_TYPES
                .iter()
                .find(|known| {
                    input
                        .tags
                        .iter()
                        .any(|tag| tag.trim().eq_ignore_ascii_case(known))
                })
                .map(|known| (*known).to_owned())
        })
        .unwrap_or_else(|| UNTYPED.to_owned())
}

pub fn status_of(status: Status) -> NoteStatus {
    match status {
        Status::Active => NoteStatus::Active,
        Status::Legacy => NoteStatus::Legacy,
    }
}

/// Imported notes carry a source; notes agents saved have none.
pub fn origin_of(input: &NoteInput) -> NoteOrigin {
    if input.source.is_some() {
        NoteOrigin::File
    } else {
        NoteOrigin::Agent
    }
}

/// A source as kioku shows it: relative to the notes root when under it.
pub fn display_source(source: Option<&str>, notes_root: Option<&Path>) -> Option<String> {
    let source = source?;
    let relative = notes_root
        .and_then(|root| Path::new(source).strip_prefix(root).ok())
        .map(|path| path.to_string_lossy().into_owned());
    Some(relative.unwrap_or_else(|| source.to_owned()))
}

/// Links per note, counting both directions.
pub fn link_counts(edges: &[Edge]) -> HashMap<Uuid, u32> {
    let mut counts: HashMap<Uuid, u32> = HashMap::new();
    for edge in edges {
        *counts.entry(edge.source).or_default() += 1;
        *counts.entry(edge.target).or_default() += 1;
    }
    counts
}

pub fn summary(note: &Note, link_count: u32, notes_root: Option<&Path>) -> NoteSummary {
    let input = &note.input;
    NoteSummary {
        key: input.key.clone(),
        domain: input.domain.clone(),
        title: input.title.clone(),
        kind: kind_of(input),
        status: status_of(note.status),
        origin: origin_of(input),
        tags: input.tags.clone(),
        link_count,
        finding_count: 0,
        source: display_source(input.source.as_deref(), notes_root),
        updated_at: timestamp(note.updated_at),
    }
}

/// `since` as an instant: a date (`2026-11-06`) or a full RFC 3339 time.
pub fn parse_since(text: &str) -> CommandResult<DateTime<Utc>> {
    let text = text.trim();
    if let Ok(at) = DateTime::parse_from_rfc3339(text) {
        return Ok(at.with_timezone(&Utc));
    }
    NaiveDate::parse_from_str(text, "%Y-%m-%d")
        .ok()
        .and_then(|date| date.and_hms_opt(0, 0, 0))
        .map(|at| at.and_utc())
        .ok_or_else(|| CommandError::invalid_argument(format!("{text:?} is not a date")))
}

/// The parsed parts of a [`NoteQuery`].
pub struct NoteFilter {
    kinds: Option<Vec<String>>,
    status: StatusFilter,
    origin: Option<NoteOrigin>,
    since: Option<DateTime<Utc>>,
    text: Option<String>,
    pub limit: usize,
}

impl NoteFilter {
    pub fn new(query: &NoteQuery) -> CommandResult<Self> {
        // A limit is "at most": anything above the cap is capped.
        let limit = query.limit.unwrap_or(MAX_LIST).min(MAX_LIST);
        if limit == 0 {
            return Err(CommandError::invalid_argument("limit must be at least 1"));
        }
        Ok(Self {
            kinds: query.kinds.clone().filter(|kinds| !kinds.is_empty()),
            status: query.status.unwrap_or(StatusFilter::All),
            origin: query.origin,
            since: query.since.as_deref().map(parse_since).transpose()?,
            text: query
                .text
                .as_deref()
                .map(kioku::rank::fold)
                .filter(|text| !text.trim().is_empty()),
            limit: usize::try_from(limit).unwrap_or(usize::MAX),
        })
    }

    /// Whether no stored note can match. Kioku stores no drafts.
    pub fn matches_nothing(&self) -> bool {
        matches!(self.status, StatusFilter::Draft)
    }

    /// Whether the database must load legacy notes for this filter.
    pub fn needs_legacy(&self) -> bool {
        !matches!(self.status, StatusFilter::Active)
    }

    pub fn keeps(&self, note: &Note) -> bool {
        let input = &note.input;
        let status_ok = match self.status {
            StatusFilter::All => true,
            StatusFilter::Active => note.status == Status::Active,
            StatusFilter::Legacy => note.status == Status::Legacy,
            StatusFilter::Draft => false,
        };
        status_ok
            && self
                .kinds
                .as_ref()
                .is_none_or(|kinds| kinds.contains(&kind_of(input)))
            && self.origin.is_none_or(|origin| origin == origin_of(input))
            && self.since.is_none_or(|since| note.updated_at >= since)
            && self.text.as_ref().is_none_or(|text| {
                std::iter::once(&input.title)
                    .chain(std::iter::once(&input.key))
                    .chain(&input.tags)
                    .chain(&input.aliases)
                    .any(|field| kioku::rank::fold(field).contains(text.as_str()))
            })
    }
}

/// A note's links, outgoing first, by key. Incoming links read "linked from".
pub fn links_of(id: Uuid, edges: &[Edge], keys: &HashMap<Uuid, (&str, &str, &str)>) -> Vec<Link> {
    let link = |other: Uuid, relation: String| {
        keys.get(&other).map(|(domain, key, title)| Link {
            target_key: (*key).to_owned(),
            target_domain: (*domain).to_owned(),
            target_title: (!title.is_empty()).then(|| (*title).to_owned()),
            relation,
            suggested: false,
        })
    };
    let outgoing = edges
        .iter()
        .filter(|edge| edge.source == id)
        .filter_map(|edge| link(edge.target, edge.kind.clone()));
    let incoming = edges
        .iter()
        .filter(|edge| edge.target == id && edge.source != id)
        .filter_map(|edge| link(edge.source, "linked from".to_owned()));
    outgoing.chain(incoming).collect()
}

/// One line per history entry, newest first, at most `shown` lines. Pass one
/// entry more than `shown` when the history may be longer: it is used only to
/// describe the oldest shown line, which is "Saved as" only when nothing
/// older exists.
pub fn revisions_of(history: &[NoteRevision], origin: NoteOrigin, shown: usize) -> Vec<Revision> {
    history
        .iter()
        .take(shown)
        .enumerate()
        .map(|(i, entry)| {
            let older = history.get(i + 1);
            let summary = match older {
                None => format!("Saved as {:?}", entry.title),
                Some(prev) if prev.status != entry.status => match entry.status {
                    Status::Legacy => "Retired".to_owned(),
                    Status::Active => "Restored".to_owned(),
                },
                Some(prev) if prev.title != entry.title => {
                    format!("Renamed to {:?}", entry.title)
                }
                Some(_) => format!("Revision {}", entry.revision),
            };
            Revision {
                revision: entry.revision,
                at: timestamp(entry.written_at),
                summary,
                origin,
            }
        })
        .collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn note(domain: &str, key: &str, tags: &[&str], source: Option<&str>) -> Note {
        let input = NoteInput {
            domain: domain.into(),
            key: key.into(),
            title: format!("Title of {key}"),
            body: format!("Body of {key}"),
            aliases: vec![],
            related: vec![],
            tags: tags.iter().map(|t| (*t).to_owned()).collect(),
            source: source.map(str::to_owned),
            confidence: 0.8,
            pinned: false,
            lock: vec![],
            paths: Vec::new(),
        };
        let at = DateTime::parse_from_rfc3339("2026-11-01T10:00:00Z")
            .map(|at| at.with_timezone(&Utc))
            .unwrap_or_default();
        Note {
            id: input.id(),
            input,
            status: Status::Active,
            created_at: at,
            updated_at: at,
            last_accessed_at: None,
            access_count: 0,
            positive_feedback: 0,
            negative_feedback: 0,
            retention_score: 1.0,
            last_decay_at: at,
            vector_synced: true,
            revision: 1,
        }
    }

    fn kind(tags: &[&str], body: &str) -> String {
        let mut n = note("demo", "k", tags, None);
        n.input.body = body.into();
        kind_of(&n.input)
    }

    #[test]
    fn an_explicit_kind_tag_wins() {
        assert_eq!(
            kind(&["decision", "Kind:Design Review"], ""),
            "design-review"
        );
        assert_eq!(kind(&["TYPE:PR"], ""), "pr");
        // An explicit tag beats the imported type too.
        assert_eq!(
            kind(&["runbook", "kind:fix"], "Runbook · unverified"),
            "fix"
        );
        // An empty one names nothing.
        assert_eq!(kind(&["kind: - ", "fix"], ""), "fix");
    }

    #[test]
    fn the_imported_type_comes_next() {
        // The import writes the producer id as the first alias.
        let mut n = note("demo", "k", &["decision", "design-review"], None);
        n.input.body = "Design Review DR-1 · unverified\nText.".into();
        n.input.aliases = vec!["DR-1".into()];
        assert_eq!(kind_of(&n.input), "design-review");
        // Without a trust label the line is not an import's facts line.
        assert_eq!(
            kind(&["design-review", "fix"], "Design Review · notes"),
            "fix"
        );
    }

    #[test]
    fn then_the_first_known_type_word_by_priority() {
        assert_eq!(kind(&["rust", "fix", "Decision"], ""), "decision");
        assert_eq!(kind(&["todo", "gotcha"], ""), "gotcha");
        assert_eq!(kind(&["pull-request"], ""), "pull-request");
        // No synonym merging.
        for tag in ["adr", "bugfix", "pr"] {
            assert_eq!(kind(&[tag], ""), UNTYPED);
        }
        assert_eq!(kind(&[], ""), "note");
    }

    #[test]
    fn summary_maps_origin_source_and_time() -> Result<(), serde_json::Error> {
        let n = note("personal/kioku", "k", &["fix"], Some("/notes/kioku/k.md"));
        let s = summary(&n, 3, Some(Path::new("/notes")));
        assert_eq!(s.kind, "fix");
        assert_eq!(s.origin, NoteOrigin::File);
        assert_eq!(s.source.as_deref(), Some("kioku/k.md"));
        let json = serde_json::to_value(&s)?;
        assert_eq!(json["updatedAt"], "2026-11-01T10:00:00Z");
        assert_eq!(json["linkCount"], 3);
        assert_eq!(json["origin"], "file");
        let agent = summary(&note("local", "a", &[], None), 0, None);
        assert_eq!(agent.origin, NoteOrigin::Agent);
        Ok(())
    }

    #[test]
    fn filter_applies_every_field() -> CommandResult<()> {
        let n = note("demo", "tokio-runtime", &["decision"], None);
        let query = |json: &str| -> CommandResult<NoteFilter> {
            let q: NoteQuery = serde_json::from_str(json)
                .map_err(|e| CommandError::invalid_argument(e.to_string()))?;
            NoteFilter::new(&q)
        };
        assert!(query(r#"{"domain":"demo"}"#)?.keeps(&n));
        assert!(query(r#"{"domain":"demo","text":"TOKIO"}"#)?.keeps(&n));
        assert!(!query(r#"{"domain":"demo","text":"qdrant"}"#)?.keeps(&n));
        assert!(!query(r#"{"domain":"demo","kinds":["fix"]}"#)?.keeps(&n));
        assert!(query(r#"{"domain":"demo","kinds":["runbook","decision"]}"#)?.keeps(&n));
        assert!(!query(r#"{"domain":"demo","kinds":["Decision"]}"#)?.keeps(&n));
        assert!(query(r#"{"domain":"demo","origin":"agent"}"#)?.keeps(&n));
        assert!(!query(r#"{"domain":"demo","status":"legacy"}"#)?.keeps(&n));
        assert!(query(r#"{"domain":"demo","since":"2026-10-31"}"#)?.keeps(&n));
        assert!(!query(r#"{"domain":"demo","since":"2026-11-02"}"#)?.keeps(&n));
        assert!(query(r#"{"domain":"demo","since":"soon"}"#).is_err());
        assert!(query(r#"{"domain":"demo","limit":0}"#).is_err());
        assert_eq!(
            query(r#"{"domain":"demo","limit":100000}"#)?.limit,
            MAX_LIST as usize
        );
        assert!(query(r#"{"domain":"demo","status":"draft"}"#)?.matches_nothing());
        Ok(())
    }

    #[test]
    fn links_list_both_directions() {
        let a = note("demo", "a", &[], None);
        let b = note("demo", "b", &[], None);
        let edges = vec![Edge {
            source: a.id,
            target: b.id,
            kind: "related".into(),
            weight: 1.0,
        }];
        let keys: HashMap<Uuid, (&str, &str, &str)> =
            [(a.id, ("demo", "a", "A")), (b.id, ("demo", "b", ""))].into();
        let from_a = links_of(a.id, &edges, &keys);
        assert_eq!(from_a.len(), 1);
        assert_eq!(from_a[0].target_key, "b");
        assert_eq!(from_a[0].relation, "related");
        assert_eq!(from_a[0].target_title, None);
        let from_b = links_of(b.id, &edges, &keys);
        assert_eq!(from_b[0].relation, "linked from");
        assert_eq!(from_b[0].target_title.as_deref(), Some("A"));
        assert_eq!(link_counts(&edges).get(&a.id), Some(&1));
    }

    #[test]
    fn revisions_describe_each_change() {
        let at = Utc::now();
        let entry = |revision, status, title: &str| NoteRevision {
            revision,
            status,
            title: title.into(),
            written_at: at,
        };
        let history = [
            entry(2, Status::Legacy, "B"),
            entry(2, Status::Active, "B"),
            entry(1, Status::Active, "A"),
        ];
        let lines = |shown| -> Vec<String> {
            revisions_of(&history, NoteOrigin::Agent, shown)
                .into_iter()
                .map(|r| r.summary)
                .collect()
        };
        assert_eq!(lines(3), ["Retired", "Renamed to \"B\"", "Saved as \"A\""]);
        // A truncated history never calls its oldest shown entry the first save.
        assert_eq!(lines(2), ["Retired", "Renamed to \"B\""]);
    }
}

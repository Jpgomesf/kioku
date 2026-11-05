//! One OKF concept: its frontmatter read by the spec's rules, and the facts
//! line that opens each of its notes.

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::Value;

use crate::markdown;
use crate::text::truncate_chars;

/// Frontmatter keys Kioku reads into fields of its own, so the facts line
/// doesn't repeat them. Other keys with plain values are listed on it.
const READ_KEYS: &[&str] = &[
    "type",
    "id",
    "title",
    "description",
    "tags",
    "aliases",
    "status",
    "verified",
    "stale_after",
    "generated",
    "timestamp",
    "resource",
    "sources",
    "usage_window",
    "lock",
    "pinned",
    "okf_version",
];
/// The longest value the facts line shows for one field.
const FIELD_CHARS: usize = 160;
/// The facts line stops listing fields past this many bytes.
const FACTS_BYTES: usize = 640;

/// A concept's lifecycle, from `status` (absent means stable).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Lifecycle {
    Draft,
    Stable,
    Deprecated,
}

/// The trust tier the spec derives from `verified`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Trust {
    Unverified,
    MachineConfirmed,
    HumanReviewed { by: String, at: Option<String> },
}

impl Trust {
    fn label(&self) -> String {
        match self {
            Trust::Unverified => "unverified".into(),
            Trust::MachineConfirmed => "machine-confirmed".into(),
            Trust::HumanReviewed { by, at } => match at {
                Some(at) => format!("human-reviewed by {by} on {}", day(at)),
                None => format!("human-reviewed by {by}"),
            },
        }
    }
}

#[derive(Clone, Debug)]
pub(super) struct Concept {
    /// Path in the bundle, with `/` separators and the `.md` suffix.
    pub path: String,
    /// The spec's concept ID: `path` without `.md`. Also the note key.
    pub id: String,
    pub kind: String,
    pub title: String,
    pub description: Option<String>,
    /// A producer's own identifier (`id` in frontmatter), such as `DEC-350`.
    pub producer_id: Option<String>,
    pub aliases: Vec<String>,
    pub tags: Vec<String>,
    pub lifecycle: Lifecycle,
    pub trust: Trust,
    pub stale_after: Option<String>,
    /// `generated.by` and `generated.at`, or a v0.1 `timestamp`.
    pub written: Option<(Option<String>, Option<String>)>,
    pub resource: Option<String>,
    /// Other frontmatter fields with plain values, in file order.
    pub fields: Vec<(String, String)>,
    pub lock: Vec<String>,
    /// Kioku's `pinned: true`: the concept's notes never age into legacy.
    pub pinned: bool,
    pub body: String,
}

impl Concept {
    pub fn deprecated(&self) -> bool {
        self.lifecycle == Lifecycle::Deprecated
    }

    /// Kioku's confidence for the concept's notes, from its trust tier.
    pub fn confidence(&self) -> f64 {
        let trusted: f64 = match self.trust {
            Trust::HumanReviewed { .. } => 0.95,
            Trust::MachineConfirmed => 0.85,
            Trust::Unverified => 0.8,
        };
        if self.lifecycle == Lifecycle::Draft {
            trusted.min(0.6)
        } else {
            trusted
        }
    }

    /// The tag naming the concept's type, such as `decision` or `pull-request`.
    pub fn kind_tag(&self) -> String {
        let mut tag = String::new();
        for c in self.kind.chars().flat_map(char::to_lowercase) {
            if c.is_alphanumeric() {
                tag.push(c);
            } else if !tag.ends_with('-') {
                tag.push('-');
            }
        }
        tag.trim_matches('-').to_owned()
    }

    fn named_kind(&self) -> String {
        match &self.producer_id {
            Some(id) => format!("{} {id}", self.kind),
            None => self.kind.clone(),
        }
    }

    fn lifecycle_parts(&self) -> Vec<String> {
        let mut parts = Vec::new();
        match self.lifecycle {
            Lifecycle::Deprecated => parts.push("deprecated".to_owned()),
            Lifecycle::Draft => parts.push("draft".to_owned()),
            Lifecycle::Stable => {}
        }
        parts.push(self.trust.label());
        if let Some(stale) = &self.stale_after {
            parts.push(format!("re-read after {}", day(stale)));
        }
        parts
    }

    /// The first line of the concept's own note (or hub): its type and id,
    /// lifecycle, trust, the producer's plain fields, who wrote it, and the
    /// resource it describes.
    pub fn facts(&self) -> String {
        let mut line = self.named_kind();
        for part in self.lifecycle_parts() {
            line.push_str(" · ");
            line.push_str(&part);
        }
        let mut omitted = false;
        for (key, value) in &self.fields {
            let part = format!(" · {}: {value}", key.replace('_', " "));
            if line.len() + part.len() > FACTS_BYTES {
                omitted = true;
                continue;
            }
            line.push_str(&part);
        }
        if omitted {
            line.push_str(" · …");
        }
        if let Some((by, at)) = &self.written {
            let mut part = String::from(" · written");
            if let Some(by) = by {
                part.push_str(&format!(" by {by}"));
            }
            if let Some(at) = at {
                part.push_str(&format!(" on {}", day(at)));
            }
            line.push_str(&part);
        }
        if let Some(resource) = &self.resource {
            line.push_str(&format!(" · {}", truncate_chars(resource, 200)));
        }
        line
    }

    /// The first line of each section note: what it is a section of.
    pub fn section_facts(&self) -> String {
        let mut line = format!("{} · section of {}", self.named_kind(), self.id);
        for part in self.lifecycle_parts() {
            line.push_str(" · ");
            line.push_str(&part);
        }
        line
    }

    /// The description, unless the body already opens with it.
    pub fn description_unless_repeated(&self) -> Option<&str> {
        let description = self.description.as_deref()?;
        let probe: String = description.chars().take(60).collect();
        let opening: String = self.body.chars().take(400).collect();
        (!normalized(&opening).contains(&normalized(&probe))).then_some(description)
    }
}

fn normalized(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// The date part of an ISO 8601 datetime, or the text as written.
fn day(value: &str) -> &str {
    value
        .get(..10)
        .filter(|d| d.as_bytes().get(4) == Some(&b'-') && d.as_bytes().get(7) == Some(&b'-'))
        .unwrap_or(value)
}

/// Read one concept file. `path` is its bundle path with `/` separators.
pub(super) fn parse(path: &str, text: &str) -> Result<Concept> {
    let normalized = text.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let (yaml, body) = markdown::frontmatter(&normalized)?;
    let (pairs, lock) = match yaml {
        Some(yaml) if !yaml.trim().is_empty() => {
            let Ordered(pairs) = serde_saphyr::from_str_with_options(
                yaml,
                serde_saphyr::options! { strict_booleans: true },
            )
            .context("invalid YAML frontmatter")?;
            (pairs, markdown::frontmatter_lock(yaml)?)
        }
        _ => (Vec::new(), Vec::new()),
    };
    let get = |key: &str| pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v);
    let id = path.strip_suffix(".md").unwrap_or(path).to_owned();
    let stem = id.rsplit('/').next().unwrap_or(&id).to_owned();
    let body = body.trim().to_owned();

    let kind = get("type")
        .and_then(scalar)
        .unwrap_or_else(|| "Concept".into());
    let title = get("title")
        .and_then(scalar)
        .or_else(|| markdown::first_heading(&body))
        .unwrap_or(stem);
    let lifecycle = match get("status").and_then(scalar).as_deref() {
        Some("deprecated") => Lifecycle::Deprecated,
        Some("draft") => Lifecycle::Draft,
        _ => Lifecycle::Stable,
    };
    let written = match get("generated") {
        Some(Value::Object(generated)) => Some((
            generated.get("by").and_then(scalar),
            generated.get("at").and_then(scalar),
        )),
        _ => get("timestamp").and_then(scalar).map(|at| (None, Some(at))),
    };
    let fields = pairs
        .iter()
        .filter(|(key, _)| !READ_KEYS.contains(&key.as_str()))
        .filter_map(|(key, value)| {
            plain(value).map(|v| (key.clone(), truncate_chars(&v, FIELD_CHARS)))
        })
        .collect();

    Ok(Concept {
        path: path.to_owned(),
        id,
        kind,
        title,
        description: get("description").and_then(scalar),
        producer_id: get("id").and_then(scalar),
        aliases: get("aliases").map(list).unwrap_or_default(),
        tags: get("tags").map(list).unwrap_or_default(),
        lifecycle,
        trust: trust(get("verified")),
        stale_after: get("stale_after").and_then(scalar),
        written,
        resource: get("resource").and_then(scalar),
        fields,
        lock,
        pinned: matches!(get("pinned"), Some(Value::Bool(true))),
        body,
    })
}

/// The tier `verified` gives: a bare mapping counts as a one-element list,
/// and a `human:` actor anywhere makes the concept human-reviewed (the
/// latest such review is shown).
fn trust(verified: Option<&Value>) -> Trust {
    let events: Vec<&serde_json::Map<String, Value>> = match verified {
        Some(Value::Object(one)) => vec![one],
        Some(Value::Array(many)) => many.iter().filter_map(Value::as_object).collect(),
        _ => Vec::new(),
    };
    if events.is_empty() {
        return Trust::Unverified;
    }
    let human = events
        .iter()
        .filter_map(|event| {
            let by = event.get("by").and_then(scalar)?;
            by.starts_with("human:")
                .then(|| (by, event.get("at").and_then(scalar)))
        })
        .max_by(|a, b| a.1.cmp(&b.1));
    match human {
        Some((by, at)) => Trust::HumanReviewed { by, at },
        None => Trust::MachineConfirmed,
    }
}

/// A plain value as text: a scalar, a list of scalars, or a mapping's
/// `resource` (how OKF points at code, for example `executor.resource`).
/// A list of mappings shows their `name`s, as for `parameters`.
fn plain(value: &Value) -> Option<String> {
    match value {
        Value::Array(items) => {
            let names: Vec<String> = items
                .iter()
                .filter_map(|item| match item {
                    Value::Object(map) => map.get("name").and_then(scalar),
                    other => scalar(other),
                })
                .collect();
            (!names.is_empty()).then(|| names.join(", "))
        }
        Value::Object(map) => map.get("resource").and_then(scalar),
        other => scalar(other),
    }
}

fn scalar(value: &Value) -> Option<String> {
    let text = match value {
        Value::String(s) => s.trim().to_owned(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => return None,
    };
    (!text.is_empty()).then_some(text)
}

fn list(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => items.iter().filter_map(scalar).collect(),
        other => scalar(other).into_iter().collect(),
    }
}

/// A YAML mapping's entries in file order; keys that aren't text are skipped.
struct Ordered(Vec<(String, Value)>);

impl<'de> Deserialize<'de> for Ordered {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct OrderedVisitor;

        impl<'de> serde::de::Visitor<'de> for OrderedVisitor {
            type Value = Ordered;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a mapping")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Ordered, A::Error> {
                let mut pairs = Vec::new();
                while let Some(key) = map.next_key::<Value>()? {
                    let value: Value = map.next_value()?;
                    if let Some(key) = scalar(&key) {
                        pairs.push((key, value));
                    }
                }
                Ok(Ordered(pairs))
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Ordered, E> {
                Ok(Ordered(Vec::new()))
            }
        }

        deserializer.deserialize_map(OrderedVisitor)
    }
}

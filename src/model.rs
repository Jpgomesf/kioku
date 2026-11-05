use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

fn default_domain() -> String {
    "local".into()
}
fn default_confidence() -> f64 {
    0.8
}

/// A small, independently useful memory. Related entries resolve by key, title, or alias within its domain.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct NoteInput {
    #[serde(default = "default_domain")]
    pub domain: String,
    pub key: String,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub related: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default = "default_confidence")]
    pub confidence: f64,
    #[serde(default)]
    pub pinned: bool,
    /// Model providers that may read this note (frontmatter `lock`), enforced
    /// only with a vaults file. Empty means the note has no lock of its own.
    /// Left out of the stored JSON when empty, so older notes are unchanged.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lock: Vec<String>,
}

impl NoteInput {
    pub fn id(&self) -> Uuid {
        Self::id_for(&self.domain, &self.key)
    }

    /// Stable identity for a domain and key. The namespace string is part of
    /// every stored id, so it must never change.
    pub fn id_for(domain: &str, key: &str) -> Uuid {
        let mut identity = String::from("[\"local-memory-v1\",");
        identity.push_str(&serde_json::Value::from(domain).to_string());
        identity.push(',');
        identity.push_str(&serde_json::Value::from(key).to_string());
        identity.push(']');
        Uuid::new_v5(&Uuid::NAMESPACE_URL, identity.as_bytes())
    }
    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            !self.domain.trim().is_empty() && self.domain.len() <= 128,
            "domain must contain 1–128 bytes"
        );
        anyhow::ensure!(
            !self.key.trim().is_empty() && self.key.len() <= 256,
            "key must contain 1–256 bytes"
        );
        anyhow::ensure!(
            !self.title.trim().is_empty() && self.title.len() <= 512,
            "title must contain 1–512 bytes"
        );
        anyhow::ensure!(
            !self.body.trim().is_empty() && self.body.len() <= 24_000,
            "body must contain 1–24000 bytes; split larger documents into focused notes"
        );
        anyhow::ensure!(
            self.confidence.is_finite() && (0.0..=1.0).contains(&self.confidence),
            "confidence must be between 0 and 1"
        );
        anyhow::ensure!(
            self.aliases.len() <= 64 && self.related.len() <= 128 && self.tags.len() <= 64,
            "too many aliases, relationships, or tags"
        );
        anyhow::ensure!(
            self.aliases
                .iter()
                .chain(&self.related)
                .chain(&self.tags)
                .all(|s| !s.trim().is_empty() && s.len() <= 512),
            "aliases, related entries, and tags must contain 1–512 bytes"
        );
        anyhow::ensure!(
            self.source.as_ref().is_none_or(|s| s.len() <= 2048),
            "source is too long"
        );
        anyhow::ensure!(
            self.lock
                .iter()
                .all(|name| crate::vault::Provider::parse(name)
                    .is_ok_and(|provider| provider.as_str() == name)),
            "lock must list model providers in lowercase: {}",
            crate::vault::Provider::names()
        );
        // PostgreSQL jsonb rejects NUL, and other control characters are never intended.
        let fields = [&self.domain, &self.key, &self.title, &self.body]
            .into_iter()
            .chain(&self.aliases)
            .chain(&self.related)
            .chain(&self.tags)
            .chain(self.source.as_ref());
        for field in fields {
            anyhow::ensure!(
                !field
                    .chars()
                    .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t')),
                "text must not contain control characters such as NUL"
            );
        }
        Ok(())
    }
}

/// Lifecycle state. Legacy notes are kept for history and excluded from
/// default retrieval; nothing is ever hard-deleted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Active,
    Legacy,
}

impl Status {
    pub fn is_active(&self) -> bool {
        *self == Self::Active
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Legacy => "legacy",
        }
    }
}

impl std::fmt::Display for Status {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for Status {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> anyhow::Result<Self> {
        match value {
            "active" => Ok(Self::Active),
            "legacy" => Ok(Self::Legacy),
            other => anyhow::bail!("unknown memory status {other:?}"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: Uuid,
    pub input: NoteInput,
    pub status: Status,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub last_accessed_at: Option<DateTime<Utc>>,
    pub access_count: i64,
    pub positive_feedback: i64,
    pub negative_feedback: i64,
    pub retention_score: f64,
    pub last_decay_at: DateTime<Utc>,
    pub vector_synced: bool,
    pub revision: i64,
}

/// One entry of a note's append-only history: what a write left behind.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NoteRevision {
    /// The note's content revision. A status change keeps the revision.
    pub revision: i64,
    pub status: Status,
    pub title: String,
    pub written_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Edge {
    pub source: Uuid,
    pub target: Uuid,
    pub kind: String,
    pub weight: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VectorHit {
    pub id: Uuid,
    pub score: f64,
    pub revision: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn domain_key_identity_is_unambiguous() {
        let mut input = NoteInput {
            domain: "a:b".into(),
            key: "c".into(),
            title: "Test".into(),
            body: "Test body".into(),
            aliases: vec![],
            related: vec![],
            tags: vec![],
            source: None,
            confidence: 0.8,
            pinned: false,
            lock: vec![],
        };
        let first = input.id();
        input.domain = "a".into();
        input.key = "b:c".into();
        assert_ne!(first, input.id());
    }

    #[test]
    fn notes_without_a_lock_serialize_as_before() {
        let mut input: NoteInput = serde_json::from_value(serde_json::json!({
            "domain": "d", "key": "k", "title": "T", "body": "B"
        }))
        .unwrap();
        assert!(input.lock.is_empty());
        assert!(serde_json::to_value(&input).unwrap().get("lock").is_none());
        assert!(input.validate().is_ok());
        input.lock = vec!["local".into()];
        assert_eq!(serde_json::to_value(&input).unwrap()["lock"][0], "local");
        assert!(input.validate().is_ok());
        input.lock = vec!["Local".into()];
        assert!(input.validate().is_err(), "not normalized");
        input.lock = vec!["gpt".into()];
        assert!(input.validate().is_err(), "unknown provider");
    }

    #[test]
    fn identity_matches_the_original_tuple_encoding() {
        // Stored ids were derived from serde_json's encoding of this tuple.
        for (domain, key) in [
            ("local", "memory-stack"),
            ("demo", "jobs-worker"),
            ("pt", "ação \"x\""),
        ] {
            let original = serde_json::to_vec(&("local-memory-v1", domain, key)).unwrap();
            assert_eq!(
                NoteInput::id_for(domain, key),
                Uuid::new_v5(&Uuid::NAMESPACE_URL, &original)
            );
        }
    }
}

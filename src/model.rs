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
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
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
}

impl NoteInput {
    pub fn id(&self) -> Uuid {
        let identity = serde_json::to_vec(&("local-memory-v1", &self.domain, &self.key))
            .expect("strings serialize");
        Uuid::new_v5(&Uuid::NAMESPACE_URL, &identity)
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
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: Uuid,
    pub input: NoteInput,
    pub status: String,
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
        };
        let first = input.id();
        input.domain = "a".into();
        input.key = "b:c".into();
        assert_ne!(first, input.id());
    }
}

//! Resolving human-readable keys to notes, with suggestions for near misses.

use uuid::Uuid;

use crate::error::UserError;
use crate::graph;
use crate::model::NoteInput;

use super::MemoryServer;

/// Outcome of resolving a user-supplied key.
pub(super) enum Resolved {
    Found(Uuid),
    Missing(Vec<String>),
    Ambiguous,
}

impl MemoryServer {
    /// Show file-backed sources relative to the notes folder.
    pub(super) fn display_source(&self, source: Option<&str>) -> Option<String> {
        let source = source?;
        let relative = self
            .app
            .config
            .notes_root
            .as_ref()
            .and_then(|root| std::path::Path::new(source).strip_prefix(root).ok())
            .map(|path| path.to_string_lossy().into_owned());
        Some(relative.unwrap_or_else(|| source.to_owned()))
    }

    /// Find the memory a key refers to: an exact key, then an id, then a unique
    /// case-insensitive key, title, or alias.
    pub(super) async fn resolve(&self, domain: &str, reference: &str) -> anyhow::Result<Resolved> {
        let reference = reference.trim();
        let by_key = NoteInput::id_for(domain, reference);
        if self.app.store.get(by_key).await?.is_some() {
            return Ok(Resolved::Found(by_key));
        }
        if let Ok(id) = Uuid::parse_str(reference) {
            return Ok(match self.app.store.get(id).await? {
                Some(note) if note.input.domain == domain => Resolved::Found(id),
                _ => Resolved::Missing(Vec::new()),
            });
        }
        let notes = self.app.store.notes(Some(domain), true).await?;
        match graph::resolve_reference(&notes, domain, reference) {
            Ok(id) => Ok(Resolved::Found(id)),
            Err("ambiguous") => Ok(Resolved::Ambiguous),
            Err(_) => {
                let keys = self.app.store.keys(domain).await?;
                Ok(Resolved::Missing(suggest(reference, &keys)))
            }
        }
    }

    /// Resolve one key or fail with suggestions and a copyable search.
    pub(super) async fn resolve_one(
        &self,
        tool: &str,
        domain: &str,
        key: &str,
    ) -> anyhow::Result<Uuid> {
        match self.resolve(domain, key).await? {
            Resolved::Found(id) => Ok(id),
            Resolved::Ambiguous => Err(UserError::NotFound(format!(
                "{key:?} matches several memories in domain {domain:?}; pass the exact key from memory_search"
            ))
            .into()),
            Resolved::Missing(suggestions) => {
                let hint = if suggestions.is_empty() {
                    String::new()
                } else {
                    format!(" Did you mean {}?", suggestions.join(", "))
                };
                Err(UserError::NotFound(format!(
                    "{tool}: no memory {key:?} in domain {domain:?}.{hint} Find keys with memory_search {{\"query\":{key:?},\"domain\":{domain:?}}}"
                ))
                .into())
            }
        }
    }
}

/// Up to three keys that look like `wanted`.
pub(super) fn suggest(wanted: &str, keys: &[String]) -> Vec<String> {
    let wanted = wanted.to_lowercase();
    let mut scored: Vec<(usize, &String)> = keys
        .iter()
        .map(|key| {
            let lower = key.to_lowercase();
            let distance = levenshtein(&wanted, &lower);
            let bonus = if lower.starts_with(&wanted)
                || wanted.starts_with(&lower)
                || lower.contains(&wanted)
            {
                0
            } else {
                2
            };
            (distance + bonus, key)
        })
        .filter(|(score, key)| *score <= 3.max(key.len() / 3))
        .collect();
    scored.sort();
    scored
        .into_iter()
        .take(3)
        .map(|(_, key)| format!("{key:?}"))
        .collect()
}

pub(super) fn levenshtein(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut current = vec![i + 1; b.len() + 1];
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != *cb);
            current[j + 1] = (previous[j + 1] + 1)
                .min(current[j] + 1)
                .min(previous[j] + cost);
        }
        previous = current;
    }
    previous[b.len()]
}

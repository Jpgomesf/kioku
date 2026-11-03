//! Note parsing, explicit relationship resolution, graph propagation, and
//! retention.
//!
//! Note text is evidence, never executable instructions. Aliases identify a note;
//! they do not silently merge notes or create claims about relationships.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::model::{Edge, Note, NoteInput, Status};

/// Frontmatter fields Kioku reads. Other fields (Obsidian dates, CSS classes,
/// and so on) are ignored. Plain YAML scalars such as `2024` are accepted as
/// strings; booleans must be `true` or `false`.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct Frontmatter {
    key: Option<String>,
    id: Option<String>,
    title: Option<String>,
    domain: Option<String>,
    aliases: Option<OneOrMany>,
    alias: Option<OneOrMany>,
    related: Option<OneOrMany>,
    tags: Option<OneOrMany>,
    confidence: Option<f64>,
    pinned: Option<bool>,
}

/// A frontmatter list that may also be written as a single value. Plain
/// scalars (`2024`, `true`) are kept as text.
#[derive(Debug)]
struct OneOrMany(Vec<String>);

impl OneOrMany {
    fn into_vec(self) -> Vec<String> {
        self.0
    }
}

/// One scalar written as text.
struct Scalar(String);

struct ScalarVisitor;

impl<'de> serde::de::Visitor<'de> for ScalarVisitor {
    type Value = String;

    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("a string (quote [[wiki links]] inside lists)")
    }
    fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<String, E> {
        Ok(v.to_owned())
    }
    fn visit_string<E: serde::de::Error>(self, v: String) -> Result<String, E> {
        Ok(v)
    }
    fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<String, E> {
        Ok(v.to_string())
    }
    fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<String, E> {
        Ok(v.to_string())
    }
    fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<String, E> {
        Ok(v.to_string())
    }
    fn visit_bool<E: serde::de::Error>(self, v: bool) -> Result<String, E> {
        Ok(v.to_string())
    }
}

impl<'de> Deserialize<'de> for Scalar {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(ScalarVisitor).map(Scalar)
    }
}

impl<'de> Deserialize<'de> for OneOrMany {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ListVisitor;

        impl<'de> serde::de::Visitor<'de> for ListVisitor {
            type Value = OneOrMany;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a string or a list of strings")
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> Result<OneOrMany, A::Error> {
                let mut values = Vec::new();
                while let Some(Scalar(value)) = seq.next_element()? {
                    values.push(value);
                }
                Ok(OneOrMany(values))
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<OneOrMany, E> {
                Ok(OneOrMany(Vec::new()))
            }
            fn visit_none<E: serde::de::Error>(self) -> Result<OneOrMany, E> {
                Ok(OneOrMany(Vec::new()))
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<OneOrMany, E> {
                ScalarVisitor.visit_str(v).map(|s| OneOrMany(vec![s]))
            }
            fn visit_string<E: serde::de::Error>(self, v: String) -> Result<OneOrMany, E> {
                Ok(OneOrMany(vec![v]))
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<OneOrMany, E> {
                Ok(OneOrMany(vec![v.to_string()]))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<OneOrMany, E> {
                Ok(OneOrMany(vec![v.to_string()]))
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<OneOrMany, E> {
                Ok(OneOrMany(vec![v.to_string()]))
            }
            fn visit_bool<E: serde::de::Error>(self, v: bool) -> Result<OneOrMany, E> {
                Ok(OneOrMany(vec![v.to_string()]))
            }
        }

        deserializer.deserialize_any(ListVisitor)
    }
}

fn list(values: Option<OneOrMany>) -> Vec<String> {
    values
        .map(OneOrMany::into_vec)
        .unwrap_or_default()
        .into_iter()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .collect()
}

fn text(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

/// Parse one focused Markdown note. The actual import location supplies provenance.
/// Frontmatter `id` is accepted as a stable textual key, not a database UUID override.
pub fn parse_markdown(text_in: &str, source: &str, default_domain: &str) -> Result<NoteInput> {
    // A BOM and Windows line endings should not prevent frontmatter recognition.
    let normalized = text_in.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let (frontmatter, body) = split_frontmatter(&normalized)?;
    let meta: Frontmatter = match frontmatter {
        Some(yaml) if !yaml.trim().is_empty() => serde_saphyr::from_str_with_options(
            yaml,
            serde_saphyr::options! { strict_booleans: true },
        )
        .context("invalid YAML frontmatter (quote [[wiki links]] inside lists, for example related: ['[[Note]]'])")?,
        _ => Frontmatter::default(),
    };

    let fallback_key = Path::new(source)
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("note");
    let key = text(meta.key)
        .or(text(meta.id))
        .unwrap_or_else(|| fallback_key.to_owned());
    let title = text(meta.title)
        .or_else(|| first_heading(body))
        .unwrap_or_else(|| key.clone());
    let mut aliases = list(meta.aliases);
    aliases.extend(list(meta.alias));
    let note = NoteInput {
        domain: text(meta.domain).unwrap_or_else(|| default_domain.to_owned()),
        key,
        title,
        body: body.trim().to_owned(),
        aliases: deduplicate_strings(aliases),
        related: deduplicate_strings(list(meta.related)),
        tags: deduplicate_strings(list(meta.tags)),
        source: Some(source.to_owned()),
        confidence: meta.confidence.unwrap_or(0.8),
        pinned: meta.pinned.unwrap_or(false),
    };
    note.validate()?;
    Ok(note)
}

/// The first `# ` heading outside fenced code blocks.
fn first_heading(body: &str) -> Option<String> {
    let mut fence: Option<&str> = None;
    for line in body.lines() {
        let trimmed = line.trim_start();
        if let Some(open) = fence {
            if trimmed.starts_with(open) {
                fence = None;
            }
            continue;
        }
        if trimmed.starts_with("```") {
            fence = Some("```");
            continue;
        }
        if trimmed.starts_with("~~~") {
            fence = Some("~~~");
            continue;
        }
        if let Some(heading) = line.strip_prefix("# ") {
            let heading = heading.trim().trim_end_matches('#').trim();
            if !heading.is_empty() {
                return Some(heading.to_owned());
            }
        }
    }
    None
}

/// Split `---` frontmatter from the body. The delimiters must start at the
/// beginning of a line, so indented `---` inside a YAML block scalar is content.
fn split_frontmatter(text: &str) -> Result<(Option<&str>, &str)> {
    let Some(first_newline) = text.find('\n') else {
        if text.trim() == "---" {
            bail!("frontmatter is missing its closing --- delimiter");
        }
        return Ok((None, text));
    };
    if text[..first_newline].trim_end() != "---" {
        return Ok((None, text));
    }
    let yaml_start = first_newline + 1;
    let mut offset = yaml_start;
    for line in text[yaml_start..].split_inclusive('\n') {
        let marker = line.trim_end();
        if marker == "---" || marker == "..." {
            return Ok((
                Some(&text[yaml_start..offset]),
                &text[offset + line.len()..],
            ));
        }
        offset += line.len();
    }
    bail!("frontmatter is missing its closing --- delimiter")
}

fn deduplicate_strings(values: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.to_lowercase()))
        .collect()
}

/// Normalize a reference or label for matching. Obsidian `[[Note#Heading|label]]`
/// syntax is understood only inside double brackets, so plain names such as
/// `C# Tips` or `Issue #123` keep their meaning.
fn normalized_reference(value: &str) -> String {
    let value = value.trim();
    let value = match value
        .strip_prefix("[[")
        .and_then(|inner| inner.strip_suffix("]]"))
    {
        Some(inner) => {
            let inner = inner.split('|').next().unwrap_or(inner);
            inner.split('#').next().unwrap_or(inner)
        }
        None => value,
    };
    let value = value.trim();
    value
        .strip_suffix(".md")
        .unwrap_or(value)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct UnresolvedRelation {
    pub source: Uuid,
    pub reference: String,
    pub reason: String,
}

/// Labels by which notes can be referenced within one domain, in precedence
/// order: an exact key wins over a title, and a title over an alias. Active
/// notes own a label before legacy ones.
#[derive(Default)]
struct LabelIndex {
    keys: HashMap<(String, String), BTreeSet<(bool, Uuid)>>,
    titles: HashMap<(String, String), BTreeSet<(bool, Uuid)>>,
    aliases: HashMap<(String, String), BTreeSet<(bool, Uuid)>>,
    ids: HashMap<(String, String), Uuid>,
}

impl LabelIndex {
    fn build(notes: &[Note]) -> Self {
        let mut index = Self::default();
        for note in notes {
            let domain = &note.input.domain;
            // `false` sorts before `true`, so legacy = true sorts active notes first.
            let entry = (note.status == Status::Legacy, note.id);
            let add = |map: &mut HashMap<(String, String), BTreeSet<(bool, Uuid)>>, label: &str| {
                let normalized = normalized_reference(label);
                if !normalized.is_empty() {
                    map.entry((domain.clone(), normalized))
                        .or_default()
                        .insert(entry);
                }
            };
            add(&mut index.keys, &note.input.key);
            add(&mut index.titles, &note.input.title);
            for alias in &note.input.aliases {
                add(&mut index.aliases, alias);
            }
            index
                .ids
                .insert((domain.clone(), note.id.to_string()), note.id);
        }
        index
    }

    /// Resolve a reference to exactly one note, or explain why not.
    fn resolve(&self, domain: &str, reference: &str) -> Result<Uuid, &'static str> {
        let key = (domain.to_owned(), normalized_reference(reference));
        if let Some(id) = self.ids.get(&key) {
            return Ok(*id);
        }
        for map in [&self.keys, &self.titles, &self.aliases] {
            if let Some(candidates) = map.get(&key) {
                let active: Vec<Uuid> = candidates
                    .iter()
                    .filter(|(legacy, _)| !legacy)
                    .map(|(_, id)| *id)
                    .collect();
                let pool: Vec<Uuid> = if active.is_empty() {
                    candidates.iter().map(|(_, id)| *id).collect()
                } else {
                    active
                };
                return match pool.as_slice() {
                    [only] => Ok(*only),
                    _ => Err("ambiguous"),
                };
            }
        }
        Err("not_found")
    }
}

/// Resolve a key, title, alias, wiki link, or id to one note of `domain`,
/// with the same rules that resolve `related` links.
pub fn resolve_reference(
    notes: &[Note],
    domain: &str,
    reference: &str,
) -> Result<Uuid, &'static str> {
    LabelIndex::build(notes).resolve(domain, reference)
}

/// Return explicit edges and diagnostics for references that cannot safely resolve.
/// Only same-domain matches are eligible, including when the reference is a UUID.
pub fn resolve_edges_with_report(notes: &[Note]) -> (Vec<Edge>, Vec<UnresolvedRelation>) {
    let index = LabelIndex::build(notes);
    let mut edges = BTreeMap::new();
    let mut unresolved = Vec::new();
    for note in notes {
        for reference in &note.input.related {
            match index.resolve(&note.input.domain, reference) {
                Ok(target) if target != note.id => {
                    edges.entry((note.id, target)).or_insert_with(|| Edge {
                        source: note.id,
                        target,
                        kind: "related".to_owned(),
                        weight: 1.0,
                    });
                }
                Ok(_) => {}
                Err(reason) => unresolved.push(UnresolvedRelation {
                    source: note.id,
                    reference: reference.clone(),
                    reason: reason.to_owned(),
                }),
            }
        }
    }
    unresolved.sort_by(|a, b| (a.source, &a.reference).cmp(&(b.source, &b.reference)));
    (edges.into_values().collect(), unresolved)
}

pub fn resolve_edges(notes: &[Note]) -> Vec<Edge> {
    resolve_edges_with_report(notes).0
}

/// Query-personalized PageRank over explicit relationships, traversed in both
/// directions. `restart` is the probability of jumping back to the seeds at
/// each step: higher values keep the mass near the seeds. This measures
/// closeness to the query's matches; it does not age or delete memories.
/// Dangling mass returns to the seed distribution.
pub fn personalized_pagerank(
    notes: &[Note],
    edges: &[Edge],
    seeds: &HashMap<Uuid, f64>,
    restart: f64,
) -> HashMap<Uuid, f64> {
    if notes.is_empty() {
        return HashMap::new();
    }
    let restart = if restart.is_finite() {
        restart.clamp(0.01, 1.0)
    } else {
        0.5
    };
    let walk = 1.0 - restart;
    let mut note_by_id = BTreeMap::new();
    for note in notes {
        note_by_id.insert(note.id, note);
    }
    let ids: Vec<_> = note_by_id.keys().copied().collect();
    let indexes: HashMap<_, _> = ids.iter().enumerate().map(|(i, id)| (*id, i)).collect();
    let n = ids.len();
    let mut personalization = vec![0.0; n];
    for (id, value) in seeds {
        if let Some(&i) = indexes.get(id)
            && value.is_finite()
            && *value > 0.0
        {
            personalization[i] = *value;
        }
    }
    // Scale before summing so finite but very large user values cannot overflow.
    let max_seed = personalization.iter().copied().fold(0.0, f64::max);
    if max_seed > 0.0 {
        for value in &mut personalization {
            *value /= max_seed;
        }
        let sum: f64 = personalization.iter().sum();
        for value in &mut personalization {
            *value /= sum;
        }
    } else {
        personalization.fill(1.0 / n as f64);
    }

    let mut adjacency: Vec<BTreeMap<usize, f64>> = vec![BTreeMap::new(); n];
    for edge in edges {
        let (Some(&source), Some(&target)) = (indexes.get(&edge.source), indexes.get(&edge.target))
        else {
            continue;
        };
        if source == target || !edge.weight.is_finite() || edge.weight <= 0.0 {
            continue;
        }
        if note_by_id[&edge.source].input.domain != note_by_id[&edge.target].input.domain {
            continue;
        }
        // A pair linked in both directions is one navigable relationship, not
        // two accidental boosts. Cap extremely large supplied weights as well.
        let weight = edge.weight.min(1_000_000.0);
        for (from, to) in [(source, target), (target, source)] {
            adjacency[from]
                .entry(to)
                .and_modify(|existing| *existing = existing.max(weight))
                .or_insert(weight);
        }
    }
    let totals: Vec<f64> = adjacency
        .iter()
        .map(|neighbors| neighbors.values().sum())
        .collect();
    let mut scores = personalization.clone();
    for _ in 0..200 {
        let mut next: Vec<f64> = personalization
            .iter()
            .map(|value| restart * value)
            .collect();
        let mut dangling = 0.0;
        for (i, neighbors) in adjacency.iter().enumerate() {
            if totals[i] == 0.0 {
                dangling += scores[i];
            } else {
                for (neighbor, weight) in neighbors {
                    next[*neighbor] += walk * scores[i] * weight / totals[i];
                }
            }
        }
        for (value, seed) in next.iter_mut().zip(&personalization) {
            *value += walk * dangling * seed;
        }
        let difference: f64 = next.iter().zip(&scores).map(|(a, b)| (a - b).abs()).sum();
        scores = next;
        if difference < 1e-12 {
            break;
        }
    }
    // Remove cumulative floating-point drift so the result remains a probability.
    let sum: f64 = scores.iter().sum();
    ids.into_iter()
        .zip(scores.into_iter().map(|value| value / sum))
        .collect()
}

/// Retention is separate from query PageRank and is recalculated from original
/// timestamps, never compounded on the previously stored retention score.
///
/// score = clamp(confidence × feedback × usage × 2^(-age_months*30/half_life_days)).
/// age_months counts complete 30-day periods since the latest edit or consumption.
/// feedback uses Beta(2,2) smoothing: clamp(2*(positive+2)/(positive+negative+4), .1, 1.5).
/// Usage contributes at most 15%, saturating with 20 consumed accesses. Search
/// previews should not be counted as consumption by the caller. Pinned notes have
/// retention 1, which protects their presence without asserting factual certainty.
pub fn retention(note: &Note, now: DateTime<Utc>, half_life_days: f64) -> f64 {
    if note.input.pinned {
        return 1.0;
    }
    if !note.input.confidence.is_finite() {
        return 0.0;
    }
    let half_life_days = if half_life_days.is_finite() && half_life_days > 0.0 {
        half_life_days
    } else {
        90.0
    };
    let recent = note
        .last_accessed_at
        .unwrap_or(note.updated_at)
        .max(note.updated_at);
    let age_seconds = now.signed_duration_since(recent).num_seconds().max(0) as f64;
    let age_months = (age_seconds / (30.0 * 86_400.0)).floor();
    let positive = note.positive_feedback.max(0) as f64;
    let negative = note.negative_feedback.max(0) as f64;
    let feedback = (2.0 * (positive + 2.0) / (positive + negative + 4.0)).clamp(0.1, 1.5);
    let accesses = note.access_count.max(0) as f64;
    let usage = 1.0 + 0.15 * accesses / (accesses + 20.0);
    let decay = 2.0_f64.powf(-age_months * 30.0 / half_life_days);
    (note.input.confidence.clamp(0.0, 1.0) * feedback * usage * decay).clamp(0.0, 1.0)
}

/// Truncate by Unicode scalar count, including the ellipsis in the requested cap.
pub fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_owned();
    }
    if max_chars == 0 {
        return String::new();
    }
    let mut result: String = text.chars().take(max_chars - 1).collect();
    result.push('…');
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, TimeZone};

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 28, 12, 0, 0).unwrap()
    }

    fn note(key: &str, domain: &str) -> Note {
        let input = NoteInput {
            domain: domain.to_owned(),
            key: key.to_owned(),
            title: key.to_owned(),
            body: format!("Evidence for {key}"),
            aliases: Vec::new(),
            related: Vec::new(),
            tags: Vec::new(),
            source: None,
            confidence: 0.8,
            pinned: false,
        };
        Note {
            id: input.id(),
            input,
            status: Status::Active,
            created_at: now(),
            updated_at: now(),
            last_accessed_at: None,
            access_count: 0,
            positive_feedback: 0,
            negative_feedback: 0,
            retention_score: 0.8,
            last_decay_at: now(),
            vector_synced: true,
            revision: 1,
        }
    }

    #[test]
    fn parse_portuguese_frontmatter_and_wikilinks() {
        let parsed = parse_markdown(
            "\u{feff}---\r\nid: pagamentos\r\ndomain: demo\r\naliases: [billing, Pagamentos]\r\nalias: billing\r\nrelated: '[[Banco#Esquema|ver banco]]'\r\ntags: produção\r\nconfidence: 0.9\r\npinned: true\r\n---\r\n# Serviço de pagamentos\r\nUsa PostgreSQL.\r\n",
            "docs/billing.md", "local",
        ).unwrap();
        assert_eq!(parsed.key, "pagamentos");
        assert_eq!(parsed.title, "Serviço de pagamentos");
        assert_eq!(parsed.domain, "demo");
        assert_eq!(parsed.aliases, vec!["billing", "Pagamentos"]);
        assert_eq!(parsed.tags, vec!["produção"]);
        assert_eq!(parsed.source.as_deref(), Some("docs/billing.md"));
        assert!(parsed.pinned);
        assert!(parsed.body.contains("Usa PostgreSQL."));
    }

    #[test]
    fn no_frontmatter_uses_filename_and_heading() {
        let parsed = parse_markdown("# Architecture\nText.", "/notes/system.md", "work").unwrap();
        assert_eq!(parsed.key, "system");
        assert_eq!(parsed.title, "Architecture");
        assert_eq!(parsed.domain, "work");
    }

    #[test]
    fn malformed_notes_are_rejected_instead_of_silently_indexed() {
        for text in [
            "---\nkey: broken\n# Missing delimiter",
            "---\naliases: [unfinished\n---\nbody",
            "---\nconfidence: .nan\n---\nbody",
            "---\nconfidence: 2.0\n---\nbody",
            "---\npinned: yes\n---\nbody",
            "---\nrelated: [[unquoted]]\n---\nbody",
            "---\ntitle: empty\n---\n",
        ] {
            assert!(
                parse_markdown(text, "test.md", "local").is_err(),
                "accepted {text:?}"
            );
        }
    }

    #[test]
    fn aliases_resolve_links_without_merging_ambiguous_entities() {
        let mut a = note("checkout", "shop");
        let mut b = note("database", "shop");
        b.input.aliases = vec!["Banco".into()];
        a.input.related = vec!["[[banco#schema|dados]]".into(), "database".into()];
        let (edges, unresolved) = resolve_edges_with_report(&[a.clone(), b.clone()]);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target, b.id);
        assert!(unresolved.is_empty());
        let mut c = note("another-database", "shop");
        c.input.aliases.push("banco".into());
        let (edges, unresolved) = resolve_edges_with_report(&[a, b.clone(), c]);
        assert_eq!(edges.len(), 1); // exact database key still resolves
        assert_eq!(unresolved.len(), 1);
        assert_eq!(unresolved[0].reason, "ambiguous");
    }

    #[test]
    fn plain_yaml_scalars_are_accepted_as_text() {
        let parsed = parse_markdown(
            "---\nkey: release-2024\nid: 20231102\ntitle: 2025\ntags: [rust, 2024]\n---\nBody.",
            "notes/x.md",
            "local",
        )
        .unwrap();
        assert_eq!(parsed.key, "release-2024");
        assert_eq!(parsed.title, "2025");
        assert_eq!(parsed.tags, vec!["rust", "2024"]);
    }

    #[test]
    fn unknown_frontmatter_fields_are_ignored() {
        let parsed = parse_markdown(
            "---\ntitle: T\ncreated: 2026-01-01\ncssclasses: [wide]\n---\nBody.",
            "n.md",
            "local",
        )
        .unwrap();
        assert_eq!(parsed.title, "T");
    }

    #[test]
    fn headings_inside_code_blocks_are_not_titles() {
        let parsed = parse_markdown(
            "```sh\n# install deps first\n```\n# Real title\nText.",
            "n.md",
            "local",
        )
        .unwrap();
        assert_eq!(parsed.title, "Real title");
    }

    #[test]
    fn indented_delimiter_inside_a_block_scalar_does_not_close_frontmatter() {
        let parsed = parse_markdown(
            "---\nkey: k\naliases:\n  - a\nnote: |\n  ---\n  still yaml\ntitle: T\n---\nBody.",
            "n.md",
            "local",
        )
        .unwrap();
        assert_eq!(parsed.title, "T");
        assert_eq!(parsed.body, "Body.");
    }

    #[test]
    fn hash_and_pipe_only_matter_inside_wiki_links() {
        let mut source = note("source", "code");
        let tips = {
            let mut n = note("csharp-tips", "code");
            n.input.title = "C# Tips".into();
            n
        };
        let asynchronous = {
            let mut n = note("csharp-async", "code");
            n.input.title = "C# Async".into();
            n
        };
        // Inside [[...]], `#` starts a heading anchor, as in Obsidian.
        source.input.related = vec![
            "C# Tips".into(),
            "[[csharp-async#Tasks|async notes]]".into(),
        ];
        let (edges, unresolved) =
            resolve_edges_with_report(&[source, tips.clone(), asynchronous.clone()]);
        assert!(unresolved.is_empty(), "{unresolved:?}");
        let targets: Vec<Uuid> = edges.iter().map(|e| e.target).collect();
        assert!(targets.contains(&tips.id) && targets.contains(&asynchronous.id));
    }

    #[test]
    fn keys_win_over_titles_and_active_notes_over_legacy() {
        let mut source = note("source", "d");
        let auth = note("auth", "d");
        let mut titled = note("login-flow", "d");
        titled.input.title = "Auth".into();
        let mut retired = note("old-worker", "d");
        retired.input.title = "Indexing worker".into();
        retired.status = Status::Legacy;
        let mut current = note("jobs-worker", "d");
        current.input.title = "Indexing worker".into();
        source.input.related = vec!["auth".into(), "Indexing worker".into()];
        let notes = [source, auth.clone(), titled, retired, current.clone()];
        let (edges, unresolved) = resolve_edges_with_report(&notes);
        assert!(unresolved.is_empty(), "{unresolved:?}");
        let targets: Vec<Uuid> = edges.iter().map(|e| e.target).collect();
        assert_eq!(targets.len(), 2);
        assert!(targets.contains(&auth.id) && targets.contains(&current.id));
    }

    #[test]
    fn foreign_domain_uuid_and_alias_do_not_create_edges() {
        let mut a = note("source", "a");
        let b = note("target", "b");
        a.input.related = vec!["target".into(), b.id.to_string()];
        assert!(resolve_edges(&[a, b]).is_empty());
    }

    #[test]
    fn pagerank_preserves_mass_and_follows_related_notes() {
        let a = note("seed", "work");
        let b = note("neighbor", "work");
        let c = note("unrelated", "work");
        let edges = vec![Edge {
            source: a.id,
            target: b.id,
            kind: "related".into(),
            weight: 1.0,
        }];
        let scores = personalized_pagerank(
            &[a.clone(), b.clone(), c.clone()],
            &edges,
            &HashMap::from([(a.id, 1.0)]),
            0.15,
        );
        assert!((scores.values().sum::<f64>() - 1.0).abs() < 1e-12);
        assert!(scores[&a.id] > scores[&b.id]);
        assert!(scores[&b.id] > scores[&c.id]);
        assert_eq!(scores[&c.id], 0.0);
    }

    #[test]
    fn pagerank_handles_dangling_nodes_and_bad_external_edges() {
        let a = note("a", "one");
        let b = note("b", "two");
        let edges = vec![Edge {
            source: a.id,
            target: b.id,
            kind: "invalid".into(),
            weight: 1.0,
        }];
        let scores = personalized_pagerank(
            &[a.clone(), b.clone()],
            &edges,
            &HashMap::from([(a.id, 1.0), (b.id, f64::NAN)]),
            0.15,
        );
        assert_eq!(scores[&a.id], 1.0);
        assert_eq!(scores[&b.id], 0.0);
        let uniform = personalized_pagerank(&[a.clone(), b.clone()], &[], &HashMap::new(), 0.15);
        assert_eq!(uniform[&a.id], 0.5);
        assert_eq!(uniform[&b.id], 0.5);
    }

    #[test]
    fn retention_is_monthly_usage_sensitive_and_feedback_bounded() {
        let mut old = note("old", "local");
        old.updated_at = now() - Duration::days(60);
        assert!((retention(&old, now(), 30.0) - 0.2).abs() < 1e-12);
        let mut recent = old.clone();
        recent.last_accessed_at = Some(now());
        assert_eq!(retention(&recent, now(), 30.0), 0.8);
        recent.positive_feedback = 20;
        assert!(retention(&recent, now(), 30.0) > 0.8);
        recent.negative_feedback = 100;
        assert!(retention(&recent, now(), 30.0) < 0.8);
        old.input.pinned = true;
        assert_eq!(retention(&old, now(), 30.0), 1.0);
        recent.positive_feedback = i64::MAX;
        recent.access_count = i64::MAX;
        assert!((0.0..=1.0).contains(&retention(&recent, now(), 30.0)));
    }

    #[test]
    fn retention_does_not_decay_before_first_month_or_compound_previous_score() {
        let mut a = note("a", "local");
        a.updated_at = now() - Duration::days(29);
        a.retention_score = 0.01;
        assert_eq!(retention(&a, now(), 30.0), 0.8);
        a.last_accessed_at = Some(now() + Duration::days(2));
        assert_eq!(retention(&a, now(), 30.0), 0.8);
    }

    #[test]
    fn truncation_is_unicode_safe_and_respects_exact_cap() {
        assert_eq!(truncate_chars("ação 日本語", 5), "ação…");
        assert_eq!(truncate_chars("日本", 1), "…");
        assert_eq!(truncate_chars("日本", 0), "");
        assert_eq!(truncate_chars("ação", 4), "ação");
    }
}

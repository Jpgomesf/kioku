//! Note ingestion, explicit relationship resolution, and graph ranking.
//!
//! Note text is evidence, never executable instructions. Aliases identify a note;
//! they do not silently merge notes or create claims about relationships.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_yaml::{Mapping, Value};
use uuid::Uuid;

use crate::model::{Edge, Note, NoteInput};

/// Parse one focused Markdown note. The actual import location supplies provenance.
/// Frontmatter `id` is accepted as a stable textual key, not a database UUID override.
pub fn parse_markdown(text: &str, source: &str, default_domain: &str) -> Result<NoteInput> {
    // A BOM and Windows line endings should not prevent frontmatter recognition.
    let normalized = text.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let (frontmatter, body) = split_frontmatter(&normalized)?;
    let metadata = match frontmatter {
        Some(yaml) => {
            let value: Value = serde_yaml::from_str(yaml).context("invalid YAML frontmatter")?;
            match value {
                Value::Mapping(map) => map,
                Value::Null => Mapping::new(),
                _ => bail!("frontmatter must be a YAML mapping"),
            }
        }
        None => Mapping::new(),
    };

    let fallback_key = Path::new(source)
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("note");
    let key = string_field(&metadata, "key")?
        .or(string_field(&metadata, "id")?)
        .unwrap_or_else(|| fallback_key.to_owned());
    let title = string_field(&metadata, "title")?
        .or_else(|| {
            body.lines()
                .find_map(|line| line.strip_prefix("# "))
                .map(|line| line.trim().trim_end_matches('#').trim().to_owned())
                .filter(|line| !line.is_empty())
        })
        .unwrap_or_else(|| key.clone());
    let mut aliases = string_list(&metadata, "aliases")?;
    aliases.extend(string_list(&metadata, "alias")?);
    let note = NoteInput {
        domain: string_field(&metadata, "domain")?.unwrap_or_else(|| default_domain.to_owned()),
        key,
        title,
        body: body.trim().to_owned(),
        aliases: deduplicate_strings(aliases),
        related: deduplicate_strings(string_list(&metadata, "related")?),
        tags: deduplicate_strings(string_list(&metadata, "tags")?),
        source: Some(source.to_owned()),
        confidence: number_field(&metadata, "confidence")?.unwrap_or(0.8),
        pinned: bool_field(&metadata, "pinned")?.unwrap_or(false),
    };
    note.validate()?;
    Ok(note)
}

fn split_frontmatter(text: &str) -> Result<(Option<&str>, &str)> {
    let Some(first_newline) = text.find('\n') else {
        if text.trim() == "---" {
            bail!("frontmatter is missing its closing --- delimiter");
        }
        return Ok((None, text));
    };
    if text[..first_newline].trim() != "---" {
        return Ok((None, text));
    }
    let yaml_start = first_newline + 1;
    let mut offset = yaml_start;
    for line in text[yaml_start..].split_inclusive('\n') {
        if line.trim() == "---" || line.trim() == "..." {
            return Ok((
                Some(&text[yaml_start..offset]),
                &text[offset + line.len()..],
            ));
        }
        offset += line.len();
    }
    bail!("frontmatter is missing its closing --- delimiter")
}

fn field<'a>(mapping: &'a Mapping, name: &str) -> Option<&'a Value> {
    mapping.get(Value::String(name.to_owned()))
}

fn string_field(mapping: &Mapping, name: &str) -> Result<Option<String>> {
    match field(mapping, name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.trim().to_owned())),
        _ => bail!("frontmatter {name} must be a string"),
    }
}

fn string_list(mapping: &Mapping, name: &str) -> Result<Vec<String>> {
    match field(mapping, name) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::String(value)) => Ok(vec![value.trim().to_owned()]),
        Some(Value::Sequence(values)) => values
            .iter()
            .map(|value| match value {
                Value::String(value) => Ok(value.trim().to_owned()),
                _ => bail!("frontmatter {name} must contain strings; quote [[wiki links]] in YAML"),
            })
            .collect(),
        _ => bail!("frontmatter {name} must be a string or a list of strings"),
    }
}

fn number_field(mapping: &Mapping, name: &str) -> Result<Option<f64>> {
    match field(mapping, name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(value)) => value
            .as_f64()
            .map(Some)
            .with_context(|| format!("frontmatter {name} must be a finite number")),
        _ => bail!("frontmatter {name} must be a number"),
    }
}

fn bool_field(mapping: &Mapping, name: &str) -> Result<Option<bool>> {
    match field(mapping, name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        _ => bail!("frontmatter {name} must be true or false"),
    }
}

fn deduplicate_strings(values: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.to_lowercase()))
        .collect()
}

/// Normalize an explicit link or a name without interpreting Markdown as commands.
fn normalized_reference(value: &str) -> String {
    let value = value.trim();
    let value = value
        .strip_prefix("[[")
        .and_then(|inner| inner.strip_suffix("]]"))
        .unwrap_or(value);
    // Obsidian display labels and heading anchors are not parts of note identity.
    let value = value.split('|').next().unwrap_or(value);
    let value = value.split('#').next().unwrap_or(value).trim();
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

/// Return explicit edges and diagnostics for references that cannot safely resolve.
/// Only same-domain matches are eligible, including when the reference is a UUID.
pub fn resolve_edges_with_report(notes: &[Note]) -> (Vec<Edge>, Vec<UnresolvedRelation>) {
    let mut names: HashMap<(String, String), BTreeSet<Uuid>> = HashMap::new();
    for note in notes {
        let mut labels = vec![
            note.input.key.clone(),
            note.input.title.clone(),
            note.id.to_string(),
        ];
        labels.extend(note.input.aliases.clone());
        for label in labels {
            let normalized = normalized_reference(&label);
            if !normalized.is_empty() {
                names
                    .entry((note.input.domain.clone(), normalized))
                    .or_default()
                    .insert(note.id);
            }
        }
    }
    let mut edges = BTreeMap::new();
    let mut unresolved = Vec::new();
    for note in notes {
        for reference in &note.input.related {
            let key = (note.input.domain.clone(), normalized_reference(reference));
            match names.get(&key) {
                Some(targets) if targets.len() == 1 => {
                    let target = *targets.first().expect("one target checked");
                    if target != note.id {
                        edges.entry((note.id, target)).or_insert_with(|| Edge {
                            source: note.id,
                            target,
                            kind: "related".to_owned(),
                            weight: 1.0,
                        });
                    }
                }
                targets => unresolved.push(UnresolvedRelation {
                    source: note.id,
                    reference: reference.clone(),
                    reason: if targets.is_some() {
                        "ambiguous"
                    } else {
                        "not_found"
                    }
                    .to_owned(),
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

/// Query-personalized PageRank with a 15% restart probability and bidirectional
/// traversal of explicit relationships. This ranks query relevance; it does not
/// age or delete memories. Dangling mass returns to the query's seed distribution.
pub fn personalized_pagerank(
    notes: &[Note],
    edges: &[Edge],
    seeds: &HashMap<Uuid, f64>,
) -> HashMap<Uuid, f64> {
    if notes.is_empty() {
        return HashMap::new();
    }
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
        let mut next: Vec<f64> = personalization.iter().map(|value| 0.15 * value).collect();
        let mut dangling = 0.0;
        for (i, neighbors) in adjacency.iter().enumerate() {
            if totals[i] == 0.0 {
                dangling += scores[i];
            } else {
                for (neighbor, weight) in neighbors {
                    next[*neighbor] += 0.85 * scores[i] * weight / totals[i];
                }
            }
        }
        for (value, seed) in next.iter_mut().zip(&personalization) {
            *value += 0.85 * dangling * seed;
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
            status: "active".into(),
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
        );
        assert_eq!(scores[&a.id], 1.0);
        assert_eq!(scores[&b.id], 0.0);
        let uniform = personalized_pagerank(&[a.clone(), b.clone()], &[], &HashMap::new());
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

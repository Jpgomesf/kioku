//! Explicit relationship resolution and graph propagation.
//!
//! Aliases identify a note; they do not silently merge notes or create claims
//! about relationships.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::Serialize;
use uuid::Uuid;

use crate::model::{Edge, Note, Status};

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::note;

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
}

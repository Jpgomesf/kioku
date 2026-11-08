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

/// The references of note `id` that don't resolve against `notes`, by the
/// rules of [`resolve_edges_with_report`], sorted by reference. `notes` must
/// include the note itself; without it there is nothing to report.
pub fn unresolved_for(notes: &[Note], id: Uuid) -> Vec<UnresolvedRelation> {
    let Some(note) = notes.iter().find(|note| note.id == id) else {
        return Vec::new();
    };
    let index = LabelIndex::build(notes);
    let mut unresolved: Vec<UnresolvedRelation> = note
        .input
        .related
        .iter()
        .filter_map(|reference| {
            let reason = index.resolve(&note.input.domain, reference).err()?;
            Some(UnresolvedRelation {
                source: id,
                reference: reference.clone(),
                reason: reason.to_owned(),
            })
        })
        .collect();
    unresolved.sort_by(|a, b| a.reference.cmp(&b.reference));
    unresolved
}

/// Undistributed probability a note may keep, per unit of its link weight,
/// before [`LocalPagerank`] stops pushing it. Masses differ from the global
/// computation by about this much, far below the gaps between the notes that
/// compete for a graph slot.
const PUSH_TOLERANCE: f64 = 1e-10;

/// At most this many rounds, as [`personalized_pagerank`] runs at most this
/// many iterations.
const PUSH_ROUNDS: usize = 200;

/// At most this many pushes in all, so a dense graph can't make one search slow.
const PUSH_BUDGET: usize = 2_000_000;

/// The links of one note for PageRank: each neighbor once, sorted by id, with
/// the heaviest weight of the links between the two in either direction,
/// capped as [`personalized_pagerank`] caps it. Invalid links are dropped.
pub fn link_weights(links: impl IntoIterator<Item = (Uuid, f64)>, own: Uuid) -> Vec<(Uuid, f64)> {
    let mut merged: BTreeMap<Uuid, f64> = BTreeMap::new();
    for (other, weight) in links {
        if other == own || !weight.is_finite() || weight <= 0.0 {
            continue;
        }
        let weight = weight.min(1_000_000.0);
        merged
            .entry(other)
            .and_modify(|existing| *existing = existing.max(weight))
            .or_insert(weight);
    }
    merged.into_iter().collect()
}

/// [`personalized_pagerank`] computed locally, by pushing probability out from
/// the seeds (Andersen, Chung, and Lang, 2006) instead of iterating over every
/// note. Each round, every note holding more than [`PUSH_TOLERANCE`] of
/// undistributed probability per unit of link weight keeps `restart` of it
/// and passes the rest along its links in proportion to their weights; a note
/// without links passes it back to the seeds. Rounds are synchronous and run
/// in id order, so symmetric notes get identical masses. The work depends on
/// the seeds' neighbourhood, not on the size of the graph.
///
/// Links are asked for by note, through [`LocalPagerank::run`], so a caller
/// can load them as the walk reaches new notes.
pub struct LocalPagerank {
    restart: f64,
    /// The seed distribution, sorted by id.
    seeds: Vec<(Uuid, f64)>,
    estimate: HashMap<Uuid, f64>,
    residual: BTreeMap<Uuid, f64>,
    rounds: usize,
    pushes: usize,
}

impl LocalPagerank {
    /// Start from `seeds` (positive, finite weights; others are ignored),
    /// normalized as [`personalized_pagerank`] normalizes them.
    pub fn new(seeds: &HashMap<Uuid, f64>, restart: f64) -> Self {
        let restart = if restart.is_finite() {
            restart.clamp(0.01, 1.0)
        } else {
            0.5
        };
        let mut weights: Vec<(Uuid, f64)> = seeds
            .iter()
            .filter(|(_, value)| value.is_finite() && **value > 0.0)
            .map(|(id, value)| (*id, *value))
            .collect();
        weights.sort_by_key(|(id, _)| *id);
        let max_seed = weights.iter().map(|(_, v)| *v).fold(0.0, f64::max);
        if max_seed > 0.0 {
            for (_, value) in &mut weights {
                *value /= max_seed;
            }
            let sum: f64 = weights.iter().map(|(_, v)| v).sum();
            for (_, value) in &mut weights {
                *value /= sum;
            }
        }
        Self {
            restart,
            residual: weights.iter().copied().collect(),
            seeds: weights,
            estimate: HashMap::new(),
            rounds: 0,
            pushes: 0,
        }
    }

    /// Run rounds until the walk settles, or until a note that must push has
    /// links `links` doesn't know yet (it returns `None` for them). Returns
    /// those notes, so the caller can load their links and run again; an
    /// empty list means the walk is done. `links` returns a note's links
    /// among the ranked notes, as [`link_weights`] builds them.
    pub fn run(&mut self, mut links: impl FnMut(Uuid) -> Option<Vec<(Uuid, f64)>>) -> Vec<Uuid> {
        let walk = 1.0 - self.restart;
        while self.rounds < PUSH_ROUNDS && self.pushes < PUSH_BUDGET {
            let mut missing = Vec::new();
            let mut active = Vec::new();
            for (id, mass) in &self.residual {
                if *mass <= PUSH_TOLERANCE {
                    continue;
                }
                match links(*id) {
                    None => missing.push(*id),
                    Some(neighbors) => {
                        let total: f64 = neighbors.iter().map(|(_, weight)| weight).sum();
                        if *mass > PUSH_TOLERANCE * total.max(1.0) {
                            active.push((*id, neighbors, total));
                        }
                    }
                }
            }
            if !missing.is_empty() {
                return missing;
            }
            if active.is_empty() {
                break;
            }
            let pushed: Vec<(Uuid, f64)> = active
                .iter()
                .map(|(id, _, _)| (*id, self.residual.remove(id).unwrap_or(0.0)))
                .collect();
            for ((id, mass), (_, neighbors, total)) in pushed.into_iter().zip(&active) {
                *self.estimate.entry(id).or_default() += self.restart * mass;
                let spread = walk * mass;
                if *total == 0.0 {
                    for (seed, share) in &self.seeds {
                        *self.residual.entry(*seed).or_default() += spread * share;
                    }
                } else {
                    for (neighbor, weight) in neighbors {
                        *self.residual.entry(*neighbor).or_default() += spread * weight / total;
                    }
                }
            }
            self.pushes += active.len();
            self.rounds += 1;
        }
        Vec::new()
    }

    /// Each reached note's PageRank mass.
    pub fn into_masses(self) -> HashMap<Uuid, f64> {
        self.estimate
    }
}

/// Query-personalized PageRank over explicit relationships, traversed in both
/// directions. `restart` is the probability of jumping back to the seeds at
/// each step: higher values keep the mass near the seeds. This measures
/// closeness to the query's matches; it does not age or delete memories.
/// Dangling mass returns to the seed distribution. It iterates over every
/// note; search uses [`LocalPagerank`], and this stays as its reference.
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
    fn one_notes_unresolved_references_follow_the_same_rules() {
        let mut a = note("checkout", "shop");
        let mut b = note("database", "shop");
        b.input.aliases = vec!["Banco".into()];
        let mut c = note("ledger", "shop");
        c.input.aliases = vec!["banco".into()];
        c.input.related = vec!["nowhere".into()];
        a.input.related = vec!["zeta".into(), "database".into(), "banco".into()];
        let notes = [a.clone(), b, c];
        let mine = unresolved_for(&notes, a.id);
        let refs: Vec<(&str, &str)> = mine
            .iter()
            .map(|u| (u.reference.as_str(), u.reason.as_str()))
            .collect();
        assert_eq!(refs, [("banco", "ambiguous"), ("zeta", "not_found")]);
        assert!(mine.iter().all(|u| u.source == a.id));
        let (_, everything) = resolve_edges_with_report(&notes);
        assert_eq!(everything.len(), 3, "the domain report also has ledger's");
        assert!(unresolved_for(&notes[1..], a.id).is_empty());
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

    /// SplitMix64, for reproducible random graphs.
    fn next(state: &mut u64) -> u64 {
        *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = *state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn local(
        notes: &[Note],
        edges: &[Edge],
        seeds: &HashMap<Uuid, f64>,
        restart: f64,
    ) -> HashMap<Uuid, f64> {
        let mut raw: HashMap<Uuid, Vec<(Uuid, f64)>> = HashMap::new();
        for edge in edges {
            raw.entry(edge.source)
                .or_default()
                .push((edge.target, edge.weight));
            raw.entry(edge.target)
                .or_default()
                .push((edge.source, edge.weight));
        }
        let links: HashMap<Uuid, Vec<(Uuid, f64)>> = notes
            .iter()
            .map(|n| {
                let own = raw.remove(&n.id).unwrap_or_default();
                (n.id, link_weights(own, n.id))
            })
            .collect();
        let mut walk = LocalPagerank::new(seeds, restart);
        assert!(walk.run(|id| links.get(&id).cloned()).is_empty());
        walk.into_masses()
    }

    #[test]
    fn local_pagerank_matches_the_global_computation() {
        let mut state = 7;
        for trial in 0..40 {
            let n = 20 + (next(&mut state) % 300) as usize;
            let notes: Vec<Note> = (0..n).map(|i| note(&format!("n{i}"), "work")).collect();
            let mut edges = Vec::new();
            for _ in 0..n * (1 + (next(&mut state) % 4) as usize) {
                let (a, b) = (
                    (next(&mut state) % n as u64) as usize,
                    (next(&mut state) % n as u64) as usize,
                );
                edges.push(Edge {
                    source: notes[a].id,
                    target: notes[b].id,
                    kind: "related".into(),
                    weight: [1.0, 0.5, 2.0][(next(&mut state) % 3) as usize],
                });
            }
            let seeds: HashMap<Uuid, f64> = (0..3)
                .map(|i| {
                    let pick = (next(&mut state) % n as u64) as usize;
                    (notes[pick].id, 1.0 / (61.0 + i as f64))
                })
                .collect();
            let global = personalized_pagerank(&notes, &edges, &seeds, 0.5);
            let local = local(&notes, &edges, &seeds, 0.5);
            for (id, mass) in &global {
                let approx = local.get(id).copied().unwrap_or(0.0);
                assert!(
                    (mass - approx).abs() < 1e-8,
                    "trial {trial}: {mass} vs {approx}"
                );
            }
        }
    }

    #[test]
    fn local_pagerank_reaches_only_the_seeds_neighbourhood() {
        // Two components: the walk never enters the one without seeds.
        let notes: Vec<Note> = (0..6).map(|i| note(&format!("n{i}"), "work")).collect();
        let link = |a: usize, b: usize| (notes[b].id, if a == b { 0.0 } else { 1.0 });
        let links: HashMap<Uuid, Vec<(Uuid, f64)>> = HashMap::from([
            (
                notes[0].id,
                link_weights([link(0, 1), link(0, 2)], notes[0].id),
            ),
            (notes[1].id, link_weights([link(1, 0)], notes[1].id)),
            (notes[2].id, link_weights([link(2, 0)], notes[2].id)),
            (
                notes[3].id,
                link_weights([link(3, 4), link(3, 5)], notes[3].id),
            ),
        ]);
        let mut asked = Vec::new();
        let mut walk = LocalPagerank::new(&HashMap::from([(notes[0].id, 1.0)]), 0.5);
        let missing = walk.run(|id| {
            asked.push(id);
            links.get(&id).cloned()
        });
        assert!(missing.is_empty());
        let masses = walk.into_masses();
        assert!(
            asked
                .iter()
                .all(|id| [notes[0].id, notes[1].id, notes[2].id].contains(id))
        );
        assert_eq!(
            masses[&notes[1].id], masses[&notes[2].id],
            "symmetric notes tie"
        );
        assert!(masses[&notes[0].id] > masses[&notes[1].id]);
        assert!(!masses.contains_key(&notes[3].id));
    }

    #[test]
    fn local_pagerank_asks_for_links_it_does_not_have() {
        let a = note("a", "work");
        let b = note("b", "work");
        let mut walk = LocalPagerank::new(&HashMap::from([(a.id, 1.0)]), 0.5);
        assert_eq!(walk.run(|_| None), vec![a.id]);
        let links = HashMap::from([(a.id, vec![(b.id, 1.0)])]);
        assert_eq!(walk.run(|id| links.get(&id).cloned()), vec![b.id]);
        let links = HashMap::from([(a.id, vec![(b.id, 1.0)]), (b.id, vec![(a.id, 1.0)])]);
        assert!(walk.run(|id| links.get(&id).cloned()).is_empty());
        let masses = walk.into_masses();
        assert!((masses.values().sum::<f64>() - 1.0).abs() < 1e-8);
    }
}

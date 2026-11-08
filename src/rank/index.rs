//! One domain's search index, kept by a server process between searches.
//!
//! It holds what ranking needs of every note in the domain: BM25 postings and
//! statistics, normalized exact labels, the vector state, the retention
//! inputs, and the links. It is built once from PostgreSQL and then updated
//! note by note (`app::cache` keeps it fresh), so a search no longer loads and
//! tokenizes its whole domain.
//!
//! Every note is indexed, whatever its status or lock. Statistics are kept per
//! group of notes that share a status and a lock, and a query adds up only the
//! groups its caller may see ([`DomainIndex::view`]). Its BM25 statistics,
//! matches, and links are therefore exactly those of the notes it may see, as
//! when each search loaded only those: a hidden note can neither be returned
//! nor shift the ranking of visible ones.

use std::collections::{BTreeSet, HashMap, HashSet};

use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::graph;
use crate::lifecycle::{self, Usage};
use crate::model::{SearchFields, Status};

use super::lexical::{idf, normalize_label, note_terms, term_score};

/// What the index keeps of one note.
#[derive(Debug)]
pub struct Entry {
    pub id: Uuid,
    pub key: String,
    pub revision: i64,
    pub vector_synced: bool,
    /// The embedding service may not read the note, so it has no vector.
    pub unembedded: bool,
    pub usage: Usage,
    group: usize,
    /// Terms in the note, BM25's document length.
    length: u32,
}

impl Entry {
    pub fn retention(&self, now: DateTime<Utc>, half_life_days: f64) -> f64 {
        lifecycle::retention_of(&self.usage, now, half_life_days)
    }
}

/// Notes that share a status and a lock, so one query sees all or none of them.
#[derive(Debug)]
struct Group {
    status: Status,
    lock: Vec<String>,
    notes: u64,
    length: u64,
    unsynced: u64,
    /// Notes of the group holding each term, by term id.
    document_frequency: Vec<u32>,
}

#[derive(Debug, Default)]
pub struct DomainIndex {
    entries: Vec<Option<Entry>>,
    slots: HashMap<Uuid, u32>,
    vocabulary: HashMap<String, u32>,
    /// For each term id, the notes holding it and how often.
    postings: Vec<Vec<(u32, u32)>>,
    groups: Vec<Group>,
    /// Normalized key, title, and aliases, for exact matches.
    labels: HashMap<String, Vec<u32>>,
    links: HashMap<Uuid, Vec<(Uuid, f64)>>,
    link_count: usize,
}

impl DomainIndex {
    /// Notes in the index, of every status and lock.
    pub fn len(&self) -> usize {
        self.slots.len()
    }

    pub fn is_empty(&self) -> bool {
        self.slots.is_empty()
    }

    /// Notes in a searched status, whoever may see them.
    pub fn searched(&self, include_legacy: bool) -> usize {
        self.groups
            .iter()
            .filter(|g| include_legacy || g.status == Status::Active)
            .map(|g| g.notes as usize)
            .sum()
    }

    /// Links in the domain, before visibility.
    pub fn link_count(&self) -> usize {
        self.link_count
    }

    /// Add notes, or update the ones already indexed. Text is indexed again
    /// only when the note's content or status changed; usage and vector state
    /// are always taken from `rows`. `unembedded` says whether the embedding
    /// service may not read a note.
    pub fn apply(&mut self, rows: Vec<SearchFields>, unembedded: impl Fn(&SearchFields) -> bool) {
        let mut stale = HashSet::new();
        let mut plans = Vec::with_capacity(rows.len());
        for row in rows {
            let group = self.group_for(row.status, &row.lock);
            let slot = match self.slots.get(&row.id) {
                Some(slot) => *slot,
                None => {
                    let slot = u32::try_from(self.entries.len()).unwrap_or(u32::MAX);
                    self.entries.push(None);
                    self.slots.insert(row.id, slot);
                    slot
                }
            };
            let same_text = self.entries[slot as usize]
                .as_ref()
                .is_some_and(|e| e.revision == row.revision && e.group == group);
            if !same_text && self.entries[slot as usize].is_some() {
                stale.insert(slot);
            }
            plans.push((slot, row, group, same_text));
        }
        self.remove_text(&stale);
        for (slot, row, group, same_text) in plans {
            let old = self.entries[slot as usize].take();
            if let Some(old) = &old
                && !old.vector_synced
            {
                self.groups[old.group].unsynced -= 1;
            }
            let length = match old {
                Some(old) if same_text => old.length,
                _ => self.add_text(slot, &row, group),
            };
            if !row.vector_synced {
                self.groups[group].unsynced += 1;
            }
            let unembedded = unembedded(&row);
            self.entries[slot as usize] = Some(Entry {
                id: row.id,
                key: row.key,
                revision: row.revision,
                vector_synced: row.vector_synced,
                unembedded,
                usage: row.usage,
                group,
                length,
            });
        }
    }

    /// Replace the domain's links, each its source, target, and weight.
    pub fn replace_links(&mut self, links: &[(Uuid, Uuid, f64)]) {
        let mut raw: HashMap<Uuid, Vec<(Uuid, f64)>> = HashMap::new();
        for (source, target, weight) in links {
            raw.entry(*source).or_default().push((*target, *weight));
            raw.entry(*target).or_default().push((*source, *weight));
        }
        self.links = raw
            .into_iter()
            .map(|(id, links)| (id, graph::link_weights(links, id)))
            .collect();
        self.link_count = links.len();
    }

    fn group_for(&mut self, status: Status, lock: &[String]) -> usize {
        if let Some(index) = self
            .groups
            .iter()
            .position(|g| g.status == status && g.lock == lock)
        {
            return index;
        }
        self.groups.push(Group {
            status,
            lock: lock.to_vec(),
            notes: 0,
            length: 0,
            unsynced: 0,
            document_frequency: Vec::new(),
        });
        self.groups.len() - 1
    }

    /// Index a note's text in `group`; returns its length in terms.
    fn add_text(&mut self, slot: u32, row: &SearchFields, group: usize) -> u32 {
        let terms = note_terms(&row.key, &row.title, &row.aliases, &row.tags, &row.body);
        let length: u32 = terms.values().sum();
        for (term, frequency) in terms {
            let next = u32::try_from(self.vocabulary.len()).unwrap_or(u32::MAX);
            let id = *self.vocabulary.entry(term).or_insert(next);
            if id as usize == self.postings.len() {
                self.postings.push(Vec::new());
            }
            self.postings[id as usize].push((slot, frequency));
            let frequencies = &mut self.groups[group].document_frequency;
            if frequencies.len() <= id as usize {
                frequencies.resize(id as usize + 1, 0);
            }
            frequencies[id as usize] += 1;
        }
        let group = &mut self.groups[group];
        group.notes += 1;
        group.length += u64::from(length);
        let labels: BTreeSet<String> = [&row.key, &row.title]
            .into_iter()
            .chain(&row.aliases)
            .map(|label| normalize_label(label))
            .filter(|label| !label.is_empty())
            .collect();
        for label in labels {
            self.labels.entry(label).or_default().push(slot);
        }
        length
    }

    /// Take the text of the notes in `slots` out of the postings, labels, and
    /// their groups' statistics. One pass over every posting list, so it runs
    /// once per refresh, never per search.
    fn remove_text(&mut self, slots: &HashSet<u32>) {
        if slots.is_empty() {
            return;
        }
        let groups_of: HashMap<u32, usize> = slots
            .iter()
            .filter_map(|slot| Some((*slot, self.entries[*slot as usize].as_ref()?.group)))
            .collect();
        for (slot, group) in &groups_of {
            if let Some(entry) = &self.entries[*slot as usize] {
                let group = &mut self.groups[*group];
                group.notes -= 1;
                group.length -= u64::from(entry.length);
            }
        }
        let groups = &mut self.groups;
        for (term, postings) in self.postings.iter_mut().enumerate() {
            postings.retain(|(slot, _)| match groups_of.get(slot) {
                Some(group) => {
                    groups[*group].document_frequency[term] -= 1;
                    false
                }
                None => true,
            });
        }
        self.labels.retain(|_, holders| {
            holders.retain(|slot| !slots.contains(slot));
            !holders.is_empty()
        });
    }

    /// The notes a query may rank: those in a searched status whose lock
    /// `sees` admits. `sees` gets the lock of each group of notes, so it is
    /// asked once per group, not once per note.
    pub fn view(&self, include_legacy: bool, sees: impl Fn(&[String]) -> bool) -> View<'_> {
        let searched: Vec<bool> = self
            .groups
            .iter()
            .map(|g| include_legacy || g.status == Status::Active)
            .collect();
        let visible = self
            .groups
            .iter()
            .zip(&searched)
            .map(|(g, searched)| *searched && sees(&g.lock))
            .collect();
        View {
            index: self,
            searched,
            visible,
        }
    }
}

/// One query's view of a [`DomainIndex`]: the notes it ranks.
pub struct View<'a> {
    index: &'a DomainIndex,
    /// Groups in a searched status.
    searched: Vec<bool>,
    /// Groups in a searched status that the caller may see.
    visible: Vec<bool>,
}

impl View<'_> {
    fn sum(&self, field: impl Fn(&Group) -> u64) -> u64 {
        self.index
            .groups
            .iter()
            .zip(&self.visible)
            .filter(|(_, visible)| **visible)
            .map(|(g, _)| field(g))
            .sum()
    }

    /// Notes ranked.
    pub fn notes(&self) -> u64 {
        self.sum(|g| g.notes)
    }

    /// Terms in all ranked notes, for the average document length.
    pub fn length(&self) -> u64 {
        self.sum(|g| g.length)
    }

    /// Ranked notes not yet in the vector index.
    pub fn unsynced(&self) -> u64 {
        self.sum(|g| g.unsynced)
    }

    /// Ranked notes holding `term`.
    pub fn document_frequency(&self, term: &str) -> u64 {
        let Some(id) = self.index.vocabulary.get(term) else {
            return 0;
        };
        self.sum(|g| {
            g.document_frequency
                .get(*id as usize)
                .copied()
                .map_or(0, u64::from)
        })
    }

    /// The ranked note `id`, if this view ranks it.
    pub fn entry(&self, id: Uuid) -> Option<&Entry> {
        let slot = self.index.slots.get(&id)?;
        let entry = self.index.entries[*slot as usize].as_ref()?;
        self.visible[entry.group].then_some(entry)
    }

    pub fn contains(&self, id: Uuid) -> bool {
        self.entry(id).is_some()
    }

    /// Notes in a searched status that the caller may not see, so the vector
    /// index can leave them out of its candidates.
    pub fn hidden(&self) -> Vec<Uuid> {
        let hidden: Vec<bool> = self
            .searched
            .iter()
            .zip(&self.visible)
            .map(|(searched, visible)| *searched && !*visible)
            .collect();
        if !hidden.contains(&true) {
            return Vec::new();
        }
        self.index
            .entries
            .iter()
            .flatten()
            .filter(|e| hidden[e.group])
            .map(|e| e.id)
            .collect()
    }

    /// BM25 scores of the ranked notes holding any of `terms`, each with its
    /// inverse document frequency over every searched domain, in query term
    /// order. The arithmetic is [`super::lexical::Bm25`]'s, term by term.
    pub fn bm25(&self, terms: &[(String, f64)], average_length: f64, out: &mut Vec<(Uuid, f64)>) {
        let mut scores: HashMap<u32, f64> = HashMap::new();
        for (term, weight) in terms {
            let Some(id) = self.index.vocabulary.get(term) else {
                continue;
            };
            for (slot, frequency) in &self.index.postings[*id as usize] {
                let Some(entry) = &self.index.entries[*slot as usize] else {
                    continue;
                };
                if !self.visible[entry.group] {
                    continue;
                }
                *scores.entry(*slot).or_insert(0.0) += term_score(
                    *weight,
                    f64::from(*frequency),
                    f64::from(entry.length),
                    average_length,
                );
            }
        }
        out.extend(
            scores
                .into_iter()
                .filter(|(_, s)| *s > 0.0)
                .filter_map(|(slot, score)| {
                    Some((self.index.entries[slot as usize].as_ref()?.id, score))
                }),
        );
    }

    /// Ranked notes whose key, title, or alias equals `query` after case and
    /// accent folding.
    pub fn exact(&self, query: &str) -> Vec<Uuid> {
        let wanted = normalize_label(query);
        if wanted.is_empty() {
            return Vec::new();
        }
        let mut ids: Vec<Uuid> = self
            .index
            .labels
            .get(&wanted)
            .into_iter()
            .flatten()
            .filter_map(|slot| self.index.entries[*slot as usize].as_ref())
            .filter(|e| self.visible[e.group])
            .map(|e| e.id)
            .collect();
        ids.sort();
        ids
    }

    /// `id`'s stored links, before visibility.
    pub fn links(&self, id: Uuid) -> Option<&[(Uuid, f64)]> {
        self.index.links.get(&id).map(Vec::as_slice)
    }
}

/// The inverse document frequency of each query term over the ranked notes of
/// every view, and their average length, as [`super::lexical::Bm25`] computes
/// them. Terms no ranked note holds are left out.
pub fn corpus_weights(views: &[View<'_>], terms: &BTreeSet<String>) -> (Vec<(String, f64)>, f64) {
    let notes: u64 = views.iter().map(View::notes).sum();
    let length: u64 = views.iter().map(View::length).sum();
    let average_length = if notes == 0 {
        1.0
    } else {
        (length as f64 / notes as f64).max(1.0)
    };
    let weights = terms
        .iter()
        .filter_map(|term| {
            let df: u64 = views.iter().map(|v| v.document_frequency(term)).sum();
            (df > 0).then(|| (term.clone(), idf(notes as f64, df as f64)))
        })
        .collect();
    (weights, average_length)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::NoteInput;
    use crate::rank::lexical::{Bm25, tokenize};
    use crate::testing::now;

    fn fields(key: &str, body: &str, lock: &[&str], status: Status) -> SearchFields {
        let input = NoteInput {
            domain: "d".into(),
            key: key.into(),
            title: format!("Title of {key}"),
            body: body.into(),
            aliases: vec![format!("{key} alias")],
            related: Vec::new(),
            tags: vec!["tag".into()],
            source: None,
            confidence: 0.8,
            pinned: false,
            lock: lock.iter().map(|l| (*l).to_owned()).collect(),
            paths: Vec::new(),
        };
        SearchFields {
            id: input.id(),
            domain: input.domain,
            key: input.key,
            title: input.title,
            aliases: input.aliases,
            tags: input.tags,
            body: input.body,
            lock: input.lock,
            status,
            revision: 1,
            vector_synced: true,
            usage: Usage {
                pinned: false,
                confidence: 0.8,
                updated_at: now(),
                last_accessed_at: None,
                access_count: 0,
                positive_feedback: 0,
                negative_feedback: 0,
            },
        }
    }

    fn as_note(row: &SearchFields) -> crate::model::Note {
        let mut note = crate::testing::note(&row.key, &row.domain);
        note.input.title = row.title.clone();
        note.input.body = row.body.clone();
        note.input.aliases = row.aliases.clone();
        note.input.tags = row.tags.clone();
        note.input.lock = row.lock.clone();
        note.status = row.status;
        note
    }

    fn scores(view: &View<'_>, query: &str) -> Vec<(Uuid, f64)> {
        let terms: BTreeSet<String> = tokenize(query).into_iter().collect();
        let (weights, average) = corpus_weights(std::slice::from_ref(view), &terms);
        let mut out = Vec::new();
        view.bm25(&weights, average, &mut out);
        out.sort_by_key(|a| a.0);
        out
    }

    fn reference(rows: &[SearchFields], query: &str) -> Vec<(Uuid, f64)> {
        let notes: Vec<_> = rows.iter().map(as_note).collect();
        let mut out = Bm25::new(&notes).scores(query);
        out.sort_by_key(|a| a.0);
        out
    }

    #[test]
    fn scores_equal_a_bm25_built_from_the_visible_notes() {
        let rows = vec![
            fields(
                "ledger",
                "The ledger retries writes three times.",
                &[],
                Status::Active,
            ),
            fields(
                "queue",
                "Media queue retries deliveries.",
                &[],
                Status::Active,
            ),
            fields("old", "Old ledger retries were five.", &[], Status::Legacy),
            fields(
                "secret",
                "Ledger secrets rotate weekly.",
                &["local"],
                Status::Active,
            ),
        ];
        let mut index = DomainIndex::default();
        index.apply(rows.clone(), |_| false);
        let query = "ledger retries";
        // Without legacy notes and without the locked note: the BM25 of the
        // two visible notes, bit for bit.
        let view = index.view(false, |lock| lock.is_empty());
        assert_eq!(scores(&view, query), reference(&rows[..2], query));
        let everything = index.view(true, |_| true);
        assert_eq!(scores(&everything, query), reference(&rows, query));
        assert_eq!(view.hidden(), vec![rows[3].id]);
        assert!(everything.hidden().is_empty());
        assert_eq!(view.notes(), 2);
    }

    #[test]
    fn hidden_notes_match_nothing_and_name_no_label() {
        let rows = vec![
            fields("open", "shared words", &[], Status::Active),
            fields(
                "locked",
                "shared words and secret",
                &["anthropic"],
                Status::Active,
            ),
        ];
        let mut index = DomainIndex::default();
        index.apply(rows.clone(), |_| false);
        let view = index.view(false, |lock| lock.is_empty());
        assert!(scores(&view, "secret").is_empty());
        assert!(view.exact("locked alias").is_empty());
        assert!(!view.contains(rows[1].id));
        let allowed = index.view(false, |_| true);
        assert_eq!(allowed.exact("Locked Alias"), vec![rows[1].id]);
    }

    #[test]
    fn updates_replace_a_notes_text_and_statistics() {
        let mut rows = vec![
            fields("a", "alpha words", &[], Status::Active),
            fields("b", "beta words", &[], Status::Active),
        ];
        let mut index = DomainIndex::default();
        index.apply(rows.clone(), |_| false);
        rows[0].body = "gamma words".into();
        rows[0].revision = 2;
        rows[1].status = Status::Legacy;
        rows[1].usage.access_count = 3;
        index.apply(rows.clone(), |_| false);
        let view = index.view(false, |_| true);
        assert!(scores(&view, "alpha").is_empty(), "old text is gone");
        assert_eq!(
            scores(&view, "gamma words"),
            reference(&rows[..1], "gamma words")
        );
        let all = index.view(true, |_| true);
        assert_eq!(scores(&all, "gamma words"), reference(&rows, "gamma words"));
        assert_eq!(all.entry(rows[1].id).map(|e| e.usage.access_count), Some(3));
        assert_eq!(index.len(), 2);
        // A usage-only update keeps the text.
        rows[0].usage.access_count = 9;
        index.apply(vec![rows[0].clone()], |_| false);
        let view = index.view(true, |_| true);
        assert_eq!(
            scores(&view, "gamma words"),
            reference(&rows, "gamma words")
        );
    }

    #[test]
    fn unsynced_notes_are_counted_per_view() {
        let mut row = fields("a", "alpha", &[], Status::Active);
        row.vector_synced = false;
        let mut index = DomainIndex::default();
        index.apply(vec![row.clone()], |_| false);
        assert_eq!(index.view(false, |_| true).unsynced(), 1);
        row.vector_synced = true;
        index.apply(vec![row], |_| false);
        assert_eq!(index.view(false, |_| true).unsynced(), 0);
    }
}

//! Query-focused excerpts of a note: the sentences that match the query come
//! first, rendered in their original order with `…` marking what was left out.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::ops::Range;

use crate::rank::tokenize;
use crate::text::{sentence_spans, truncate_chars};

/// Weight of each query term: rarer terms across the candidate notes' sentences
/// count for more, so "MEDIA_DLQ" outweighs "every".
pub(super) fn query_weights(query: &str, bodies: &[&str]) -> HashMap<String, f64> {
    let terms: HashSet<String> = tokenize(query).into_iter().collect();
    if terms.is_empty() {
        return HashMap::new();
    }
    let mut sentences = 0usize;
    let mut frequency: HashMap<&str, usize> = HashMap::new();
    for body in bodies {
        for span in sentence_spans(body) {
            sentences += 1;
            let tokens: HashSet<String> = tokenize(&body[span]).into_iter().collect();
            for term in &terms {
                if tokens.contains(term) {
                    *frequency.entry(term.as_str()).or_default() += 1;
                }
            }
        }
    }
    terms
        .iter()
        .map(|term| {
            let df = frequency.get(term.as_str()).copied().unwrap_or(0);
            let idf = (1.0 + sentences as f64 / (1.0 + df as f64)).ln();
            (term.clone(), idf)
        })
        .collect()
}

/// An excerpt being grown one sentence at a time.
pub(super) struct Excerpt<'a> {
    body: &'a str,
    spans: Vec<Range<usize>>,
    /// Span indexes in the order they should be added.
    order: Vec<usize>,
    /// How many spans at the front of `order` share a term with the query.
    matched: usize,
    cursor: usize,
    chosen: BTreeMap<usize, Option<usize>>,
    last: Option<usize>,
}

impl<'a> Excerpt<'a> {
    /// Sentences matching `weights` come first, best first; the rest follow in
    /// reading order. Without weights the excerpt is a growing prefix.
    pub(super) fn new(body: &'a str, weights: Option<&HashMap<String, f64>>) -> Self {
        let spans = sentence_spans(body);
        let scores: Vec<f64> = spans
            .iter()
            .map(|span| match weights {
                Some(weights) => {
                    let tokens: HashSet<String> =
                        tokenize(&body[span.clone()]).into_iter().collect();
                    tokens.iter().filter_map(|t| weights.get(t)).sum()
                }
                None => 0.0,
            })
            .collect();
        let mut order: Vec<usize> = (0..spans.len()).collect();
        order.sort_by(|a, b| scores[*b].total_cmp(&scores[*a]).then(a.cmp(b)));
        let matched = scores.iter().filter(|score| **score > 0.0).count();
        Self {
            body,
            spans,
            order,
            matched,
            cursor: 0,
            chosen: BTreeMap::new(),
            last: None,
        }
    }

    /// Add the next sentence. False when every sentence is already in.
    pub(super) fn advance(&mut self) -> bool {
        let Some(&next) = self.order.get(self.cursor) else {
            return false;
        };
        self.cursor += 1;
        self.chosen.insert(next, None);
        self.last = Some(next);
        true
    }

    /// Whether the next sentence to add shares a term with the query.
    pub(super) fn next_matches(&self) -> bool {
        self.cursor < self.matched
    }

    /// Undo the last [`advance`](Self::advance).
    pub(super) fn retract(&mut self) {
        if let Some(last) = self.last.take() {
            self.chosen.remove(&last);
            self.cursor -= 1;
        }
    }

    /// Keep only the first `chars` characters of the last sentence added.
    pub(super) fn cut_last(&mut self, chars: usize) {
        if let Some(last) = self.last {
            self.chosen.insert(last, Some(chars));
        }
    }

    /// Characters in the last sentence added.
    pub(super) fn last_chars(&self) -> usize {
        self.last
            .map_or(0, |i| self.body[self.spans[i].clone()].chars().count())
    }

    pub(super) fn is_complete(&self) -> bool {
        self.chosen.len() == self.spans.len() && self.chosen.values().all(Option::is_none)
    }

    pub(super) fn is_empty(&self) -> bool {
        self.chosen.is_empty()
    }

    pub(super) fn render(&self) -> String {
        if self.is_complete() {
            return self.body.trim().to_owned();
        }
        let mut out = String::new();
        let mut previous: Option<usize> = None;
        for (&i, cut) in &self.chosen {
            match previous {
                None if i > 0 => out.push_str("… "),
                Some(p) if i == p + 1 => {
                    out.push_str(&self.body[self.spans[p].end..self.spans[i].start])
                }
                Some(_) => out.push_str(" … "),
                None => {}
            }
            let text = &self.body[self.spans[i].clone()];
            match cut {
                Some(chars) => out.push_str(&truncate_chars(text, *chars)),
                None => out.push_str(text),
            }
            previous = Some(i);
        }
        let ends_cut = self
            .chosen
            .last_key_value()
            .is_some_and(|(_, cut)| cut.is_some());
        if !ends_cut && previous.is_some_and(|p| p + 1 < self.spans.len()) {
            out.push_str(" …");
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTE: &str = "Messages that exhaust their five delivery attempts move to the MEDIA_DLQ\nstream. The on-call engineer reviews MEDIA_DLQ every weekday at 09:00 UTC.\nReplays need approval from the platform lead.";

    fn grow(excerpt: &mut Excerpt<'_>, n: usize) {
        for _ in 0..n {
            assert!(excerpt.advance());
        }
    }

    #[test]
    fn query_matches_come_first_in_reading_order() {
        let weights = query_weights("who reviews the dead-letter queue", &[NOTE]);
        let mut excerpt = Excerpt::new(NOTE, Some(&weights));
        grow(&mut excerpt, 1);
        assert_eq!(
            excerpt.render(),
            "… The on-call engineer reviews MEDIA_DLQ every weekday at 09:00 UTC. …"
        );
        grow(&mut excerpt, 1);
        assert!(excerpt.render().starts_with("Messages that exhaust"));
        assert!(excerpt.render().ends_with("09:00 UTC. …"));
        grow(&mut excerpt, 1);
        assert!(excerpt.is_complete());
        assert_eq!(excerpt.render(), NOTE);
        assert!(!excerpt.advance());
    }

    #[test]
    fn without_a_query_the_excerpt_is_a_prefix() {
        let mut excerpt = Excerpt::new(NOTE, None);
        grow(&mut excerpt, 1);
        assert!(excerpt.render().starts_with("Messages that exhaust"));
        assert!(excerpt.render().ends_with("MEDIA_DLQ\nstream. …"));
    }

    #[test]
    fn retract_and_cut_change_only_the_last_sentence() {
        let mut excerpt = Excerpt::new(NOTE, None);
        grow(&mut excerpt, 2);
        excerpt.retract();
        assert!(!excerpt.render().contains("on-call"));
        assert!(excerpt.advance());
        excerpt.cut_last(20);
        let text = excerpt.render();
        assert!(text.contains("The on-call enginee…"), "{text}");
        assert!(!text.ends_with(" …"), "a cut already shows the gap: {text}");
        assert!(excerpt.last_chars() > 20);
    }

    #[test]
    fn rare_terms_weigh_more() {
        let weights = query_weights(
            "every MEDIA_DLQ",
            &[NOTE, "every day every time. Every week."],
        );
        assert!(weights["media_dlq"] > weights["every"]);
    }
}

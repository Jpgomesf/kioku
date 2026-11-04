//! Lexical retrieval: accent folding, identifier-aware tokenizing, and BM25.

use std::collections::{BTreeSet, HashMap};

use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;
use uuid::Uuid;

use crate::model::Note;

/// Standard BM25 saturation and length-normalization parameters.
const BM25_K1: f64 = 1.2;

const BM25_B: f64 = 0.75;

/// Lowercase and strip diacritics, so `requisições` matches `requisicoes`.
pub fn fold(text: &str) -> String {
    text.nfkd()
        .filter(|c| !is_combining_mark(*c))
        .flat_map(char::to_lowercase)
        .collect()
}

pub(super) fn normalize_label(text: &str) -> String {
    fold(text).split_whitespace().collect::<Vec<_>>().join(" ")
}

const SEPARATORS: [char; 4] = ['-', '.', '/', ':'];

/// Split text into search terms. Identifiers such as `TW-4290`, `max_deliver`,
/// or `media.uploaded` are kept whole and also split into their parts, so both
/// the exact identifier and its pieces can match.
pub fn tokenize(text: &str) -> Vec<String> {
    let folded = fold(text);
    let mut tokens = Vec::new();
    let is_word = |c: char| c.is_alphanumeric() || c == '_';
    for run in folded.split(|c: char| !(is_word(c) || SEPARATORS.contains(&c))) {
        let token = run.trim_matches(|c: char| SEPARATORS.contains(&c));
        if token.is_empty() {
            continue;
        }
        if !is_stopword(token) {
            tokens.push(token.to_owned());
        }
        if token.contains(|c: char| c == '_' || SEPARATORS.contains(&c)) {
            tokens.extend(
                token
                    .split(|c: char| c == '_' || SEPARATORS.contains(&c))
                    .filter(|part| !part.is_empty() && !is_stopword(part))
                    .map(str::to_owned),
            );
        }
    }
    tokens
}

/// Function words in English and Portuguese, after accent folding. They carry
/// little evidence and otherwise make every question match every note.
fn is_stopword(token: &str) -> bool {
    const STOPWORDS: &[&str] = &[
        "a", "about", "after", "an", "and", "are", "as", "at", "be", "before", "by", "can", "did",
        "do", "does", "for", "from", "how", "i", "if", "in", "into", "is", "it", "its", "may",
        "me", "must", "my", "no", "not", "of", "on", "or", "our", "should", "so", "than", "that",
        "the", "then", "these", "this", "those", "to", "up", "us", "was", "we", "what", "when",
        "where", "which", "who", "why", "with", "you", "your", // English
        "ao", "aos", "as", "com", "como", "da", "das", "de", "do", "dos", "e", "em", "na", "nas",
        "no", "nos", "o", "onde", "os", "para", "pela", "pelo", "por", "qual", "quais", "quando",
        "que", "se", "sem", "um", "uma", "umas", "uns", // Portuguese
    ];
    STOPWORDS.contains(&token)
}

/// Okapi BM25 over a note's key, title, aliases, and tags (counted twice, as
/// they are written to identify the note) plus its body.
pub(super) struct Bm25 {
    docs: Vec<(Uuid, HashMap<String, u32>, usize)>,
    document_frequency: HashMap<String, u32>,
    average_length: f64,
}

impl Bm25 {
    pub(super) fn new(notes: &[Note]) -> Self {
        let mut docs = Vec::with_capacity(notes.len());
        let mut document_frequency: HashMap<String, u32> = HashMap::new();
        let mut total = 0usize;
        for note in notes {
            let labels = format!(
                "{} {} {} {}",
                note.input.key.replace(['-', '_'], " "),
                note.input.title,
                note.input.aliases.join(" "),
                note.input.tags.join(" ")
            );
            let label_tokens = tokenize(&labels);
            let mut terms: HashMap<String, u32> = HashMap::new();
            for token in label_tokens
                .iter()
                .chain(&label_tokens)
                .cloned()
                .chain(tokenize(&note.input.body))
            {
                *terms.entry(token).or_default() += 1;
            }
            let length = terms.values().map(|n| *n as usize).sum::<usize>();
            total += length;
            for term in terms.keys() {
                *document_frequency.entry(term.clone()).or_default() += 1;
            }
            docs.push((note.id, terms, length));
        }
        let average_length = if docs.is_empty() {
            1.0
        } else {
            (total as f64 / docs.len() as f64).max(1.0)
        };
        Self {
            docs,
            document_frequency,
            average_length,
        }
    }

    pub(super) fn scores(&self, query: &str) -> Vec<(Uuid, f64)> {
        let terms: BTreeSet<String> = tokenize(query).into_iter().collect();
        let n = self.docs.len() as f64;
        let mut scores = Vec::new();
        for (id, frequencies, length) in &self.docs {
            let mut score = 0.0;
            for term in &terms {
                let Some(&tf) = frequencies.get(term) else {
                    continue;
                };
                let df = f64::from(self.document_frequency[term]);
                let idf = (1.0 + (n - df + 0.5) / (df + 0.5)).ln();
                let tf = f64::from(tf);
                let norm = 1.0 - BM25_B + BM25_B * *length as f64 / self.average_length;
                score += idf * tf * (BM25_K1 + 1.0) / (tf + BM25_K1 * norm);
            }
            if score > 0.0 {
                scores.push((*id, score));
            }
        }
        scores
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenizer_keeps_identifiers_whole_and_split() {
        assert_eq!(
            tokenize("Error TW-4290: set max_deliver."),
            [
                "error",
                "tw-4290",
                "tw",
                "4290",
                "set",
                "max_deliver",
                "max",
                "deliver"
            ]
        );
        assert_eq!(
            tokenize("Qual é o limite de requisições?"),
            ["limite", "requisicoes"]
        );
        assert_eq!(tokenize("--/--"), Vec::<String>::new());
    }

    #[test]
    fn folding_ignores_case_and_accents() {
        assert_eq!(fold("Gestão de SEGREDOS"), "gestao de segredos");
        assert_eq!(normalize_label("  Dev   Setup "), "dev setup");
    }
}

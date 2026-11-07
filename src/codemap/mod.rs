//! The code map: what each source file of a repository is for and what it
//! defines, for small models that read code. It is its own layer, apart from
//! notes: rows in PostgreSQL with no vectors, so note search never sees them,
//! in the domain the repository's folder is placed in, so vault rules apply.
//!
//! `kioku codemap update` rebuilds it from git: the files that changed since
//! the last indexed commit, read at HEAD. A file's doc comment is its purpose,
//! and a [`Summarizer`] can write one for files without. A lookup re-parses a
//! file whose content changed since, so it never lists stale definitions.
//! This module parses and reads git; [`crate::app`] stores and serves.

mod git;
mod lang;
mod resolve;
mod summarize;
#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub use git::{Change, Repository};
pub use lang::{Language, MAX_FILE_BYTES, Parsed, Symbol, parse};
pub use resolve::FileSet;
pub use summarize::{Source, Summarizer};

/// Neighbouring files a lookup names.
pub const MAX_NEIGHBOURS: usize = 5;
/// Definitions a lookup lists; the rest are counted.
pub const MAX_SHOWN_SYMBOLS: usize = 25;

/// Where a file's purpose came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PurposeSource {
    /// The file's own doc comment.
    Doc,
    /// A summarizer's model.
    Model,
}

impl PurposeSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Doc => "doc",
            Self::Model => "model",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "doc" => Some(Self::Doc),
            "model" => Some(Self::Model),
            _ => None,
        }
    }
}

/// One file of the code map.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CodeFile {
    pub path: String,
    pub language: Language,
    /// SHA-256 of the content the entry describes, in hex.
    #[serde(skip)]
    pub digest: String,
    pub purpose: Option<String>,
    pub purpose_source: Option<PurposeSource>,
    pub symbols: Vec<Symbol>,
    /// The repository's files it imports, in import order.
    pub imports: Vec<String>,
}

impl CodeFile {
    /// The entry for `text`. Its doc comment is its purpose; without one, it
    /// keeps the model-written purpose of `previous`, if any, until a
    /// summarizer writes a new one.
    pub fn build(
        path: &str,
        language: Language,
        text: &str,
        files: &FileSet,
        previous: Option<&CodeFile>,
    ) -> Self {
        let parsed = parse(language, text);
        let imports = files.resolve(language, path, &parsed.imports);
        let (purpose, purpose_source) = match parsed.purpose {
            Some(doc) => (Some(doc), Some(PurposeSource::Doc)),
            None => match previous {
                Some(old) if old.purpose_source == Some(PurposeSource::Model) => {
                    (old.purpose.clone(), old.purpose_source)
                }
                _ => (None, None),
            },
        };
        Self {
            path: path.to_owned(),
            language,
            digest: digest(text),
            purpose,
            purpose_source,
            symbols: parsed.symbols,
            imports,
        }
    }

    /// Up to `limit` definitions to show: public ones first, then the
    /// rest, in line order.
    pub fn main_symbols(&self, limit: usize) -> Vec<&Symbol> {
        let mut shown: Vec<&Symbol> = self
            .symbols
            .iter()
            .filter(|s| s.public)
            .take(limit)
            .collect();
        if shown.len() < limit {
            let room = limit - shown.len();
            shown.extend(self.symbols.iter().filter(|s| !s.public).take(room));
        }
        shown.sort_by_key(|symbol| symbol.line);
        shown
    }
}

/// SHA-256 of `text`, in hex.
pub fn digest(text: &str) -> String {
    crate::access::hex(&Sha256::digest(text.as_bytes()))
}

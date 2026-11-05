//! Reading Open Knowledge Format (OKF) bundles as Kioku notes.
//!
//! OKF v0.2 (<https://github.com/GoogleCloudPlatform/open-knowledge-format>)
//! is a folder of Markdown concepts with YAML frontmatter. Kioku reads it by
//! the spec rather than through a converted copy:
//!
//! - Each concept becomes a note keyed by its concept ID, the file's path in
//!   the bundle without `.md`. A producer's `id` and `aliases` become
//!   aliases, so `DEC-350` finds its note. The note's source is the concept's
//!   own file, so a re-import after `git pull` updates only what changed.
//! - Links between concepts become `related` links. In the stored text a link
//!   keeps its words, plus the target's id when they lack it.
//! - `index.md` and `log.md` are navigation and history, not concepts, and
//!   are skipped: the link graph replaces them.
//! - A concept too long to embed well becomes a hub note, keyed by its concept
//!   ID, and one note per section, keyed `<concept ID>#<anchor>` with the
//!   anchor GitHub gives the heading, so a link to `/x.md#parts` reaches the
//!   section holding that heading.
//! - Each note opens with a line of facts: type and id, lifecycle (`status`),
//!   the trust tier `verified` gives, `stale_after`, the producer's other
//!   plain fields (a decision's status and who made it, say), who wrote it,
//!   and the resource it describes. Trust also sets the note's confidence.
//! - `status: deprecated` makes a concept's notes legacy; the importer
//!   applies it, and retires notes whose concept left the bundle.

mod concept;
mod links;
mod split;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, ensure};
use serde::Serialize;

use crate::markdown;
use crate::model::NoteInput;
use crate::text::truncate_chars;

use concept::Concept;
use links::{Target, Targets};

/// The largest note an OKF import writes, facts line included. It keeps a
/// note within a 2,048-token embedding model, and focused enough to rank.
pub const NOTE_BYTES: usize = 4_000;
/// The largest concept file an import reads.
const MAX_CONCEPT_BYTES: u64 = 4 * 1024 * 1024;
/// Most concept files one import may read.
const MAX_CONCEPTS: usize = 10_000;
/// Kioku's limits on one note's lists and title.
const MAX_RELATED: usize = 128;
const MAX_LABELS: usize = 64;
const MAX_TITLE_BYTES: usize = 512;
const MAX_KEY_BYTES: usize = 256;
/// The hub shows at most this much of a long description.
const HUB_DESCRIPTION_CHARS: usize = 600;

/// The `okf_version` a bundle-root `index.md` declares, or `None` when `dir`
/// has no such file, it can't be read, or it declares no version.
pub fn bundle_version(dir: &Path) -> Option<String> {
    let index = dir.join("index.md");
    if !dir.is_dir() || !index.is_file() {
        return None;
    }
    let text = std::fs::read_to_string(&index).ok()?;
    let text = text.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let Ok((Some(yaml), _)) = markdown::frontmatter(&text) else {
        return None;
    };
    #[derive(serde::Deserialize, Default)]
    #[serde(default)]
    struct Root {
        okf_version: Option<serde_json::Value>,
    }
    let root: Root =
        serde_saphyr::from_str_with_options(yaml, serde_saphyr::options! { strict_booleans: true })
            .unwrap_or_default();
    root.okf_version.and_then(|v| match v {
        serde_json::Value::String(s) => Some(s.trim().to_owned()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    })
}

/// The bundle folder at or above `dir`, up to and including `stop`.
pub fn enclosing_bundle(dir: &Path, stop: &Path) -> Option<PathBuf> {
    dir.ancestors()
        .take_while(|d| d.starts_with(stop))
        .find(|d| bundle_version(d).is_some())
        .map(Path::to_path_buf)
}

/// `text` cut to at most `max` bytes at a character boundary, ending in `…`
/// when cut.
fn truncate_bytes(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    format!(
        "{}…",
        split::prefix_bytes(text, max.saturating_sub('…'.len_utf8()))
    )
}

/// The concept files of a bundle, read from disk.
pub struct Bundle {
    /// Canonical path of the bundle root.
    pub root: PathBuf,
    pub version: Option<String>,
    /// Each concept file's bundle path (with `/` separators), with its text or
    /// why it could not be read.
    files: Vec<(String, Result<String>)>,
}

impl Bundle {
    /// Read every concept file under `root`: `.md` files other than
    /// `index.md` and `log.md`, skipping hidden files and folders and never
    /// following links out of the bundle. This blocks.
    pub fn read(root: &Path) -> Result<Self> {
        let root = root
            .canonicalize()
            .with_context(|| format!("bundle {} does not exist", root.display()))?;
        ensure!(
            root.is_dir(),
            "an OKF bundle is a folder: {}",
            root.display()
        );
        let version = bundle_version(&root);
        let mut files = Vec::new();
        for entry in walkdir::WalkDir::new(&root)
            .follow_links(false)
            .sort_by_file_name()
            .into_iter()
            .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'))
        {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy();
            if !entry.file_type().is_file()
                || !name.ends_with(".md")
                || matches!(name.as_ref(), "index.md" | "log.md")
            {
                continue;
            }
            let real = entry.path().canonicalize()?;
            ensure!(
                real.starts_with(&root),
                "{} resolves outside the bundle",
                entry.path().display()
            );
            let relative = real
                .strip_prefix(&root)
                .map(|p| {
                    p.components()
                        .map(|c| c.as_os_str().to_string_lossy())
                        .collect::<Vec<_>>()
                        .join("/")
                })
                .unwrap_or_default();
            let text = entry
                .metadata()
                .context("cannot read the file")
                .and_then(|metadata| {
                    ensure!(
                        metadata.len() <= MAX_CONCEPT_BYTES,
                        "exceeds 4 MiB, the largest concept an import reads"
                    );
                    std::fs::read_to_string(&real).context("cannot read the file as UTF-8 text")
                });
            files.push((relative, text));
            ensure!(
                files.len() <= MAX_CONCEPTS,
                "an import is limited to {MAX_CONCEPTS} concepts"
            );
        }
        Ok(Self {
            root,
            version,
            files,
        })
    }

    /// Bundle paths of every concept file found, readable or not.
    pub fn paths(&self) -> impl Iterator<Item = &str> {
        self.files.iter().map(|(path, _)| path.as_str())
    }

    /// The absolute source a note from bundle path `path` records.
    fn source(&self, path: &str, anchor: Option<&str>) -> String {
        let file = self.root.join(path).to_string_lossy().into_owned();
        match anchor {
            Some(anchor) => format!("{file}#{anchor}"),
            None => file,
        }
    }
}

/// One note made from a concept.
#[derive(Debug, Clone)]
pub struct OkfNote {
    /// The concept's bundle path.
    pub file: String,
    /// What reports show: the bundle path, plus `#anchor` for a section.
    pub path: String,
    pub input: NoteInput,
    /// The concept is deprecated, so the note should be legacy.
    pub deprecated: bool,
}

/// What an import read from a bundle.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Summary {
    pub okf_version: Option<String>,
    /// Concept files read, and how many were split into sections.
    pub concepts: usize,
    pub split: usize,
    pub sections: usize,
    pub deprecated: usize,
    /// Links that reached another concept, and links to concept files the
    /// bundle lacks (kept as plain words, as the spec asks).
    pub links: usize,
    pub broken_links: usize,
    /// Links past Kioku's 128 per note, kept in the text but not in the graph.
    pub links_over_limit: usize,
}

pub struct Conversion {
    pub notes: Vec<OkfNote>,
    /// Concept files that could not be read or parsed: (bundle path, reason).
    pub failed: Vec<(String, String)>,
    pub summary: Summary,
}

/// Turn a bundle's concepts into notes in `domain`.
pub fn convert(bundle: &Bundle, domain: &str) -> Conversion {
    let mut failed = Vec::new();
    let mut concepts = Vec::new();
    for (path, text) in &bundle.files {
        match text
            .as_ref()
            .map_err(|e| format!("{e:#}"))
            .and_then(|text| concept::parse(path, text).map_err(|e| format!("{e:#}")))
        {
            Ok(concept) => concepts.push(concept),
            Err(reason) => failed.push((path.clone(), reason)),
        }
    }
    let mut summary = Summary {
        okf_version: bundle.version.clone(),
        concepts: concepts.len(),
        ..Summary::default()
    };

    // Plan splits first, measuring text as it will be stored, so links with
    // anchors can then point at the section that holds the heading.
    let mut targets: Targets = concepts
        .iter()
        .map(|c| {
            let target = Target {
                short: c.producer_id.clone(),
                title: c.title.clone(),
                anchors: HashMap::new(),
                lock: c.lock.clone(),
            };
            (c.id.clone(), target)
        })
        .collect();
    let mut plans: HashMap<String, Vec<split::Piece>> = HashMap::new();
    for concept in &concepts {
        let measure = |text: &str| {
            links::rewrite(text, &concept.path, &concept.id, &concept.lock, &targets)
                .text
                .len()
        };
        if measure(&concept.body) <= single_budget(concept) {
            continue;
        }
        let budget = NOTE_BYTES.saturating_sub(concept.section_facts().len() + 2);
        let max_anchor = MAX_KEY_BYTES.saturating_sub(concept.id.len() + 1);
        let pieces = split::split(&concept.body, budget, max_anchor, &measure);
        plans.insert(concept.id.clone(), pieces);
    }
    for (id, pieces) in &plans {
        if let Some(target) = targets.get_mut(id) {
            // Headings first, so a generated name (`intro`, `-part-2`) never
            // takes the place of a real heading's anchor.
            for piece in pieces {
                let key = format!("{id}#{}", piece.anchor);
                for anchor in &piece.anchors {
                    target
                        .anchors
                        .entry(anchor.clone())
                        .or_insert_with(|| key.clone());
                }
            }
            for piece in pieces {
                let key = format!("{id}#{}", piece.anchor);
                target.anchors.entry(piece.anchor.clone()).or_insert(key);
            }
        }
    }

    let mut notes = Vec::new();
    for concept in &concepts {
        if concept.deprecated() {
            summary.deprecated += 1;
        }
        let maker = Maker {
            bundle,
            concept,
            domain,
        };
        match plans.get(&concept.id) {
            None => {
                let rewritten = links::rewrite(
                    &concept.body,
                    &concept.path,
                    &concept.id,
                    &concept.lock,
                    &targets,
                );
                summary.links += rewritten.links;
                summary.broken_links += rewritten.broken;
                let mut body = concept.facts();
                if let Some(description) = concept.description_unless_repeated() {
                    body.push('\n');
                    body.push_str(description);
                }
                if !rewritten.text.is_empty() {
                    body.push_str("\n\n");
                    body.push_str(&rewritten.text);
                }
                notes.push(maker.note(
                    None,
                    concept.title.clone(),
                    body,
                    rewritten.related,
                    &mut summary,
                ));
            }
            Some(pieces) => {
                summary.split += 1;
                summary.sections += pieces.len();
                notes.push(maker.hub(pieces, &mut summary));
                for piece in pieces {
                    let rewritten = links::rewrite(
                        &piece.text,
                        &concept.path,
                        &concept.id,
                        &concept.lock,
                        &targets,
                    );
                    summary.links += rewritten.links;
                    summary.broken_links += rewritten.broken;
                    let mut related = vec![concept.id.clone()];
                    related.extend(rewritten.related);
                    let body = format!("{}\n\n{}", concept.section_facts(), rewritten.text);
                    let title = format!("{}: {}", concept.title, piece.heading);
                    notes.push(maker.note(Some(&piece.anchor), title, body, related, &mut summary));
                }
            }
        }
    }
    Conversion {
        notes,
        failed,
        summary,
    }
}

/// Room for a concept's text in a note of its own: what the facts line, the
/// description (when the body doesn't open with it) and separators leave.
fn single_budget(concept: &Concept) -> usize {
    let description = concept
        .description_unless_repeated()
        .map_or(0, |d| d.len() + 1);
    NOTE_BYTES.saturating_sub(concept.facts().len() + description + 2)
}

struct Maker<'a> {
    bundle: &'a Bundle,
    concept: &'a Concept,
    domain: &'a str,
}

impl Maker<'_> {
    /// The hub of a split concept: its facts, description, and sections.
    fn hub(&self, pieces: &[split::Piece], summary: &mut Summary) -> OkfNote {
        let concept = self.concept;
        let mut body = concept.facts();
        if let Some(description) = &concept.description {
            body.push_str("\n\n");
            body.push_str(&truncate_chars(description, HUB_DESCRIPTION_CHARS));
        }
        body.push_str(&format!(
            "\n\nThis concept is split into {} sections, each a note keyed {}#<anchor>:",
            pieces.len(),
            concept.id
        ));
        for (n, piece) in pieces.iter().enumerate() {
            let line = format!("\n- {} (#{})", piece.heading, piece.anchor);
            if body.len() + line.len() > NOTE_BYTES - 40 {
                body.push_str(&format!("\n- and {} more", pieces.len() - n));
                break;
            }
            body.push_str(&line);
        }
        let related = pieces
            .iter()
            .map(|p| format!("{}#{}", concept.id, p.anchor))
            .collect();
        self.note(None, concept.title.clone(), body, related, summary)
    }

    fn note(
        &self,
        anchor: Option<&str>,
        title: String,
        body: String,
        mut related: Vec<String>,
        summary: &mut Summary,
    ) -> OkfNote {
        let concept = self.concept;
        let key = match anchor {
            Some(anchor) => format!("{}#{anchor}", concept.id),
            None => concept.id.clone(),
        };
        let mut aliases = Vec::new();
        if let Some(id) = &concept.producer_id {
            aliases.push(match anchor {
                Some(anchor) => format!("{id}#{anchor}"),
                None => id.clone(),
            });
        }
        if anchor.is_none() {
            aliases.extend(concept.aliases.iter().cloned());
        }
        aliases.retain(|a| *a != key && a.len() <= 512);
        aliases.dedup();
        aliases.truncate(MAX_LABELS);
        let mut tags = concept.tags.clone();
        let kind = concept.kind_tag();
        if !kind.is_empty() && !tags.contains(&kind) {
            tags.push(kind);
        }
        tags.retain(|t| t.len() <= 512);
        tags.truncate(MAX_LABELS);
        related.retain(|r| *r != key);
        if related.len() > MAX_RELATED {
            summary.links_over_limit += related.len() - MAX_RELATED;
            related.truncate(MAX_RELATED);
        }
        OkfNote {
            file: concept.path.clone(),
            path: match anchor {
                Some(anchor) => format!("{}#{anchor}", concept.path),
                None => concept.path.clone(),
            },
            input: NoteInput {
                domain: self.domain.to_owned(),
                key,
                title: truncate_bytes(&title, MAX_TITLE_BYTES),
                body,
                aliases,
                related,
                tags,
                source: Some(self.bundle.source(&concept.path, anchor)),
                confidence: concept.confidence(),
                pinned: concept.pinned,
                lock: concept.lock.clone(),
            },
            deprecated: concept.deprecated(),
        }
    }
}

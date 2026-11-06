//! Links between concepts: resolving bundle-relative and relative paths,
//! and rewriting them in a note's text to the words a reader needs.

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::{Captures, Regex};

use crate::text::truncate_chars;

use super::split::Fences;

/// `[label](href "title")`, with an optional leading `!` for images.
static LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(!?)\[([^\]\n]*)\]\((<[^>\n]*>|[^)\s]+)(?:\s+"[^"\n]*")?\)"#)
        .unwrap_or_else(|_| unreachable!("constant pattern"))
});

/// Where a link points.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Href {
    /// A URL with a scheme, such as `https:` or `mailto:`.
    External,
    /// A concept file, by concept ID, with an optional heading anchor.
    Concept { id: String, anchor: Option<String> },
    /// An `index.md`, a `log.md`, a folder, or another kind of file.
    Navigation,
    /// A heading in the same concept.
    SameConcept,
    /// A path that leaves the bundle.
    Outside,
}

/// Resolve `href` written in the concept at `from` (a bundle path such as
/// `kb/decisions/x.md`). `/`-prefixed paths are bundle-relative; others are
/// relative to the concept's folder.
pub(super) fn resolve(from: &str, href: &str) -> Href {
    let href = href.trim_start_matches('<').trim_end_matches('>');
    if href.contains("://") || href.starts_with("mailto:") || href.starts_with("tel:") {
        return Href::External;
    }
    let (path, anchor) = match href.split_once('#') {
        Some((path, anchor)) => (path, Some(anchor)),
        None => (href, None),
    };
    if path.is_empty() {
        return Href::SameConcept;
    }
    let path = percent_decoded(path);
    let mut parts: Vec<&str> = if path.starts_with('/') {
        Vec::new()
    } else {
        from.rsplit_once('/')
            .map(|(dir, _)| dir.split('/').collect())
            .unwrap_or_default()
    };
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Href::Outside;
                }
            }
            part => parts.push(part),
        }
    }
    let Some(name) = parts.last() else {
        return Href::Navigation;
    };
    if path.ends_with('/') || matches!(*name, "index.md" | "log.md") {
        return Href::Navigation;
    }
    match parts.join("/").strip_suffix(".md") {
        Some(id) => Href::Concept {
            id: id.to_owned(),
            anchor: anchor
                .filter(|a| !a.is_empty())
                .map(|a| percent_decoded(a).to_lowercase()),
        },
        None => Href::Navigation,
    }
}

/// `%XX` escapes decoded as UTF-8; anything malformed is kept as written.
fn percent_decoded(text: &str) -> String {
    if !text.contains('%') {
        return text.to_owned();
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        match (
            bytes[i],
            bytes.get(i + 1).copied().and_then(hex),
            bytes.get(i + 2).copied().and_then(hex),
        ) {
            (b'%', Some(high), Some(low)) => {
                out.push((high * 16 + low) as u8);
                i += 3;
            }
            (byte, _, _) => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| text.to_owned())
}

/// What a link to a concept shows and reaches.
#[derive(Clone, Debug)]
pub(super) struct Target {
    /// The producer's id (`ADR-350`), the shortest name a reader can look up.
    pub short: Option<String>,
    pub title: String,
    /// Heading anchors to the note holding that heading, for split concepts.
    pub anchors: HashMap<String, String>,
    /// Providers the concept is locked to; empty means no lock.
    pub lock: Vec<String>,
}

impl Target {
    fn name(&self) -> String {
        self.short
            .clone()
            .unwrap_or_else(|| truncate_chars(&self.title, 80))
    }
}

/// Every concept a link may reach, by concept ID.
pub(super) type Targets = HashMap<String, Target>;

#[derive(Debug, Default)]
pub(super) struct Rewritten {
    pub text: String,
    /// Note keys the text links to, in order of first appearance.
    pub related: Vec<String>,
    pub links: usize,
    /// Links to concept files the bundle doesn't have. The spec asks
    /// consumers to tolerate them: they may be knowledge not yet written.
    pub broken: usize,
}

/// Rewrite the links in `text` (from the concept at `from`, whose own notes
/// have keys starting with `own`): a link to another concept keeps its words,
/// adds the target's id when the words lack it, and records the target's key.
/// A list item that is only links becomes a list of ids. Links inside code
/// fences, images and external URLs are left as written.
///
/// The words of a link to a locked concept are kept as the author wrote them,
/// without the target's id or title, unless every provider that may read
/// this note may also read the target (`lock` is this concept's lock).
pub(super) fn rewrite(
    text: &str,
    from: &str,
    own: &str,
    lock: &[String],
    targets: &Targets,
) -> Rewritten {
    let mut out = Rewritten::default();
    let mut fences = Fences::default();
    let mut lines = Vec::new();
    for line in text.split('\n') {
        if fences.code(line) || !line.contains("](") {
            lines.push(line.to_owned());
            continue;
        }
        let compact = is_link_list(line, from, targets);
        let rewritten = LINK.replace_all(line, |caps: &Captures<'_>| {
            let (whole, bang, label, href) = (&caps[0], &caps[1], &caps[2], &caps[3]);
            if !bang.is_empty() {
                return whole.to_owned();
            }
            match resolve(from, href) {
                Href::External => whole.to_owned(),
                Href::Concept { id, anchor } => match targets.get(&id) {
                    Some(target) => {
                        out.links += 1;
                        let key = anchor
                            .and_then(|a| target.anchors.get(&a).cloned())
                            .unwrap_or_else(|| id.clone());
                        let own_key = key == own || key.starts_with(&format!("{own}#"));
                        if !own_key && !out.related.contains(&key) {
                            out.related.push(key);
                        }
                        if reveals(lock, &target.lock) {
                            shown(label, target, compact)
                        } else if label.trim().is_empty() {
                            "a linked note".to_owned()
                        } else {
                            label.to_owned()
                        }
                    }
                    None => {
                        out.broken += 1;
                        label.to_owned()
                    }
                },
                Href::Navigation | Href::SameConcept | Href::Outside => label.to_owned(),
            }
        });
        lines.push(rewritten.into_owned());
    }
    out.text = lines.join("\n");
    out
}

/// Whether a note locked to `reader` (empty: no lock) may show the name of a
/// concept locked to `target`: only when everyone who may read the note may
/// read the target too.
fn reveals(reader: &[String], target: &[String]) -> bool {
    target.is_empty() || (!reader.is_empty() && reader.iter().all(|p| target.contains(p)))
}

/// The words a link to `target` keeps.
fn shown(label: &str, target: &Target, compact: bool) -> String {
    if compact || label.trim().is_empty() {
        return target.name();
    }
    match &target.short {
        Some(short) if !label.to_lowercase().contains(&short.to_lowercase()) => {
            format!("{label} ({short})")
        }
        _ => label.to_owned(),
    }
}

/// A list item made of three or more concept links and little else, such as
/// `* Questions: [Q-009: ...](...), [Q-019: ...](...), ...`.
fn is_link_list(line: &str, from: &str, targets: &Targets) -> bool {
    let trimmed = line.trim_start();
    let item = trimmed
        .strip_prefix("* ")
        .or_else(|| trimmed.strip_prefix("- "))
        .or_else(|| trimmed.strip_prefix("+ "))
        .or_else(|| {
            let digits = trimmed.bytes().take_while(u8::is_ascii_digit).count();
            (digits > 0)
                .then(|| trimmed[digits..].strip_prefix(". "))
                .flatten()
        });
    let Some(item) = item else {
        return false;
    };
    let concept_links = LINK
        .captures_iter(item)
        .filter(|caps| caps[1].is_empty())
        .filter(|caps| {
            matches!(resolve(from, &caps[3]), Href::Concept { ref id, .. } if targets.contains_key(id))
        })
        .count();
    if concept_links < 3 {
        return false;
    }
    let rest = LINK.replace_all(item, "");
    let rest = match rest.split_once(':') {
        Some((lead, rest)) if lead.chars().count() <= 60 => rest.to_owned(),
        _ => rest.into_owned(),
    };
    rest.chars()
        .filter(|c| !c.is_whitespace() && !",;:.()-–—".contains(*c))
        .count()
        <= 12
}

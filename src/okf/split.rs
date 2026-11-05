//! Splitting a concept too long for one note into sections at its headings.
//!
//! A section that fits the budget is one piece. One that doesn't splits at
//! its next heading level; one with no headings left is packed into parts by
//! paragraph, table row, and sentence. Code blocks stay whole when they fit;
//! a longer one is cut by lines, and every part is fenced again. Sizes come
//! from a caller-supplied measure, so they can count the text as it will be
//! stored (with links already shortened).

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

/// Text before a section's first subheading shorter than this joins the
/// first subsection instead of becoming a piece of its own.
const LEAD_BYTES: usize = 600;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Piece {
    /// Unique within the concept: the anchor of the heading the piece starts
    /// at, `intro` for text before any heading, `-part-N` for later parts.
    pub anchor: String,
    /// Heading path, such as `Parts › Router`.
    pub heading: String,
    pub text: String,
    /// Anchors of the headings inside the piece, so links that name any of
    /// them reach it.
    pub anchors: Vec<String>,
}

/// Code fences as CommonMark reads them: an opening run of three or more
/// backticks or tildes (indented at most three spaces) closes only on a run
/// of the same character at least as long, with nothing after it.
#[derive(Debug, Default, Clone)]
pub(super) struct Fences {
    open: Option<(u8, usize)>,
}

impl Fences {
    /// Whether `line` belongs to a code block (its fence lines included).
    pub fn code(&mut self, line: &str) -> bool {
        let trimmed = line.trim_start_matches(' ');
        if line.len() - trimmed.len() > 3 {
            return self.open.is_some();
        }
        let run = |c: u8| trimmed.bytes().take_while(|b| *b == c).count();
        match self.open {
            Some((c, n)) => {
                let r = run(c);
                if r >= n && trimmed[r..].trim().is_empty() {
                    self.open = None;
                }
                true
            }
            None => {
                for c in *b"`~" {
                    let r = run(c);
                    if r >= 3 && (c == b'~' || !trimmed[r..].contains('`')) {
                        self.open = Some((c, r));
                        return true;
                    }
                }
                false
            }
        }
    }
}

struct Heading {
    line: usize,
    level: usize,
    text: String,
    anchor: String,
}

static INLINE_LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"!?\[([^\]]*)\]\([^)]*\)").unwrap_or_else(|_| unreachable!("constant pattern"))
});
static HTML_TAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"</?[A-Za-z][^>]*>").unwrap_or_else(|_| unreachable!("constant pattern"))
});
static UNDERSCORE_EMPHASIS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(^|[^\w])_{1,2}([^_]+?)_{1,2}([^\w]|$)")
        .unwrap_or_else(|_| unreachable!("constant pattern"))
});

/// The anchor GitHub gives a heading: of its rendered text (links and images
/// reduced to their words, emphasis, code marks and HTML tags dropped),
/// lowercase, characters other than letters, digits, spaces, `-` and `_`
/// dropped, spaces turned into `-`.
pub(super) fn anchor(heading: &str) -> String {
    let text = INLINE_LINK.replace_all(heading, "$1");
    let text = HTML_TAG.replace_all(&text, "");
    let text = UNDERSCORE_EMPHASIS.replace_all(&text, "$1$2$3");
    text.trim()
        .to_lowercase()
        .chars()
        .filter_map(|c| match c {
            ' ' => Some('-'),
            c if c.is_alphanumeric() || c == '-' || c == '_' => Some(c),
            _ => None,
        })
        .collect()
}

fn heading(line: &str) -> Option<(usize, String)> {
    let level = line.bytes().take_while(|b| *b == b'#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let rest = line[level..].strip_prefix(' ')?;
    let text = rest.trim().trim_end_matches('#').trim();
    (!text.is_empty()).then(|| (level, text.to_owned()))
}

/// Headings outside code blocks, with GitHub's anchors (`-1`, `-2` for repeats).
fn headings(lines: &[&str]) -> Vec<Heading> {
    let mut out = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut fences = Fences::default();
    for (index, line) in lines.iter().enumerate() {
        if fences.code(line) {
            continue;
        }
        if let Some((level, text)) = heading(line) {
            let base = anchor(&text);
            let mut unique = base.clone();
            let mut n = 1;
            while !seen.insert(unique.clone()) {
                unique = format!("{base}-{n}");
                n += 1;
            }
            out.push(Heading {
                line: index,
                level,
                text,
                anchor: unique,
            });
        }
    }
    out
}

/// The longest prefix of `text` with at most `max` bytes, cut at a character boundary.
pub(super) fn prefix_bytes(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Split `body` into pieces of at most `budget` bytes as `size` measures
/// them. Piece anchors stay within `max_anchor` bytes. A single sentence
/// longer than the budget is cut at a space.
pub(super) fn split(
    body: &str,
    budget: usize,
    max_anchor: usize,
    size: &dyn Fn(&str) -> usize,
) -> Vec<Piece> {
    let lines: Vec<&str> = body.split('\n').collect();
    let heads = headings(&lines);
    let max_anchor = max_anchor.max(8);
    // Real heading anchors are reserved, so `intro` and `-part-N` names never
    // take one and send a link meant for the heading somewhere else.
    let reserved = heads
        .iter()
        .map(|h| prefix_bytes(&h.anchor, max_anchor).to_owned())
        .collect();
    let mut splitter = Splitter {
        heads,
        lines,
        budget: budget.max(200),
        max_anchor,
        size,
        pieces: Vec::new(),
        used: HashSet::new(),
        reserved,
    };
    let end = splitter.lines.len();
    splitter.visit(0, end, None, "", String::new(), Vec::new());
    splitter.pieces
}

struct Splitter<'a> {
    lines: Vec<&'a str>,
    heads: Vec<Heading>,
    budget: usize,
    max_anchor: usize,
    size: &'a dyn Fn(&str) -> usize,
    pieces: Vec<Piece>,
    used: HashSet<String>,
    reserved: HashSet<String>,
}

impl Splitter<'_> {
    fn join(&self, start: usize, end: usize) -> String {
        self.lines[start..end].join("\n").trim().to_owned()
    }

    fn anchors_in(&self, start: usize, end: usize) -> Vec<String> {
        self.heads
            .iter()
            .filter(|h| (start..end).contains(&h.line))
            .map(|h| h.anchor.clone())
            .collect()
    }

    /// A unique piece anchor based on `base`. A synthetic one (`intro`,
    /// `-part-N`) also avoids every real heading anchor.
    fn claim(&mut self, base: &str, synthetic: bool) -> String {
        let base = prefix_bytes(base, self.max_anchor).to_owned();
        let taken = |s: &Self, c: &str| s.used.contains(c) || (synthetic && s.reserved.contains(c));
        let mut candidate = base.clone();
        let mut n = 2;
        while taken(self, &candidate) {
            let suffix = format!("-{n}");
            let room = self.max_anchor.saturating_sub(suffix.len());
            candidate = format!("{}{suffix}", prefix_bytes(&base, room));
            n += 1;
        }
        self.used.insert(candidate.clone());
        candidate
    }

    /// The lines `start..end`, a section headed by `own` (an index into
    /// `heads`) or the text before any heading. `prefix` is a short lead
    /// carried down from the parent section, and `extra` its anchors.
    fn visit(
        &mut self,
        start: usize,
        end: usize,
        own: Option<usize>,
        path: &str,
        prefix: String,
        extra: Vec<String>,
    ) {
        let text = with_prefix(&prefix, &self.join(start, end));
        if text.is_empty() {
            return;
        }
        let first = if own.is_some() { start + 1 } else { start };
        let inner: Vec<usize> = (0..self.heads.len())
            .filter(|i| (first..end).contains(&self.heads[*i].line))
            .collect();
        if (self.size)(&text) <= self.budget || inner.is_empty() {
            let mut anchors = extra;
            anchors.extend(self.anchors_in(start, end));
            self.leaf(own, path, text, anchors);
            return;
        }
        let level = inner
            .iter()
            .map(|i| self.heads[*i].level)
            .min()
            .unwrap_or(1);
        let children: Vec<usize> = inner
            .into_iter()
            .filter(|i| self.heads[*i].level == level)
            .collect();
        let lead_end = self.heads[children[0]].line;
        let lead = with_prefix(&prefix, &self.join(start, lead_end));
        let lead_body = self.join(first, lead_end);
        let mut carry = String::new();
        let mut carry_anchors = extra;
        // Every heading in the lead (the section's own, and deeper ones
        // before the first child) points at wherever the lead's text goes.
        carry_anchors.extend(self.anchors_in(start, lead_end));
        if !lead_body.is_empty() && (self.size)(&lead) >= LEAD_BYTES {
            let anchors = std::mem::take(&mut carry_anchors);
            self.leaf(own, path, lead, anchors);
        } else {
            carry = lead;
        }
        for (n, child) in children.iter().enumerate() {
            let child_end = children
                .get(n + 1)
                .map_or(end, |next| self.heads[*next].line);
            let child_path = match path {
                "" => self.heads[*child].text.clone(),
                parent => format!("{parent} › {}", self.heads[*child].text),
            };
            let (prefix, extra) = if n == 0 {
                (
                    std::mem::take(&mut carry),
                    std::mem::take(&mut carry_anchors),
                )
            } else {
                (String::new(), Vec::new())
            };
            self.visit(
                self.heads[*child].line,
                child_end,
                Some(*child),
                &child_path,
                prefix,
                extra,
            );
        }
    }

    /// One section with no headings left to split at: one piece, or parts.
    fn leaf(&mut self, own: Option<usize>, path: &str, text: String, anchors: Vec<String>) {
        let heading = if path.is_empty() {
            "Introduction"
        } else {
            path
        };
        let parts = if (self.size)(&text) <= self.budget {
            vec![text]
        } else {
            pack(&text, self.budget, self.size)
        };
        let count = parts.len();
        let mut anchors = Some(anchors);
        let mut base = String::new();
        for (n, part) in parts.into_iter().enumerate() {
            let anchor = match (n, own) {
                (0, Some(i)) => {
                    let real = self.heads[i].anchor.clone();
                    self.claim(&real, false)
                }
                (0, None) => self.claim("intro", true),
                _ => self.claim(&format!("{base}-part-{}", n + 1), true),
            };
            if n == 0 {
                base = anchor.clone();
            }
            let heading = if count > 1 {
                format!("{heading} (part {} of {count})", n + 1)
            } else {
                heading.to_owned()
            };
            self.pieces.push(Piece {
                anchor,
                heading,
                text: part,
                anchors: anchors.take().unwrap_or_default(),
            });
        }
    }
}

fn with_prefix(prefix: &str, text: &str) -> String {
    match (prefix.is_empty(), text.is_empty()) {
        (true, _) => text.to_owned(),
        (false, true) => prefix.to_owned(),
        (false, false) => format!("{prefix}\n\n{text}"),
    }
}

/// Paragraphs, tables and code blocks, separated by blank lines outside code.
fn blocks(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    let mut fences = Fences::default();
    for line in text.split('\n') {
        let code = fences.code(line);
        if !code && line.trim().is_empty() {
            if !current.is_empty() {
                out.push(current.join("\n"));
                current.clear();
            }
            continue;
        }
        current.push(line);
    }
    if !current.is_empty() {
        out.push(current.join("\n"));
    }
    out
}

/// Pack blocks greedily into parts of at most `budget`.
fn pack(text: &str, budget: usize, size: &dyn Fn(&str) -> usize) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    for block in blocks(text) {
        let pieces = if size(&block) <= budget {
            vec![block]
        } else {
            split_block(&block, budget, size)
        };
        for piece in pieces {
            let joined = with_prefix(&current, &piece);
            if !current.is_empty() && size(&joined) > budget {
                parts.push(std::mem::replace(&mut current, piece));
            } else {
                current = joined;
            }
        }
    }
    if !current.is_empty() {
        parts.push(current);
    }
    parts
}

fn is_table(lines: &[&str]) -> bool {
    lines.len() > 2
        && lines[0].trim_start().starts_with('|')
        && lines[1]
            .trim()
            .chars()
            .all(|c| matches!(c, '|' | '-' | ':' | ' '))
        && lines[1].contains('-')
}

/// A block over the budget: a code block by lines with its fences repeated
/// in every part, a table by rows with its header repeated, anything else by
/// lines and sentences.
fn split_block(block: &str, budget: usize, size: &dyn Fn(&str) -> usize) -> Vec<String> {
    let lines: Vec<&str> = block.split('\n').collect();
    if let Some(parts) = split_code(&lines, budget, size) {
        return parts;
    }
    if !is_table(&lines) {
        return split_text(block, budget, size);
    }
    let head = lines[..2].join("\n");
    let mut parts = Vec::new();
    let mut rows: Vec<&str> = Vec::new();
    for row in &lines[2..] {
        let alone = format!("{head}\n{row}");
        if size(&alone) > budget {
            if !rows.is_empty() {
                parts.push(format!("{head}\n{}", rows.join("\n")));
                rows.clear();
            }
            parts.extend(split_text(row, budget, size));
            continue;
        }
        let candidate = format!("{head}\n{}\n{row}", rows.join("\n"));
        if !rows.is_empty() && size(&candidate) > budget {
            parts.push(format!("{head}\n{}", rows.join("\n")));
            rows.clear();
        }
        rows.push(row);
    }
    if !rows.is_empty() {
        parts.push(format!("{head}\n{}", rows.join("\n")));
    }
    parts
}

/// A fenced code block cut by lines, each part opened with the block's own
/// fence line (info string included) and closed again, so no part leaves a
/// fence open for the text after it. `None` when the block isn't code.
fn split_code(lines: &[&str], budget: usize, size: &dyn Fn(&str) -> usize) -> Option<Vec<String>> {
    let opener = *lines.first()?;
    let mut fences = Fences::default();
    if !fences.code(opener) {
        return None;
    }
    let (mark, run) = fences.open?;
    let closer = String::from_utf8(vec![mark; run]).ok()?;
    // The block's last line closes it when it is a run of the same mark at
    // least as long; an unclosed block is closed in every part anyway.
    let closes = |line: &str| {
        let trimmed = line.trim();
        trimmed.len() >= run && trimmed.bytes().all(|b| b == mark)
    };
    let mut body = &lines[1..];
    if body.last().is_some_and(|last| closes(last)) {
        body = &body[..body.len() - 1];
    }
    let wrap = |inner: &[&str]| format!("{opener}\n{}\n{closer}", inner.join("\n"));
    let room = budget
        .saturating_sub(opener.len() + closer.len() + 2)
        .max(40);
    let mut parts = Vec::new();
    let mut current: Vec<String> = Vec::new();
    for line in body {
        let pieces: Vec<String> = if line.len() > room {
            let mut rest = *line;
            let mut cut = Vec::new();
            while rest.len() > room {
                let head = prefix_bytes(rest, room);
                cut.push(head.to_owned());
                rest = &rest[head.len()..];
            }
            cut.push(rest.to_owned());
            cut
        } else {
            vec![(*line).to_owned()]
        };
        for piece in pieces {
            let mut candidate: Vec<&str> = current.iter().map(String::as_str).collect();
            candidate.push(&piece);
            if !current.is_empty() && size(&wrap(&candidate)) > budget {
                let done: Vec<&str> = current.iter().map(String::as_str).collect();
                parts.push(wrap(&done));
                current.clear();
            }
            current.push(piece);
        }
    }
    if !current.is_empty() {
        let done: Vec<&str> = current.iter().map(String::as_str).collect();
        parts.push(wrap(&done));
    }
    Some(parts)
}

/// Lines, then sentences, then (for one sentence over the budget) cuts at a
/// space or a character boundary.
fn split_text(text: &str, budget: usize, size: &dyn Fn(&str) -> usize) -> Vec<String> {
    let mut pieces: Vec<String> = Vec::new();
    for line in text.split('\n') {
        if size(line) <= budget {
            pieces.push(line.to_owned());
        } else {
            pieces.extend(sentences(line));
        }
    }
    let mut parts = Vec::new();
    let mut current = String::new();
    for mut piece in pieces {
        while size(&piece) > budget {
            let cut = cut_at(&piece, budget);
            if !current.is_empty() {
                parts.push(std::mem::take(&mut current));
            }
            parts.push(piece[..cut].trim_end().to_owned());
            piece = piece[cut..].trim_start().to_owned();
        }
        let joined = if current.is_empty() {
            piece.clone()
        } else {
            format!("{current}\n{piece}")
        };
        if !current.is_empty() && size(&joined) > budget {
            parts.push(std::mem::replace(&mut current, piece));
        } else {
            current = joined;
        }
    }
    if !current.is_empty() {
        parts.push(current);
    }
    parts.retain(|p| !p.trim().is_empty());
    parts
}

/// Sentences of one line: a break after `.`, `;`, `!` or `?` and whitespace.
fn sentences(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut start = 0;
    let bytes = line.as_bytes();
    for (i, c) in line.char_indices() {
        if matches!(c, '.' | ';' | '!' | '?')
            && bytes.get(i + 1).is_some_and(u8::is_ascii_whitespace)
        {
            out.push(line[start..=i].trim().to_owned());
            start = i + 1;
        }
    }
    out.push(line[start..].trim().to_owned());
    out.retain(|s| !s.is_empty());
    out
}

/// Where to cut `text` so the first part has at most `budget` bytes: the
/// last space before that point, or the last character boundary.
fn cut_at(text: &str, budget: usize) -> usize {
    let boundary = prefix_bytes(text, budget).len();
    match text[..boundary].rfind(' ') {
        Some(space) if space > budget / 2 => space,
        _ if boundary == 0 => text.chars().next().map_or(text.len(), char::len_utf8),
        _ => boundary,
    }
}

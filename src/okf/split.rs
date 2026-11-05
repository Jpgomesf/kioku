//! Splitting a concept too long for one note into sections at its headings.
//!
//! A section that fits the budget is one piece. One that doesn't splits at
//! its next heading level; one with no headings left is packed into parts by
//! paragraph, table row, and sentence. Code blocks stay whole when they fit.
//! Sizes come from a caller-supplied measure, so they can count the text as
//! it will be stored (with links already shortened).

use std::collections::HashSet;

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

struct Heading {
    line: usize,
    level: usize,
    text: String,
    anchor: String,
}

/// The anchor GitHub gives a heading: lowercase, characters other than
/// letters, digits, spaces, `-` and `_` dropped, spaces turned into `-`.
pub(super) fn anchor(heading: &str) -> String {
    heading
        .trim()
        .to_lowercase()
        .chars()
        .filter_map(|c| match c {
            ' ' => Some('-'),
            c if c.is_alphanumeric() || c == '-' || c == '_' => Some(c),
            _ => None,
        })
        .collect()
}

fn fence(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with("```") || trimmed.starts_with("~~~")
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

/// Headings outside code fences, with GitHub's anchors (`-1`, `-2` for repeats).
fn headings(lines: &[&str]) -> Vec<Heading> {
    let mut out = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut fenced = false;
    for (index, line) in lines.iter().enumerate() {
        if fence(line) {
            fenced = !fenced;
            continue;
        }
        if fenced {
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

/// Split `body` into pieces of at most `budget` bytes as `size` measures
/// them. A single sentence longer than the budget is cut at a space.
pub(super) fn split(body: &str, budget: usize, size: &dyn Fn(&str) -> usize) -> Vec<Piece> {
    let lines: Vec<&str> = body.split('\n').collect();
    let mut splitter = Splitter {
        heads: headings(&lines),
        lines,
        budget: budget.max(200),
        size,
        pieces: Vec::new(),
        used: HashSet::new(),
    };
    let end = splitter.lines.len();
    splitter.visit(0, end, None, "", String::new(), Vec::new());
    splitter.pieces
}

struct Splitter<'a> {
    lines: Vec<&'a str>,
    heads: Vec<Heading>,
    budget: usize,
    size: &'a dyn Fn(&str) -> usize,
    pieces: Vec<Piece>,
    used: HashSet<String>,
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

    fn unique(&mut self, base: &str) -> String {
        let mut candidate = base.to_owned();
        let mut n = 2;
        while !self.used.insert(candidate.clone()) {
            candidate = format!("{base}-{n}");
            n += 1;
        }
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
        if !lead_body.is_empty() && (self.size)(&lead) >= LEAD_BYTES {
            let mut anchors = std::mem::take(&mut carry_anchors);
            anchors.extend(self.anchors_in(start, lead_end));
            self.leaf(own, path, lead, anchors);
        } else {
            carry = lead;
            carry_anchors.extend(own.map(|i| self.heads[i].anchor.clone()));
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
        let base = own.map_or_else(|| "intro".to_owned(), |i| self.heads[i].anchor.clone());
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
        for (n, part) in parts.into_iter().enumerate() {
            let wanted = if n == 0 {
                base.clone()
            } else {
                format!("{base}-part-{}", n + 1)
            };
            let anchor = self.unique(&wanted);
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

/// Paragraphs, tables and code blocks, separated by blank lines outside fences.
fn blocks(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    let mut fenced = false;
    for line in text.split('\n') {
        if fence(line) {
            fenced = !fenced;
        }
        if !fenced && line.trim().is_empty() {
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

/// A block over the budget: a table by rows with its header repeated in
/// every part, anything else by lines and sentences.
fn split_block(block: &str, budget: usize, size: &dyn Fn(&str) -> usize) -> Vec<String> {
    let lines: Vec<&str> = block.split('\n').collect();
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
    let mut boundary = budget.min(text.len());
    while !text.is_char_boundary(boundary) {
        boundary -= 1;
    }
    match text[..boundary].rfind(' ') {
        Some(space) if space > budget / 2 => space,
        _ if boundary == 0 => text.chars().next().map_or(text.len(), char::len_utf8),
        _ => boundary,
    }
}

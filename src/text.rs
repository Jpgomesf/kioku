//! Small text helpers.

use std::ops::Range;

/// Truncate by Unicode scalar count, including the ellipsis in the requested cap.
pub fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_owned();
    }
    if max_chars == 0 {
        return String::new();
    }
    let mut result: String = text.chars().take(max_chars - 1).collect();
    result.push('…');
    result
}

/// Byte ranges of the sentences, list items, headings, and code blocks of a
/// Markdown note, in order and trimmed of surrounding whitespace.
///
/// Blank lines, headings, and list markers always start a new span, and a
/// fenced code block stays whole. Inside prose, a sentence ends at `.`, `!`,
/// or `?` followed by whitespace and then an uppercase letter, a digit, or an
/// opening quote, bracket, or backtick, so "e.g. this" stays together.
pub fn sentence_spans(text: &str) -> Vec<Range<usize>> {
    let mut blocks: Vec<Range<usize>> = Vec::new();
    let mut current: Option<Range<usize>> = None;
    let mut fence: Option<usize> = None;
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let (start, end) = (offset, offset + line.len());
        offset = end;
        let trimmed = line.trim();
        if let Some(fence_start) = fence {
            if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
                blocks.push(fence_start..end);
                fence = None;
            }
            continue;
        }
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            blocks.extend(current.take());
            fence = Some(start);
            continue;
        }
        if trimmed.is_empty() {
            blocks.extend(current.take());
            continue;
        }
        if trimmed.starts_with('#') {
            blocks.extend(current.take());
            blocks.push(start..end);
            continue;
        }
        let starts_block = is_list_item(trimmed);
        match &mut current {
            Some(block) if !starts_block => block.end = end,
            _ => {
                blocks.extend(current.take());
                current = Some(start..end);
            }
        }
    }
    blocks.extend(current);
    if let Some(fence_start) = fence {
        blocks.push(fence_start..text.len());
    }

    let mut spans = Vec::new();
    for block in blocks {
        let slice = &text[block.clone()];
        let is_code =
            slice.trim_start().starts_with("```") || slice.trim_start().starts_with("~~~");
        let mut piece_start = 0;
        if !is_code {
            let chars: Vec<(usize, char)> = slice.char_indices().collect();
            for (i, &(at, c)) in chars.iter().enumerate() {
                if !matches!(c, '.' | '!' | '?') {
                    continue;
                }
                let Some(&(_, next)) = chars.get(i + 1) else {
                    continue;
                };
                if !next.is_whitespace() {
                    continue;
                }
                let following = chars[i + 1..].iter().find(|(_, ch)| !ch.is_whitespace());
                if following.is_some_and(|(_, ch)| {
                    ch.is_uppercase()
                        || ch.is_ascii_digit()
                        || matches!(ch, '"' | '\'' | '`' | '(' | '[' | '*')
                }) {
                    push_trimmed(
                        &mut spans,
                        text,
                        block.start + piece_start..block.start + at + c.len_utf8(),
                    );
                    piece_start = at + c.len_utf8();
                }
            }
        }
        push_trimmed(&mut spans, text, block.start + piece_start..block.end);
    }
    spans
}

fn is_list_item(line: &str) -> bool {
    if line.starts_with("- ") || line.starts_with("* ") || line.starts_with("+ ") {
        return true;
    }
    let digits = line.bytes().take_while(u8::is_ascii_digit).count();
    digits > 0 && matches!(line.as_bytes().get(digits..digits + 2), Some(b". " | b") "))
}

fn push_trimmed(spans: &mut Vec<Range<usize>>, text: &str, range: Range<usize>) {
    let slice = &text[range.clone()];
    let leading = slice.len() - slice.trim_start().len();
    let trailing = slice.len() - slice.trim_end().len();
    if leading + trailing < slice.len() {
        spans.push(range.start + leading..range.end - trailing);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncation_is_unicode_safe_and_respects_exact_cap() {
        assert_eq!(truncate_chars("ação 日本語", 5), "ação…");
        assert_eq!(truncate_chars("日本", 1), "…");
        assert_eq!(truncate_chars("日本", 0), "");
        assert_eq!(truncate_chars("ação", 4), "ação");
    }

    fn pieces(text: &str) -> Vec<&str> {
        sentence_spans(text).into_iter().map(|r| &text[r]).collect()
    }

    #[test]
    fn sentences_split_across_wrapped_lines() {
        let text = "Messages that exhaust their five delivery attempts move to the MEDIA_DLQ\nstream. The on-call engineer reviews it at 09:00 UTC, e.g. on weekdays.\n";
        assert_eq!(
            pieces(text),
            [
                "Messages that exhaust their five delivery attempts move to the MEDIA_DLQ\nstream.",
                "The on-call engineer reviews it at 09:00 UTC, e.g. on weekdays."
            ]
        );
    }

    #[test]
    fn headings_lists_and_code_are_their_own_spans() {
        let text = "# Setup\nRun it. Then check.\n\n- first item\n  continues here\n2. second item\n\n```sh\nmake check. Done.\n```\nAfter code.";
        assert_eq!(
            pieces(text),
            [
                "# Setup",
                "Run it.",
                "Then check.",
                "- first item\n  continues here",
                "2. second item",
                "```sh\nmake check. Done.\n```",
                "After code."
            ]
        );
    }

    #[test]
    fn spans_are_valid_utf8_slices_covering_all_words() {
        let text = "Ação concluída. Próximo passo? Sim!  Fim 日本.";
        let spans = pieces(text);
        assert_eq!(
            spans,
            ["Ação concluída.", "Próximo passo?", "Sim!", "Fim 日本."]
        );
        assert!(sentence_spans("").is_empty());
        assert!(sentence_spans("  \n\n ").is_empty());
        assert_eq!(
            pieces("no terminal punctuation"),
            ["no terminal punctuation"]
        );
    }
}

//! Small text helpers.

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
}

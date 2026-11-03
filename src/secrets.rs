//! Detection of credentials that should never be saved as memories.
//!
//! This is a guard against an agent copying a token from a terminal or file
//! into a note, not a complete secret scanner. It looks for formats with a
//! distinctive shape, so ordinary prose does not trigger it.

use crate::model::NoteInput;

/// The kind of credential found in a note, if any.
pub fn find(input: &NoteInput) -> Option<&'static str> {
    std::iter::once(&input.title)
        .chain(std::iter::once(&input.body))
        .chain(&input.aliases)
        .chain(&input.tags)
        .chain(input.source.as_ref())
        .find_map(|text| scan(text))
}

fn scan(text: &str) -> Option<&'static str> {
    if text.contains("PRIVATE KEY-----") {
        return Some("a private key");
    }
    for (prefix, min_len, kind) in [
        ("AKIA", 16, "an AWS access key"),
        ("ASIA", 16, "an AWS access key"),
        ("ghp_", 30, "a GitHub token"),
        ("gho_", 30, "a GitHub token"),
        ("ghu_", 30, "a GitHub token"),
        ("ghs_", 30, "a GitHub token"),
        ("ghr_", 30, "a GitHub token"),
        ("github_pat_", 30, "a GitHub token"),
        ("glpat-", 20, "a GitLab token"),
        ("xoxb-", 20, "a Slack token"),
        ("xoxp-", 20, "a Slack token"),
        ("xoxa-", 20, "a Slack token"),
        ("sk-", 32, "an API key"),
    ] {
        if has_token(text, prefix, min_len) {
            return Some(kind);
        }
    }
    if text.split_whitespace().any(is_jwt) {
        return Some("a JSON Web Token");
    }
    None
}

/// `prefix` at a word boundary followed by at least `min_len` token characters.
fn has_token(text: &str, prefix: &str, min_len: usize) -> bool {
    let is_token_char = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
    text.match_indices(prefix).any(|(start, _)| {
        let boundary = text[..start]
            .chars()
            .next_back()
            .is_none_or(|c| !is_token_char(c));
        let rest = text[start + prefix.len()..]
            .chars()
            .take_while(|c| is_token_char(*c))
            .count();
        boundary && rest >= min_len
    })
}

fn is_jwt(word: &str) -> bool {
    let word = word
        .trim_matches(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.'));
    let parts: Vec<&str> = word.split('.').collect();
    parts.len() == 3
        && parts[0].starts_with("eyJ")
        && parts[1].starts_with("eyJ")
        && parts.iter().all(|p| {
            p.len() >= 10
                && p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_common_credential_formats() {
        // Test values are assembled at runtime so no token-shaped literal is committed.
        let pem = format!("-----BEGIN OPENSSH {} KEY-----", "PRIVATE");
        let aws = format!("key {}{} here", "AKIA", "IOSFODNN7EXAMPLE");
        let github = format!("token {}{}", "ghp_", "a".repeat(36));
        let api = format!("OPENAI_API_KEY={}{}", "sk-proj-", "x".repeat(40));
        let jwt = format!(
            "Authorization: Bearer {}.{}.{}",
            ["eyJ", "hbGciOiJIUzI1NiJ9"].concat(),
            ["eyJ", "zdWIiOiIxMjM0NTY3ODkwIn0"].concat(),
            "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
        );
        assert_eq!(scan(&pem), Some("a private key"));
        assert_eq!(scan(&aws), Some("an AWS access key"));
        assert_eq!(scan(&github), Some("a GitHub token"));
        assert_eq!(scan(&api), Some("an API key"));
        assert_eq!(scan(&jwt), Some("a JSON Web Token"));
    }

    #[test]
    fn ordinary_prose_is_not_flagged() {
        for text in [
            "Ask the desk team; risk-based checks run nightly.",
            "Use the sk-learn wrapper for clustering.",
            "AKIA is the prefix of AWS access keys.",
            "The task-runner and disk-usage dashboards are in Grafana.",
            "Version v1.2.3 tags look like eyJ.notatoken.x",
        ] {
            assert_eq!(scan(text), None, "{text}");
        }
    }
}

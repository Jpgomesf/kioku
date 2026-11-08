//! Code paths a note governs: globs relative to a repository's root, such as
//! `src/vault/**` or `viewer/src/pages/vaults/*.tsx`. A file's code map entry,
//! and the hook a client runs when a file is opened, name the notes anchored
//! to it. A note that anchors to code says which code a decision governs; it
//! never describes the code.

/// Most paths one note may name.
pub const MAX_PATHS: usize = 32;

/// Why `glob` can't anchor a note, if it can't.
pub fn invalid(glob: &str) -> Option<&'static str> {
    if glob.trim().is_empty() || glob.len() > 256 {
        return Some("must contain 1-256 bytes");
    }
    if glob.starts_with('/') || glob.contains('\\') {
        return Some("must be relative to the repository root, with / between folders");
    }
    if glob.split('/').any(|part| part == ".." || part == ".") {
        return Some("must not contain . or .. segments");
    }
    if glob.chars().any(char::is_control) {
        return Some("must not contain control characters");
    }
    None
}

/// Whether the repository-relative `path` matches `glob`. `*` matches within
/// one path segment, `**` any number of whole segments (none included), and
/// `?` one character. A glob without wildcards names a file, or a folder and
/// everything under it.
pub fn matches(glob: &str, path: &str) -> bool {
    let glob = glob.trim().trim_end_matches('/');
    if !glob.contains(['*', '?']) {
        return path == glob
            || path
                .strip_prefix(glob)
                .is_some_and(|rest| rest.starts_with('/'));
    }
    let pattern: Vec<&str> = glob.split('/').collect();
    let segments: Vec<&str> = path.split('/').collect();
    match_segments(&pattern, &segments)
}

fn match_segments(pattern: &[&str], path: &[&str]) -> bool {
    match pattern.split_first() {
        None => path.is_empty(),
        Some((&"**", rest)) => (0..=path.len()).any(|skip| match_segments(rest, &path[skip..])),
        Some((first, rest)) => match path.split_first() {
            Some((segment, tail)) => match_segment(first, segment) && match_segments(rest, tail),
            None => false,
        },
    }
}

/// `*` and `?` within one segment, with backtracking to the last `*`.
fn match_segment(pattern: &str, text: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let text: Vec<char> = text.chars().collect();
    let (mut p, mut t) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while t < text.len() {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == text[t]) {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some((p, t));
            p += 1;
        } else if let Some((star_p, star_t)) = star {
            p = star_p + 1;
            t = star_t + 1;
            star = Some((star_p, star_t + 1));
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|c| *c == '*')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_paths_name_a_file_or_a_folder() {
        assert!(matches("src/vault/place.rs", "src/vault/place.rs"));
        assert!(matches("src/vault", "src/vault/place.rs"));
        assert!(matches("src/vault/", "src/vault/config/mod.rs"));
        assert!(!matches("src/vault", "src/vaults.rs"));
        assert!(!matches("src/vault/place.rs", "src/vault/place.rs.bak"));
    }

    #[test]
    fn wildcards_stay_in_their_segments() {
        assert!(matches("src/*.rs", "src/main.rs"));
        assert!(!matches("src/*.rs", "src/app/mod.rs"));
        assert!(matches("src/**/*.rs", "src/main.rs"));
        assert!(matches("src/**/*.rs", "src/app/codemap.rs"));
        assert!(matches("src/**", "src/app/codemap.rs"));
        assert!(matches("**/tests.rs", "src/vault/tests.rs"));
        assert!(matches(
            "viewer/src/pages/*/index.tsx",
            "viewer/src/pages/vaults/index.tsx"
        ));
        assert!(matches("src/?ain.rs", "src/main.rs"));
        assert!(!matches("src/?ain.rs", "src/brain.rs"));
        assert!(matches("src/a*b*c.rs", "src/aXXbYYc.rs"));
        assert!(!matches("src/a*b*c.rs", "src/aXXbYY.rs"));
    }

    #[test]
    fn globs_that_cannot_anchor_a_note() {
        assert!(invalid("src/vault/**").is_none());
        assert!(invalid("").is_some());
        assert!(invalid("/etc/passwd").is_some());
        assert!(invalid("../other/repo").is_some());
        assert!(invalid("src/./x").is_some());
        assert!(invalid("src\\win").is_some());
        assert!(invalid(&"a".repeat(300)).is_some());
    }
}

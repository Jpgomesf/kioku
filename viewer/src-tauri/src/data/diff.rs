//! A line diff for previews: longest common subsequence, then only the
//! changed lines and a little context around them.

use crate::commands::vaults::{DiffLine, DiffLineKind};

/// Unchanged lines kept on each side of a change.
pub const CONTEXT: usize = 2;

/// Every line of `old` and `new`, marked added, removed or unchanged, with
/// each line's index in `old` when it has one.
fn full(old: &[&str], new: &[&str]) -> Vec<(DiffLine, Option<usize>)> {
    let (n, m) = (old.len(), new.len());
    // lcs[i][j]: length of the common subsequence of old[i..] and new[j..].
    let mut lcs = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if old[i] == new[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }
    let line = |kind, text: &str| DiffLine {
        kind,
        text: text.to_owned(),
    };
    let (mut i, mut j) = (0, 0);
    let mut out = Vec::with_capacity(n.max(m));
    while i < n || j < m {
        if i < n && j < m && old[i] == new[j] {
            out.push((line(DiffLineKind::Context, old[i]), Some(i)));
            i += 1;
            j += 1;
        } else if i < n && (j == m || lcs[i + 1][j] >= lcs[i][j + 1]) {
            out.push((line(DiffLineKind::Remove, old[i]), Some(i)));
            i += 1;
        } else {
            out.push((line(DiffLineKind::Add, new[j]), None));
            j += 1;
        }
    }
    out
}

/// The changed lines of `old` to `new`, each with up to [`CONTEXT`] unchanged
/// lines around it. Empty when nothing changed.
#[cfg(test)]
pub fn diff(old: &str, new: &str) -> Vec<DiffLine> {
    diff_keeping(old, new, &[])
}

/// As [`diff`], also keeping the unchanged lines of `old` at `keep` (such as
/// the name line of each changed table), so a hunk says where it is.
pub fn diff_keeping(old: &str, new: &str, keep: &[usize]) -> Vec<DiffLine> {
    let old: Vec<&str> = old.lines().collect();
    let new: Vec<&str> = new.lines().collect();
    let lines = full(&old, &new);
    let changed: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, (line, _))| line.kind != DiffLineKind::Context)
        .map(|(i, _)| i)
        .collect();
    if changed.is_empty() {
        return Vec::new();
    }
    lines
        .into_iter()
        .enumerate()
        .filter(|(i, (_, at))| {
            changed.iter().any(|c| c.abs_diff(*i) <= CONTEXT)
                || at.is_some_and(|at| keep.contains(&at))
        })
        .map(|(_, (line, _))| line)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(lines: &[DiffLine]) -> Vec<String> {
        lines
            .iter()
            .map(|l| {
                let mark = match l.kind {
                    DiffLineKind::Add => '+',
                    DiffLineKind::Remove => '-',
                    DiffLineKind::Context => ' ',
                };
                format!("{mark}{}", l.text)
            })
            .collect()
    }

    #[test]
    fn keeps_two_lines_of_context() {
        let old = "a\nb\nc\nd\ne\nf\ng\n";
        let new = "a\nb\nc\nD\ne\nf\ng\n";
        assert_eq!(
            render(&diff(old, new)),
            [" b", " c", "-d", "+D", " e", " f"]
        );
    }

    #[test]
    fn kept_lines_show_outside_the_context() {
        let old = "name\nb\nc\nd\ne\nf\n";
        let new = "name\nb\nc\nd\ne\nF\n";
        assert_eq!(
            render(&diff_keeping(old, new, &[0])),
            [" name", " d", " e", "-f", "+F"]
        );
        assert!(diff_keeping("a\n", "a\n", &[0]).is_empty());
    }

    #[test]
    fn identical_text_has_no_diff() {
        assert!(diff("a\nb\n", "a\nb\n").is_empty());
    }

    #[test]
    fn handles_insertions_at_the_ends() {
        assert_eq!(render(&diff("b", "a\nb\nc")), ["+a", " b", "+c"]);
        assert_eq!(render(&diff("a\nb", "")), ["-a", "-b"]);
    }
}

//! Visibility changes: apply app switches to the vaults file's text in memory, show the
//! diff, and check the result with kioku's own parser. `preview` feeds the review step;
//! `apply_text` gives the text Allow writes, refusing anything the review's checks fail.

use std::path::Path;

use kioku::vault::{Provider, Vaults};

use crate::commands::areas::label;
use crate::commands::vaults::{PreviewCheck, VisibilityChange, VisibilityPreview};
use crate::data::{diff, vaults_file};
use crate::error::{CommandError, CommandResult};

/// Where a `providers = [...]` array sits in the text, by line.
struct Span {
    first: usize,
    /// Inclusive.
    last: usize,
    indent: String,
    /// A `# ...` comment after the array, kept on the new line.
    comment: Option<String>,
}

/// A line without its comment, trimmed. Vaults files keep `#` out of strings
/// in table headers and provider names, so the first `#` starts a comment.
fn code(line: &str) -> &str {
    line.split('#').next().unwrap_or_default().trim()
}

/// Whether `line` is a `[[vault]]` header, allowing inner spaces and a comment.
fn is_vault_header(line: &str) -> bool {
    code(line).replace([' ', '\t'], "") == "[[vault]]"
}

/// The lines of each `[[vault]]` table, with its name.
fn vault_blocks(lines: &[&str]) -> Vec<(String, usize, usize)> {
    let mut blocks = Vec::new();
    let mut start: Option<usize> = None;
    let close = |start: usize, end: usize, blocks: &mut Vec<(String, usize, usize)>| {
        let text = lines[start + 1..end].join("\n");
        if let Ok(vault) = toml::from_str::<NameOnly>(&text) {
            blocks.push((vault.name, start, end));
        }
    };
    for (i, line) in lines.iter().enumerate() {
        if code(line).starts_with('[') {
            if let Some(s) = start.take() {
                close(s, i, &mut blocks);
            }
            if is_vault_header(line) {
                start = Some(i);
            }
        }
    }
    if let Some(s) = start {
        close(s, lines.len(), &mut blocks);
    }
    blocks
}

#[derive(serde::Deserialize)]
struct NameOnly {
    name: String,
}

/// The `providers` array of the vault table at `start..end`.
fn providers_span(lines: &[&str], start: usize, end: usize) -> Option<Span> {
    let first = (start + 1..end).find(|&i| {
        lines[i]
            .trim_start()
            .strip_prefix("providers")
            .is_some_and(|rest| rest.trim_start().starts_with('='))
    })?;
    let mut depth = 0i32;
    for (i, line) in lines.iter().enumerate().take(end).skip(first) {
        let code = line.split('#').next().unwrap_or_default();
        depth += code.matches('[').count() as i32 - code.matches(']').count() as i32;
        if depth <= 0 {
            let indent: String = lines[first]
                .chars()
                .take_while(|c| c.is_whitespace())
                .collect();
            let comment = line.find('#').map(|at| line[at..].trim_end().to_owned());
            return Some(Span {
                first,
                last: i,
                indent,
                comment,
            });
        }
    }
    None
}

/// What one vault's providers become.
struct Edit {
    vault: String,
    before: Vec<Provider>,
    after: Vec<Provider>,
}

/// The providers each changed vault ends with. Later changes to the same
/// provider win; `conflicts` says whether two switches disagreed.
fn plan(text: &str, changes: &[VisibilityChange]) -> CommandResult<(Vec<Edit>, bool)> {
    let parsed = vaults_file::parse(text)?;
    let mut edits: Vec<Edit> = Vec::new();
    let mut seen: Vec<(String, Provider, bool)> = Vec::new();
    let mut conflicts = false;
    for change in changes {
        let app = vaults_file::app(&change.app).ok_or_else(|| {
            CommandError::invalid_argument(format!("unknown app {:?}", change.app))
        })?;
        let vault = parsed
            .vaults
            .iter()
            .find(|v| v.name == change.vault)
            .ok_or_else(|| CommandError::not_found(format!("no vault {:?}", change.vault)))?;
        if let Some((_, _, was)) = seen
            .iter()
            .find(|(v, p, _)| *v == change.vault && *p == app.provider)
        {
            conflicts |= *was != change.can_read;
        }
        seen.push((change.vault.clone(), app.provider, change.can_read));
        let index = match edits.iter().position(|e| e.vault == change.vault) {
            Some(index) => index,
            None => {
                let before = vaults_file::providers(&vault.providers);
                edits.push(Edit {
                    vault: change.vault.clone(),
                    after: before.clone(),
                    before,
                });
                edits.len() - 1
            }
        };
        let after = &mut edits[index].after;
        after.retain(|p| *p != app.provider);
        if change.can_read {
            after.push(app.provider);
        }
    }
    // Keep the file's order, with added providers last in kioku's order.
    for edit in &mut edits {
        let wanted = std::mem::take(&mut edit.after);
        edit.after = edit
            .before
            .iter()
            .copied()
            .filter(|p| wanted.contains(p))
            .chain(
                Provider::ALL
                    .into_iter()
                    .filter(|p| wanted.contains(p) && !edit.before.contains(p)),
            )
            .collect();
    }
    Ok((edits, conflicts))
}

/// `text` with each edit's providers line rewritten.
fn rewrite(text: &str, edits: &[Edit]) -> CommandResult<String> {
    let lines: Vec<&str> = text.lines().collect();
    let blocks = vault_blocks(&lines);
    let mut replacements: Vec<(Span, String)> = Vec::new();
    for edit in edits.iter().filter(|e| e.before != e.after) {
        let (_, start, end) = blocks
            .iter()
            .find(|(name, _, _)| *name == edit.vault)
            .ok_or_else(|| CommandError::not_found(format!("no vault {:?}", edit.vault)))?;
        let span = providers_span(&lines, *start, *end).ok_or_else(|| {
            CommandError::invalid_argument(format!(
                "vault {:?} has no providers line to change",
                edit.vault
            ))
        })?;
        let list: Vec<String> = edit
            .after
            .iter()
            .map(|p| format!("{:?}", p.as_str()))
            .collect();
        let mut line = format!("{}providers = [{}]", span.indent, list.join(", "));
        if let Some(comment) = &span.comment {
            line.push_str("  ");
            line.push_str(comment);
        }
        replacements.push((span, line));
    }
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut i = 0;
    while i < lines.len() {
        if let Some((span, line)) = replacements.iter().find(|(s, _)| s.first == i) {
            out.push(line.clone());
            i = span.last + 1;
        } else {
            out.push(lines[i].to_owned());
            i += 1;
        }
    }
    let mut joined = out.join("\n");
    if text.ends_with('\n') {
        joined.push('\n');
    }
    Ok(joined)
}

/// What the review says, in plain words. `locked` lists, per vault and
/// provider, the areas a lock still hides; `embedding_reader` is a hosted
/// embedding service's provider, which reads what that provider may read.
fn sentences(
    edits: &[Edit],
    locked: &dyn Fn(&str, Provider) -> Vec<String>,
    embedding_reader: Option<Provider>,
) -> Vec<String> {
    let mut out = Vec::new();
    for edit in edits {
        for provider in Provider::ALL {
            let names = vaults_file::app_names(provider);
            let gains = match (
                edit.before.contains(&provider),
                edit.after.contains(&provider),
            ) {
                (false, true) => true,
                (true, false) => false,
                _ => continue,
            };
            if gains {
                let hidden: Vec<String> = locked(&edit.vault, provider)
                    .iter()
                    .map(|domain| label(domain, &edit.vault))
                    .collect();
                if hidden.is_empty() {
                    out.push(format!("{names} can read {}.", edit.vault));
                } else {
                    out.push(format!(
                        "{names} can read {}, except {} (locked).",
                        edit.vault,
                        hidden.join(", ")
                    ));
                }
            } else {
                out.push(format!("{names} can no longer read {}.", edit.vault));
            }
            if embedding_reader == Some(provider) {
                out.push(if gains {
                    format!("The embedding service also gets the notes of {}.", edit.vault)
                } else {
                    format!(
                        "The embedding service stops getting the notes of {}, so search there matches words only.",
                        edit.vault
                    )
                });
            }
        }
    }
    if out.is_empty() {
        out.push("Nothing changes.".to_owned());
    }
    out
}

/// The vaults file's new text for `changes`: the text the review previewed, refused when any
/// of the review's three checks would fail.
pub fn apply_text(text: &str, file: &Path, changes: &[VisibilityChange]) -> CommandResult<String> {
    let (edits, conflicts) = plan(text, changes)?;
    if conflicts {
        return Err(CommandError::invalid_argument(
            "apps that share a model provider disagree",
        ));
    }
    if edits.iter().any(|e| e.after.is_empty()) {
        return Err(CommandError::invalid_argument(
            "a changed vault would have no app that can read it",
        ));
    }
    let new = rewrite(text, &edits)?;
    vaults_file::validate(&new, file).map_err(|error| {
        CommandError::invalid_argument(format!("Kioku doesn't accept the new file: {error:#}"))
    })?;
    Ok(new)
}

/// The preview of `changes` to the vaults file `text` at `file`.
pub fn preview(
    text: &str,
    file: &Path,
    changes: &[VisibilityChange],
    embedding_reader: Option<Provider>,
) -> CommandResult<VisibilityPreview> {
    let (edits, conflicts) = plan(text, changes)?;
    let new = rewrite(text, &edits)?;
    let checked: Option<Vaults> = vaults_file::validate(&new, file).ok();
    let parses = checked.is_some();
    let readable = edits.iter().all(|e| !e.after.is_empty());
    let parsed_new = vaults_file::parse(&new).ok();
    let locked = |vault: &str, provider: Provider| -> Vec<String> {
        match (&parsed_new, &checked) {
            (Some(parsed), Some(checked)) => parsed.locked_areas(checked, vault, provider),
            _ => Vec::new(),
        }
    };
    // Keep each changed vault's `name = ...` line in view, so every hunk
    // says which vault it belongs to.
    let lines: Vec<&str> = text.lines().collect();
    let names: Vec<usize> = vault_blocks(&lines)
        .into_iter()
        .filter(|(name, _, _)| {
            edits
                .iter()
                .any(|e| e.before != e.after && e.vault == *name)
        })
        .filter_map(|(_, start, end)| {
            (start + 1..end).find(|&i| {
                code(lines[i])
                    .strip_prefix("name")
                    .is_some_and(|rest| rest.trim_start().starts_with('='))
            })
        })
        .collect();
    Ok(VisibilityPreview {
        summary: sentences(&edits, &locked, embedding_reader),
        diff: diff::diff_keeping(text, &new, &names),
        checks: vec![
            PreviewCheck {
                label: "Kioku accepts the new file".to_owned(),
                passed: parses,
            },
            PreviewCheck {
                label: "Every changed vault keeps an app that can read it".to_owned(),
                passed: readable,
            },
            PreviewCheck {
                label: "Apps that share a model provider agree".to_owned(),
                passed: !conflicts,
            },
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::vaults::DiffLineKind;
    use crate::data::vaults_file::tests::SAMPLE;

    fn change(vault: &str, app: &str, can_read: bool) -> VisibilityChange {
        VisibilityChange {
            vault: vault.into(),
            app: app.into(),
            can_read,
        }
    }

    const FILE: &str = "/cfg/vaults.toml";

    #[test]
    fn turning_an_app_on_adds_its_provider() -> CommandResult<()> {
        let p = preview(
            SAMPLE,
            Path::new(FILE),
            &[change("personal", "codex", true)],
            None,
        )?;
        assert_eq!(p.summary, ["Codex can read personal."]);
        let removed: Vec<&str> = p
            .diff
            .iter()
            .filter(|l| l.kind == DiffLineKind::Remove)
            .map(|l| l.text.as_str())
            .collect();
        let added: Vec<&str> = p
            .diff
            .iter()
            .filter(|l| l.kind == DiffLineKind::Add)
            .map(|l| l.text.as_str())
            .collect();
        assert_eq!(removed, [r#"providers = ["anthropic", "local"]"#]);
        assert_eq!(added, [r#"providers = ["anthropic", "local", "openai"]"#]);
        assert!(p.checks.iter().all(|c| c.passed));
        Ok(())
    }

    #[test]
    fn multi_line_arrays_are_replaced_whole() -> CommandResult<()> {
        let p = preview(
            SAMPLE,
            Path::new(FILE),
            &[change("work", "claude-code", true)],
            None,
        )?;
        let removed = p
            .diff
            .iter()
            .filter(|l| l.kind == DiffLineKind::Remove)
            .count();
        assert_eq!(removed, 3);
        assert_eq!(p.summary, ["Claude Code and Claude Desktop can read work."]);
        assert!(p.checks.iter().all(|c| c.passed));
        Ok(())
    }

    #[test]
    fn removing_the_last_reader_fails_the_checks() -> CommandResult<()> {
        let p = preview(
            SAMPLE,
            Path::new(FILE),
            &[change("work", "kilo", false)],
            None,
        )?;
        assert_eq!(
            p.summary,
            ["Kilo with local models can no longer read work."]
        );
        assert!(!p.checks[0].passed);
        assert!(!p.checks[1].passed);
        Ok(())
    }

    #[test]
    fn shared_providers_must_agree() -> CommandResult<()> {
        let p = preview(
            SAMPLE,
            Path::new(FILE),
            &[
                change("personal", "claude-code", false),
                change("personal", "claude-desktop", true),
            ],
            None,
        )?;
        assert!(!p.checks[2].passed);
        Ok(())
    }

    #[test]
    fn no_op_changes_leave_the_file_alone() -> CommandResult<()> {
        let p = preview(
            SAMPLE,
            Path::new(FILE),
            &[change("personal", "kilo", true)],
            None,
        )?;
        assert!(p.diff.is_empty());
        assert_eq!(p.summary, ["Nothing changes."]);
        Ok(())
    }

    #[test]
    fn headers_with_comments_and_trailing_comments_are_kept() -> CommandResult<()> {
        let text = SAMPLE
            .replacen(
                "[[vault]]\nname = \"work\"",
                "[[ vault ]]  # work\nname = \"work\"",
                1,
            )
            .replace(
                r#"providers = ["anthropic", "local"]"#,
                r#"providers = ["anthropic", "local"]  # trusted"#,
            );
        let p = preview(
            &text,
            Path::new(FILE),
            &[
                change("work", "claude-code", true),
                change("personal", "codex", true),
            ],
            None,
        )?;
        let added: Vec<&str> = p
            .diff
            .iter()
            .filter(|l| l.kind == DiffLineKind::Add)
            .map(|l| l.text.as_str())
            .collect();
        assert!(added.contains(&r#"providers = ["anthropic", "local", "openai"]  # trusted"#));
        assert!(p.checks[0].passed);
        // Each hunk names its vault.
        assert!(p.diff.iter().any(|l| l.text == r#"name = "personal""#));
        assert!(p.diff.iter().any(|l| l.text == r#"name = "work""#));
        Ok(())
    }

    #[test]
    fn review_names_locked_areas_and_the_embedding_service() -> CommandResult<()> {
        let text = vaults_file::tests::LOCKED.replace(r#"["local"]"#, r#"["local", "anthropic"]"#);
        let p = preview(
            &text,
            Path::new(FILE),
            &[change("personal", "codex", true)],
            Some(Provider::OpenAi),
        )?;
        assert_eq!(
            p.summary,
            [
                "Codex can read personal, except kioku (locked).",
                "The embedding service also gets the notes of personal.",
            ]
        );
        Ok(())
    }

    #[test]
    fn unknown_names_are_errors() {
        let err = preview(
            SAMPLE,
            Path::new(FILE),
            &[change("nope", "kilo", true)],
            None,
        );
        assert_eq!(err.err().map(|e| e.code), Some("not_found".to_owned()));
        let err = preview(
            SAMPLE,
            Path::new(FILE),
            &[change("work", "nope", true)],
            None,
        );
        assert_eq!(
            err.err().map(|e| e.code),
            Some("invalid_argument".to_owned())
        );
    }
}

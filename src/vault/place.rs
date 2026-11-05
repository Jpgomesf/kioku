//! Placing a session in a vault: by the git remote of the repository it runs
//! in, else by the most specific configured folder that contains it.
//!
//! The remote is read from the nearest enclosing repository's `config` file
//! (worktrees and submodules included). No network and no `git` binary are
//! needed, and a repository that can't be read simply has no remotes.

use std::path::{Path, PathBuf};

use super::Vaults;
use super::config::lexical;

/// Where a folder puts a session.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Spot {
    pub(super) vault: usize,
    /// The area whose folder is the longest prefix, if any.
    pub(super) area: Option<String>,
}

impl Vaults {
    /// Place a session started in `folder`. `Err` explains an ambiguity.
    pub(super) fn place(&self, folder: &Path) -> Result<Option<Spot>, String> {
        let forms = spellings(folder);
        let vault = match self.by_remote(&remotes(folder))? {
            Some(vault) => Some(vault),
            None => self.by_folder(&forms)?,
        };
        Ok(vault.map(|vault| Spot {
            vault,
            area: self.area_for(vault, &forms),
        }))
    }

    /// The vault whose `git_remotes` match the first remote that matches any.
    fn by_remote(&self, remotes: &[String]) -> Result<Option<usize>, String> {
        for remote in remotes {
            let matching: Vec<usize> = (0..self.vaults.len())
                .filter(|i| {
                    self.vaults[*i]
                        .git_remotes
                        .iter()
                        .any(|pattern| pattern.matches(remote))
                })
                .collect();
            match matching.as_slice() {
                [] => {}
                [only] => return Ok(Some(*only)),
                several => {
                    return Err(format!(
                        "its git remote {remote} matches the git_remotes of vaults {}",
                        self.names(several)
                    ));
                }
            }
        }
        Ok(None)
    }

    /// The vault with the longest folder containing the session's folder.
    fn by_folder(&self, forms: &[PathBuf]) -> Result<Option<usize>, String> {
        let depths: Vec<(usize, usize)> = self
            .vaults
            .iter()
            .enumerate()
            .filter_map(|(i, vault)| {
                let depth = vault
                    .paths
                    .iter()
                    .filter_map(|folder| folder.depth_containing(forms))
                    .max()?;
                Some((depth, i))
            })
            .collect();
        let Some(deepest) = depths.iter().map(|(depth, _)| *depth).max() else {
            return Ok(None);
        };
        let best: Vec<usize> = depths
            .iter()
            .filter(|(depth, _)| *depth == deepest)
            .map(|(_, i)| *i)
            .collect();
        match best.as_slice() {
            [only] => Ok(Some(*only)),
            several => Err(format!(
                "its folder is in the paths of vaults {} equally",
                self.names(several)
            )),
        }
    }

    /// The area of `vault` with the longest folder containing the session's.
    /// A tie between two areas leaves the session at the vault's root.
    fn area_for(&self, vault: usize, forms: &[PathBuf]) -> Option<String> {
        let depths: Vec<(usize, &str)> = self
            .areas
            .iter()
            .filter(|area| area.vault == vault)
            .filter_map(|area| {
                let depth = area
                    .paths
                    .iter()
                    .filter_map(|folder| folder.depth_containing(forms))
                    .max()?;
                Some((depth, area.domain.as_str()))
            })
            .collect();
        let deepest = depths.iter().map(|(depth, _)| *depth).max()?;
        let mut best = depths
            .iter()
            .filter(|(depth, _)| *depth == deepest)
            .map(|(_, domain)| *domain);
        let first = best.next()?;
        best.all(|other| other == first).then(|| first.to_owned())
    }

    fn names(&self, indexes: &[usize]) -> String {
        indexes
            .iter()
            .map(|i| format!("{:?}", self.vaults[*i].name))
            .collect::<Vec<_>>()
            .join(" and ")
    }
}

/// The session folder as given (made lexical) and with symlinks resolved.
fn spellings(folder: &Path) -> Vec<PathBuf> {
    let written = lexical(folder);
    let mut forms = vec![written.clone()];
    if let Ok(canonical) = written.canonicalize()
        && canonical != written
    {
        forms.push(canonical);
    }
    forms
}

/// Normalized remotes of the repository enclosing `folder`: `origin` first,
/// then the others in file order.
pub(super) fn remotes(folder: &Path) -> Vec<String> {
    let Some(text) = git_config(folder).and_then(|path| std::fs::read_to_string(path).ok()) else {
        return Vec::new();
    };
    let mut listed = parse_remotes(&text);
    listed.sort_by_key(|(name, _)| name != "origin");
    let mut out: Vec<String> = Vec::new();
    for (_, url) in listed {
        if let Some(remote) = normalize_remote(&url)
            && !out.contains(&remote)
        {
            out.push(remote);
        }
    }
    out
}

/// The `config` file of the nearest repository at or above `folder`.
fn git_config(folder: &Path) -> Option<PathBuf> {
    for dir in folder.ancestors() {
        let dot_git = dir.join(".git");
        if dot_git.is_dir() {
            return Some(dot_git.join("config"));
        }
        if dot_git.is_file() {
            // A worktree or submodule: `.git` names the real git directory,
            // and a worktree's `commondir` names the one holding `config`.
            let text = std::fs::read_to_string(&dot_git).ok()?;
            let gitdir = text
                .lines()
                .find_map(|line| line.trim().strip_prefix("gitdir:"))?
                .trim();
            let gitdir = dir.join(gitdir);
            let common = match std::fs::read_to_string(gitdir.join("commondir")) {
                Ok(common) => gitdir.join(common.trim()),
                Err(_) => gitdir,
            };
            return Some(common.join("config"));
        }
    }
    None
}

/// `(remote name, url)` pairs from git config text, in file order.
fn parse_remotes(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut remote: Option<String> = None;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some(header) = line.strip_prefix('[') {
            let header = header.split(']').next().unwrap_or_default().trim();
            remote = remote_section(header);
            continue;
        }
        let (Some(name), Some((key, value))) = (&remote, line.split_once('=')) else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case("url") {
            out.push((name.clone(), config_value(value)));
        }
    }
    out
}

/// The remote name of a `[remote "name"]` (or older `[remote.name]`) header.
fn remote_section(header: &str) -> Option<String> {
    let (section, rest) = header
        .split_once(|c: char| c.is_whitespace() || c == '.')
        .unwrap_or((header, ""));
    if !section.eq_ignore_ascii_case("remote") {
        return None;
    }
    let name = rest.trim().trim_matches('"');
    (!name.is_empty()).then(|| name.to_owned())
}

/// A git config value: quotes removed, escapes applied, comments dropped.
fn config_value(raw: &str) -> String {
    let mut out = String::new();
    let mut quoted = false;
    let mut chars = raw.trim().chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => quoted = !quoted,
            '\\' => match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some(other) => out.push(other),
                None => {}
            },
            '#' | ';' if !quoted => break,
            c => out.push(c),
        }
    }
    out.trim().to_owned()
}

/// `host/owner/repo` in lowercase for a remote URL, from `https://`,
/// `ssh://`, `git://`, or scp-like `user@host:owner/repo` forms. Credentials,
/// ports, and a trailing `.git` are dropped. Local paths have no host and
/// give `None`.
pub(super) fn normalize_remote(url: &str) -> Option<String> {
    let url = url.trim();
    let (authority, path) = if let Some((scheme, rest)) = url.split_once("://") {
        if scheme.eq_ignore_ascii_case("file") {
            return None;
        }
        rest.split_once('/')?
    } else {
        // scp-like syntax applies only when no slash comes before the colon.
        let (authority, path) = url.split_once(':')?;
        if authority.contains('/') {
            return None;
        }
        (authority, path)
    };
    let host = authority.rsplit('@').next()?;
    let host = match host.strip_prefix('[') {
        Some(bracketed) => bracketed.split(']').next()?,
        None => host.split(':').next()?,
    };
    let path = path.trim_matches('/');
    let path = path
        .strip_suffix(".git")
        .unwrap_or(path)
        .trim_end_matches('/');
    if host.is_empty() || path.is_empty() {
        return None;
    }
    Some(format!("{host}/{path}").to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remotes_normalize_to_host_owner_repo() {
        for (url, expected) in [
            (
                "git@github.com:Jpgomesf/kioku.git",
                "github.com/jpgomesf/kioku",
            ),
            (
                "https://github.com/fundable-ai/api",
                "github.com/fundable-ai/api",
            ),
            ("https://user:tok@github.com/o/r.git/", "github.com/o/r"),
            ("ssh://git@github.com:22/o/r.git", "github.com/o/r"),
            (
                "git+ssh://git@gitlab.example.com/group/sub/r",
                "gitlab.example.com/group/sub/r",
            ),
            ("ssh://git@[::1]:2222/o/r", "::1/o/r"),
            ("git@host:/abs/o/r", "host/abs/o/r"),
        ] {
            assert_eq!(normalize_remote(url).as_deref(), Some(expected), "{url}");
        }
        for local in [
            "/srv/git/r.git",
            "../r",
            "file:///srv/r",
            "./a:b/c",
            "host:",
        ] {
            assert_eq!(normalize_remote(local), None, "{local}");
        }
    }

    #[test]
    fn git_config_lists_remotes_in_order() {
        let text = r#"
[core]
	bare = false
[remote "upstream"]
	url = git@github.com:Upstream/r.git
[Remote "origin"]
	URL = "https://github.com/me/r" ; a comment
	fetch = +refs/heads/*:refs/remotes/origin/*
[remote.old]
	url = git@old.example.com:me/r.git
[branch "main"]
	url = not-a-remote
"#;
        assert_eq!(
            parse_remotes(text),
            [
                (
                    "upstream".to_owned(),
                    "git@github.com:Upstream/r.git".to_owned()
                ),
                ("origin".to_owned(), "https://github.com/me/r".to_owned()),
                ("old".to_owned(), "git@old.example.com:me/r.git".to_owned()),
            ]
        );
        assert_eq!(config_value(r#""a \"b\" #c" # d"#), r#"a "b" #c"#);
    }
}

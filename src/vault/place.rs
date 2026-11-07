//! Placing a session in a vault: by the git remote of the repository it runs
//! in, else by the most specific configured folder that contains it.
//!
//! The remote is read from the nearest enclosing repository's `config` file
//! (worktrees and submodules included). No network and no `git` binary are
//! needed, and a repository that can't be read simply has no remotes. An
//! SSH remote whose host is a `Host` alias in `~/.ssh/config` (such as
//! `git@github-work:org/repo`) is matched both as written and with the
//! alias's `HostName`, as `ssh` would connect.

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
        let ssh = self
            .home
            .as_ref()
            .and_then(|home| std::fs::read_to_string(home.join(".ssh/config")).ok())
            .unwrap_or_default();
        let vault = match self.by_remote(&remotes(folder, &ssh))? {
            Some(vault) => Some(vault),
            None => self.by_folder(&forms)?,
        };
        Ok(vault.map(|vault| Spot {
            vault,
            area: self.area_for(vault, &forms),
        }))
    }

    /// The configured vault and area folders strictly inside `root`, relative
    /// to it with `/`: the parts of a repository that their own rules place.
    pub fn folders_within(&self, root: &Path) -> Vec<String> {
        let roots = spellings(root);
        let folders = self
            .vaults
            .iter()
            .flat_map(|vault| &vault.paths)
            .chain(self.areas.iter().flat_map(|area| &area.paths));
        let mut out: Vec<String> = Vec::new();
        for folder in folders {
            for form in folder.forms() {
                for base in &roots {
                    let Ok(inside) = form.strip_prefix(base) else {
                        continue;
                    };
                    let parts: Option<Vec<&str>> =
                        inside.iter().map(|part| part.to_str()).collect();
                    if let Some(parts) = parts.filter(|parts| !parts.is_empty()) {
                        out.push(parts.join("/"));
                    }
                }
            }
        }
        out.sort();
        out.dedup();
        out
    }

    /// The vault whose `git_remotes` match the first remote that matches any.
    /// A remote matches by any of its spellings; spellings that match two
    /// vaults are an ambiguity, never a choice.
    fn by_remote(&self, remotes: &[Vec<String>]) -> Result<Option<usize>, String> {
        for spellings in remotes {
            let matching: Vec<usize> = (0..self.vaults.len())
                .filter(|i| {
                    self.vaults[*i]
                        .git_remotes
                        .iter()
                        .any(|pattern| spellings.iter().any(|remote| pattern.matches(remote)))
                })
                .collect();
            match matching.as_slice() {
                [] => {}
                [only] => return Ok(Some(*only)),
                several => {
                    let remote = match spellings.as_slice() {
                        [written, resolved] => {
                            format!("{written} (through ~/.ssh/config, {resolved})")
                        }
                        _ => spellings.join(", "),
                    };
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

/// The repository enclosing `folder`, named by its `origin` remote (else its
/// first remote) as written, as `host/path` in lowercase. `None` without one.
pub fn repository_remote(folder: &Path) -> Option<String> {
    remotes(folder, "").into_iter().next()?.into_iter().next()
}

/// Normalized remotes of the repository enclosing `folder`: `origin` first,
/// then the others in file order. Each remote lists its spellings: as
/// written, then with its SSH host alias resolved through `ssh_config`.
pub(super) fn remotes(folder: &Path, ssh_config: &str) -> Vec<Vec<String>> {
    let Some(text) = git_config(folder).and_then(|path| std::fs::read_to_string(path).ok()) else {
        return Vec::new();
    };
    let mut listed = parse_remotes(&text);
    listed.sort_by_key(|(name, _)| name != "origin");
    let mut out: Vec<Vec<String>> = Vec::new();
    for (_, url) in listed {
        let Some(remote) = parse_remote(&url) else {
            continue;
        };
        let mut spellings = vec![remote.spelled(&remote.host)];
        if remote.ssh
            && let Some(real) = ssh_host_name(ssh_config, &remote.host)
        {
            let resolved = remote.spelled(&real);
            if !spellings.contains(&resolved) {
                spellings.push(resolved);
            }
        }
        if !out.contains(&spellings) {
            out.push(spellings);
        }
    }
    out
}

/// The `HostName` that `ssh` would use for `host`, if `config` (the text of
/// `~/.ssh/config`) gives one: the first value from a `Host` block whose
/// patterns match. `Match` blocks can't be evaluated here and are skipped,
/// and `Include` is not followed.
pub(super) fn ssh_host_name(config: &str, host: &str) -> Option<String> {
    let host = host.to_lowercase();
    // Options before the first Host line apply to every host.
    let mut applies = true;
    for line in config.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (keyword, value) = line
            .split_once(|c: char| c.is_whitespace() || c == '=')
            .unwrap_or((line, ""));
        let value = value
            .trim_start_matches(|c: char| c.is_whitespace() || c == '=')
            .trim();
        if keyword.eq_ignore_ascii_case("host") {
            applies = host_matches(value, &host);
        } else if keyword.eq_ignore_ascii_case("match") {
            applies = false;
        } else if applies && keyword.eq_ignore_ascii_case("hostname") {
            let name = value.split_whitespace().next()?.trim_matches('"');
            let name = name.replace("%h", &host).replace("%%", "%");
            return (!name.is_empty()).then_some(name);
        }
    }
    None
}

/// Whether an ssh `Host` pattern list matches `host`: any pattern matches
/// and no negated (`!`) one does.
fn host_matches(patterns: &str, host: &str) -> bool {
    let mut matched = false;
    for pattern in patterns.split_whitespace() {
        let pattern = pattern.trim_matches('"').to_lowercase();
        match pattern.strip_prefix('!') {
            Some(negated) if glob(negated.as_bytes(), host.as_bytes()) => return false,
            Some(_) => {}
            None => matched |= glob(pattern.as_bytes(), host.as_bytes()),
        }
    }
    matched
}

/// ssh's wildcards: `*` for any run of characters, `?` for one.
fn glob(pattern: &[u8], text: &[u8]) -> bool {
    match (pattern.split_first(), text.split_first()) {
        (None, _) => text.is_empty(),
        (Some((b'*', rest)), _) => (0..=text.len()).any(|skip| glob(rest, &text[skip..])),
        (Some((b'?', rest)), Some((_, more))) => glob(rest, more),
        (Some((p, rest)), Some((t, more))) if p == t => glob(rest, more),
        _ => false,
    }
}

/// A remote URL's host and repository path, before lowercasing.
struct RemoteUrl {
    host: String,
    path: String,
    /// Reached over SSH, so `~/.ssh/config` can rename the host.
    ssh: bool,
}

impl RemoteUrl {
    /// `host/path` in lowercase.
    fn spelled(&self, host: &str) -> String {
        format!("{host}/{}", self.path).to_lowercase()
    }
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

/// The host and `owner/repo` path of a remote URL, from `https://`,
/// `ssh://`, `git://`, or scp-like `user@host:owner/repo` forms. Credentials,
/// ports, and a trailing `.git` are dropped. Local paths have no host and
/// give `None`.
fn parse_remote(url: &str) -> Option<RemoteUrl> {
    let url = url.trim();
    let (authority, path, ssh) = if let Some((scheme, rest)) = url.split_once("://") {
        if scheme.eq_ignore_ascii_case("file") {
            return None;
        }
        let ssh = scheme
            .to_ascii_lowercase()
            .split('+')
            .any(|part| part == "ssh");
        let (authority, path) = rest.split_once('/')?;
        (authority, path, ssh)
    } else {
        // scp-like syntax applies only when no slash comes before the colon.
        let (authority, path) = url.split_once(':')?;
        if authority.contains('/') {
            return None;
        }
        (authority, path, true)
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
    Some(RemoteUrl {
        host: host.to_owned(),
        path: path.to_owned(),
        ssh,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn normalize_remote(url: &str) -> Option<String> {
        parse_remote(url).map(|remote| remote.spelled(&remote.host))
    }

    #[test]
    fn remotes_normalize_to_host_owner_repo() {
        for (url, expected) in [
            (
                "git@github.com:Jpgomesf/kioku.git",
                "github.com/jpgomesf/kioku",
            ),
            (
                "https://github.com/acme-corp/api",
                "github.com/acme-corp/api",
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
    fn ssh_host_aliases_resolve_like_ssh_does() {
        let config = r#"
# Personal and work identities on one host.
Host github-work github-acme
    HostName github.com
    IdentityFile ~/.ssh/work
Host=gh-*
  HostName=%h.example.com
Host *.internal !secret.internal
    HostName jump.example.com
Match host other
    HostName never.example.com
Host github-work
    HostName second.example.com
"#;
        assert_eq!(
            ssh_host_name(config, "github-work").as_deref(),
            Some("github.com")
        );
        assert_eq!(
            ssh_host_name(config, "GitHub-Acme").as_deref(),
            Some("github.com")
        );
        assert_eq!(
            ssh_host_name(config, "gh-a").as_deref(),
            Some("gh-a.example.com")
        );
        assert_eq!(
            ssh_host_name(config, "db.internal").as_deref(),
            Some("jump.example.com")
        );
        assert_eq!(ssh_host_name(config, "secret.internal"), None);
        assert_eq!(ssh_host_name(config, "other"), None);
        assert_eq!(ssh_host_name(config, "github.com"), None);
        assert_eq!(
            ssh_host_name("HostName everywhere.example.com\n", "x").as_deref(),
            Some("everywhere.example.com")
        );
        assert_eq!(ssh_host_name("", "github-work"), None);
    }

    #[test]
    fn a_remote_through_an_ssh_alias_has_both_spellings() {
        let dir = std::env::temp_dir().join(format!("kioku-remote-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(
            dir.join(".git/config"),
            "[remote \"origin\"]\n\turl = git@github-work:Acme-Corp/api.git\n[remote \"web\"]\n\turl = https://github-work/o/r\n",
        )
        .unwrap();
        let ssh = "Host github-work\n  HostName github.com\n";
        let found = remotes(&dir, ssh);
        let plain = remotes(&dir, "");
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(
            found,
            [
                vec![
                    "github-work/acme-corp/api".to_owned(),
                    "github.com/acme-corp/api".to_owned()
                ],
                vec!["github-work/o/r".to_owned()],
            ],
            "only SSH remotes go through ~/.ssh/config"
        );
        assert_eq!(plain[0], ["github-work/acme-corp/api"]);
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

//! A repository read through the `git` binary: its root, its commits, the
//! files a commit tracks and their contents. Every call blocks; async callers
//! run them on a blocking thread.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, Result, anyhow, bail};

use super::lang::MAX_FILE_BYTES;
use crate::error::UserError;

pub struct Repository {
    root: PathBuf,
}

/// A file a commit range touched. A rename is a deletion and an addition.
#[derive(Debug, PartialEq, Eq)]
pub enum Change {
    Changed(String),
    Deleted(String),
}

impl Repository {
    /// The repository enclosing `path`, a file or a folder.
    pub fn discover(path: &Path) -> Result<Self> {
        let dir = if path.is_dir() {
            path
        } else {
            path.parent().unwrap_or(path)
        };
        let out = run(dir, &["rev-parse", "--show-toplevel"]).map_err(|_| {
            UserError::InvalidArgument(format!(
                "{} is not inside a git repository, and the code map covers only files git tracks",
                path.display()
            ))
        })?;
        let root = String::from_utf8(out).context("the repository path is not UTF-8")?;
        Ok(Self {
            root: PathBuf::from(root.trim_end_matches('\n')),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The repository's name in the code map: its remote as `host/path`
    /// (`origin` first), else its folder's name.
    pub fn name(&self) -> String {
        crate::vault::repository_remote(&self.root).unwrap_or_else(|| {
            self.root
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| self.root.display().to_string())
        })
    }

    /// `file` relative to the root, with `/`, if the repository contains it.
    pub fn relative(&self, file: &Path) -> Option<String> {
        let file = file.canonicalize().ok()?;
        let root = self.root.canonicalize().ok()?;
        let relative = file.strip_prefix(root).ok()?;
        let parts: Option<Vec<&str>> = relative.iter().map(|part| part.to_str()).collect();
        Some(parts?.join("/"))
    }

    /// The commit HEAD points at, or `None` in a repository with no commits.
    pub fn head(&self) -> Result<Option<String>> {
        match run(
            &self.root,
            &["rev-parse", "-q", "--verify", "HEAD^{commit}"],
        ) {
            Ok(out) => Ok(Some(String::from_utf8(out)?.trim().to_owned())),
            Err(_) => Ok(None),
        }
    }

    /// Whether the repository still has `commit` (a rebase or a gc may drop it).
    pub fn has_commit(&self, commit: &str) -> bool {
        run(
            &self.root,
            &["cat-file", "-e", &format!("{commit}^{{commit}}")],
        )
        .is_ok()
    }

    /// Every file `commit` tracks.
    pub fn files_at(&self, commit: &str) -> Result<Vec<String>> {
        Ok(split_nul(&run(
            &self.root,
            &["ls-tree", "-r", "-z", "--name-only", commit],
        )?))
    }

    /// Every file the index tracks, for reading the working tree.
    pub fn tracked(&self) -> Result<Vec<String>> {
        Ok(split_nul(&run(&self.root, &["ls-files", "-z"])?))
    }

    /// The files that changed from `from` to `to`.
    pub fn changes(&self, from: &str, to: &str) -> Result<Vec<Change>> {
        let out = run(
            &self.root,
            &["diff", "--name-status", "-z", "--no-renames", from, to],
        )?;
        Ok(parse_name_status(&out))
    }

    /// The contents of `paths` at `commit`, in order: `None` for a path that
    /// is missing, not a file, or larger than [`MAX_FILE_BYTES`]. One `git`
    /// process serves them all.
    pub fn contents(&self, commit: &str, paths: &[String]) -> Result<Vec<Option<Vec<u8>>>> {
        let asked: Vec<usize> = (0..paths.len())
            .filter(|&index| !paths[index].contains('\n'))
            .collect();
        let mut out = vec![None; paths.len()];
        if asked.is_empty() {
            return Ok(out);
        }
        let mut child = Command::new("git")
            .arg("-C")
            .arg(&self.root)
            .args(["cat-file", "--batch"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .context("cannot run git")?;
        let mut stdin = child.stdin.take().context("git has no stdin")?;
        let requests: Vec<u8> = asked
            .iter()
            .flat_map(|&index| format!("{commit}:{}\n", paths[index]).into_bytes())
            .collect();
        // Write from another thread, so a full pipe can't deadlock the reader.
        let writer = std::thread::spawn(move || stdin.write_all(&requests));
        let mut reader = BufReader::new(child.stdout.take().context("git has no stdout")?);
        for &index in &asked {
            let mut header = String::new();
            reader.read_line(&mut header)?;
            let header = header.trim_end();
            if header.is_empty() || header.ends_with(" missing") || header.ends_with(" ambiguous") {
                continue;
            }
            let mut fields = header.splitn(3, ' ');
            let (_, kind, size) = (fields.next(), fields.next(), fields.next());
            let size: u64 = size
                .and_then(|size| size.parse().ok())
                .with_context(|| format!("unexpected git output {header:?}"))?;
            if kind == Some("blob") && size <= MAX_FILE_BYTES as u64 {
                let mut data = vec![0; usize::try_from(size)?];
                reader.read_exact(&mut data)?;
                out[index] = Some(data);
            } else {
                std::io::copy(&mut (&mut reader).take(size), &mut std::io::sink())?;
            }
            let mut newline = [0u8; 1];
            reader.read_exact(&mut newline)?;
        }
        writer
            .join()
            .map_err(|_| anyhow!("the git writer thread panicked"))??;
        child.wait()?;
        Ok(out)
    }
}

fn run(dir: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .context("cannot run git")?;
    if !output.status.success() {
        bail!(
            "git {} failed in {}: {}",
            args.join(" "),
            dir.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(output.stdout)
}

/// NUL-separated paths; a path that isn't UTF-8 is left out.
fn split_nul(out: &[u8]) -> Vec<String> {
    out.split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
        .filter_map(|part| String::from_utf8(part.to_vec()).ok())
        .collect()
}

/// `git diff --name-status -z` output: a status, then its path.
pub(super) fn parse_name_status(out: &[u8]) -> Vec<Change> {
    let fields = split_nul(out);
    fields
        .chunks(2)
        .filter_map(|pair| match pair {
            [status, path] if status.starts_with('D') => Some(Change::Deleted(path.clone())),
            [_, path] => Some(Change::Changed(path.clone())),
            _ => None,
        })
        .collect()
}

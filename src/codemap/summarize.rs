//! Summarizers: a program that writes a one-line purpose for each file that
//! has no doc comment. Kioku writes a JSON request to its stdin and reads the
//! purposes from its stdout:
//!
//! ```text
//! stdin:  {"repo": "github.com/acme/app", "files": [{"path": "src/a.py", "language": "python", "text": "..."}]}
//! stdout: {"purposes": [{"path": "src/a.py", "purpose": "Parses the bank's CSV export into invoices."}]}
//! ```
//!
//! A summarizer declares whose model it calls, and Kioku sends it code only
//! from vaults that let that provider read. A purpose for a file it wasn't
//! asked about, one that isn't a single line, or one carrying a credential is
//! dropped.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};

use super::lang::{Language, MAX_PURPOSE_CHARS, cut};
use crate::vault::Provider;

/// Files per summarizer run.
const BATCH_FILES: usize = 20;
/// Text per run, and per file: the head of a file says what it is for.
const BATCH_CHARS: usize = 120_000;
const FILE_CHARS: usize = 12_000;
const TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone, Debug)]
pub struct Summarizer {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Whose model the program calls.
    pub provider: Provider,
}

/// A file to summarize.
pub struct Source {
    pub path: String,
    pub language: Language,
    pub text: String,
}

#[derive(Serialize)]
struct Request<'a> {
    repo: &'a str,
    files: Vec<RequestFile<'a>>,
}

#[derive(Serialize)]
struct RequestFile<'a> {
    path: &'a str,
    language: &'a str,
    text: &'a str,
}

#[derive(Deserialize)]
struct Response {
    purposes: Vec<Purpose>,
}

#[derive(Deserialize)]
struct Purpose {
    path: String,
    purpose: String,
}

impl Summarizer {
    /// Purposes for `files` by path, one batch at a time. A failed batch is
    /// reported and its files get none.
    pub fn summarize(
        &self,
        repo: &str,
        files: &[Source],
    ) -> (BTreeMap<String, String>, Vec<String>) {
        let mut purposes = BTreeMap::new();
        let mut errors = Vec::new();
        for batch in batches(files) {
            match self.run(repo, batch) {
                Ok(found) => purposes.extend(found),
                Err(error) => errors.push(format!("{error:#}")),
            }
        }
        (purposes, errors)
    }

    fn run(&self, repo: &str, batch: &[Source]) -> Result<BTreeMap<String, String>> {
        let request = Request {
            repo,
            files: batch
                .iter()
                .map(|file| RequestFile {
                    path: &file.path,
                    language: file.language.as_str(),
                    text: head(&file.text, FILE_CHARS),
                })
                .collect(),
        };
        let output = run_with_timeout(self, &serde_json::to_vec(&request)?, TIMEOUT)?;
        let asked: BTreeSet<&str> = batch.iter().map(|file| file.path.as_str()).collect();
        parse_response(&output, &asked)
    }
}

/// Consecutive groups of at most [`BATCH_FILES`] files and about
/// [`BATCH_CHARS`] characters of text.
fn batches(files: &[Source]) -> Vec<&[Source]> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut chars = 0;
    for (index, file) in files.iter().enumerate() {
        let size = head(&file.text, FILE_CHARS).len();
        if index > start && (index - start >= BATCH_FILES || chars + size > BATCH_CHARS) {
            out.push(&files[start..index]);
            start = index;
            chars = 0;
        }
        chars += size;
    }
    if start < files.len() {
        out.push(&files[start..]);
    }
    out
}

/// At most `limit` bytes of `text`, cut at a character boundary.
fn head(text: &str, limit: usize) -> &str {
    if text.len() <= limit {
        return text;
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// The purposes a summarizer printed, keeping only usable ones.
pub(super) fn parse_response(
    output: &[u8],
    asked: &BTreeSet<&str>,
) -> Result<BTreeMap<String, String>> {
    let response: Response =
        serde_json::from_slice(output).context("the summarizer printed no valid JSON")?;
    let mut out = BTreeMap::new();
    for Purpose { path, purpose } in response.purposes {
        let purpose = purpose.split_whitespace().collect::<Vec<_>>().join(" ");
        if !asked.contains(path.as_str())
            || purpose.is_empty()
            || crate::secrets::find_in_text(&purpose).is_some()
        {
            continue;
        }
        out.insert(path, cut(&purpose, MAX_PURPOSE_CHARS));
    }
    Ok(out)
}

fn run_with_timeout(summarizer: &Summarizer, input: &[u8], timeout: Duration) -> Result<Vec<u8>> {
    let mut child = Command::new(&summarizer.program)
        .args(&summarizer.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("cannot run the summarizer {}", summarizer.program.display()))?;
    let mut stdin = child.stdin.take().context("the summarizer has no stdin")?;
    let mut stdout = child
        .stdout
        .take()
        .context("the summarizer has no stdout")?;
    let mut stderr = child
        .stderr
        .take()
        .context("the summarizer has no stderr")?;
    let input = input.to_vec();
    // Separate threads, so no full pipe can block the others.
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        stdout.read_to_end(&mut out).map(|_| out)
    });
    let complaints = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        text
    });
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            bail!(
                "the summarizer took longer than {} seconds",
                timeout.as_secs()
            );
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let _ = writer.join();
    let output = reader
        .join()
        .map_err(|_| anyhow!("the summarizer's reader thread panicked"))??;
    let complaints = complaints.join().unwrap_or_default();
    if !status.success() {
        bail!(
            "the summarizer failed ({status}): {}",
            cut(complaints.trim(), 300)
        );
    }
    Ok(output)
}

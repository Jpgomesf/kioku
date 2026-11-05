//! Opt-in JSONL log of MCP tool calls, recorded by the server itself so agent
//! behavior can be checked the same way for every client and model.
//!
//! Each line holds the tool, its arguments, the outcome, the ids it returned,
//! and timing. Arguments include queries and note text, so the file is created
//! with owner-only permissions and should stay private. `MEMORY_TRACE_CONTENT`
//! can drop or pseudonymize that text while keeping keys, domains, and timing.
//! A path containing `{vault}` gives each vault its own file ([`TraceFiles`]).

use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, anyhow, bail, ensure};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// Upper bound on ids recorded per call.
const MAX_IDS: usize = 50;

#[derive(Clone)]
pub struct Tracer {
    path: PathBuf,
    session: Uuid,
    file: Arc<Mutex<File>>,
}

/// Replaced in `MEMORY_TRACE_FILE` by the session's vault name.
pub const VAULT_PLACEHOLDER: &str = "{vault}";

/// The trace files of one server: a single file, or one per vault when the
/// path contains `{vault}`, so vaults never share a trace.
#[derive(Clone)]
pub struct TraceFiles {
    template: PathBuf,
    open: Arc<Mutex<HashMap<PathBuf, Tracer>>>,
}

impl TraceFiles {
    /// Without `{vault}` the file is opened now, so a bad path fails at startup.
    pub fn open(template: &Path) -> Result<Self> {
        let files = Self {
            template: template.to_path_buf(),
            open: Arc::default(),
        };
        if files.per_vault() {
            ensure!(
                template.to_str().is_some(),
                "MEMORY_TRACE_FILE must be valid UTF-8 to contain {VAULT_PLACEHOLDER}"
            );
        } else {
            files.tracer("")?;
        }
        Ok(files)
    }

    pub fn per_vault(&self) -> bool {
        self.template.to_string_lossy().contains(VAULT_PLACEHOLDER)
    }

    /// The file for a session labelled `label` (a vault name, or a reserved
    /// label from [`crate::vault`]).
    pub fn path_for(&self, label: &str) -> PathBuf {
        match self.template.to_str() {
            Some(template) if template.contains(VAULT_PLACEHOLDER) => {
                PathBuf::from(template.replace(VAULT_PLACEHOLDER, label))
            }
            _ => self.template.clone(),
        }
    }

    /// The tracer for `label`, opening its file on first use.
    pub fn tracer(&self, label: &str) -> Result<Tracer> {
        let path = self.path_for(label);
        let mut open = self
            .open
            .lock()
            .map_err(|_| anyhow!("trace file registry lock poisoned"))?;
        if let Some(tracer) = open.get(&path) {
            return Ok(tracer.clone());
        }
        let tracer = Tracer::open(&path)?;
        open.insert(path, tracer.clone());
        Ok(tracer)
    }
}

#[derive(Debug, Serialize)]
pub struct ClientInfo {
    pub name: String,
    pub version: String,
}

/// How much free text (queries, titles, bodies) a trace keeps.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TraceContent {
    /// Everything, as the client sent it. Behavior checks need this.
    #[default]
    Full,
    /// Free text replaced by its length, such as `[redacted: 312 chars]`.
    Redacted,
    /// Free text replaced by a salted SHA-256 prefix, so identical queries can
    /// still be matched across records without storing them.
    Hashed,
}

impl TraceContent {
    pub fn parse(text: &str) -> Result<Self> {
        match text.trim().to_ascii_lowercase().as_str() {
            "full" => Ok(Self::Full),
            "redacted" => Ok(Self::Redacted),
            "hashed" => Ok(Self::Hashed),
            other => bail!("MEMORY_TRACE_CONTENT must be full, redacted, or hashed, got {other:?}"),
        }
    }
}

/// Argument fields holding free text. Keys, domains, and numbers stay as sent.
const FREE_TEXT: [&str; 8] = [
    "query", "body", "title", "topic", "text", "source", "aliases", "tags",
];

/// Apply `mode` to the free-text fields of a tool call's arguments.
pub fn scrub(arguments: Value, mode: TraceContent, salt: &str) -> Value {
    fn text(value: Value, mode: TraceContent, salt: &str) -> Value {
        match value {
            Value::String(s) => Value::String(match mode {
                TraceContent::Full => s,
                TraceContent::Redacted => format!("[redacted: {} chars]", s.chars().count()),
                TraceContent::Hashed => {
                    let digest = Sha256::new()
                        .chain_update(salt.as_bytes())
                        .chain_update([0u8])
                        .chain_update(s.as_bytes())
                        .finalize();
                    let hex: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
                    format!("sha256:{hex}")
                }
            }),
            Value::Array(items) => {
                Value::Array(items.into_iter().map(|v| text(v, mode, salt)).collect())
            }
            other => other,
        }
    }
    fn walk(value: Value, mode: TraceContent, salt: &str) -> Value {
        match value {
            Value::Object(map) => Value::Object(
                map.into_iter()
                    .map(|(name, item)| {
                        let item = if FREE_TEXT.contains(&name.as_str()) {
                            text(item, mode, salt)
                        } else {
                            walk(item, mode, salt)
                        };
                        (name, item)
                    })
                    .collect(),
            ),
            Value::Array(items) => {
                Value::Array(items.into_iter().map(|v| walk(v, mode, salt)).collect())
            }
            other => other,
        }
    }
    if mode == TraceContent::Full {
        return arguments;
    }
    walk(arguments, mode, salt)
}

#[derive(Debug, Serialize)]
pub struct ToolCall<'a> {
    pub ts: DateTime<Utc>,
    pub session: Uuid,
    /// Who made the call: `local` over stdio, or an access-file subject.
    pub principal: &'a str,
    /// The caller's vault. Absent without a vaults file and for sessions
    /// that were refused.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vault: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<ClientInfo>,
    /// The name the client used, when it was an older alias of `tool`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub called: Option<String>,
    pub tool: &'a str,
    pub arguments: Value,
    pub is_error: bool,
    pub duration_ms: f64,
    pub result_bytes: usize,
    pub result_ids: Vec<String>,
    /// Memory keys in the result, so checks can follow what a model chose to read.
    pub result_keys: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Tracer {
    /// Open `path` for appending. Each server process gets its own session id.
    pub fn open(path: &Path) -> Result<Self> {
        let mut options = std::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(path)
            .with_context(|| format!("cannot open trace file {}", path.display()))?;
        Ok(Self {
            path: path.to_path_buf(),
            session: Uuid::new_v4(),
            file: Arc::new(Mutex::new(file)),
        })
    }

    pub fn session(&self) -> Uuid {
        self.session
    }

    /// Append one record. Failures are logged and never fail the tool call.
    pub async fn record(&self, call: &ToolCall<'_>) {
        let mut line = match serde_json::to_vec(call) {
            Ok(line) => line,
            Err(error) => {
                tracing::warn!(%error, "cannot serialize trace record");
                return;
            }
        };
        line.push(b'\n');
        let file = self.file.clone();
        // One write per line on an append-mode file, finished even if the
        // awaiting tool call is cancelled.
        let written = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
            let mut file = file
                .lock()
                .map_err(|_| std::io::Error::other("trace file lock poisoned"))?;
            file.write_all(&line)?;
            file.flush()
        })
        .await;
        match written {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                tracing::warn!(%error, path = %self.path.display(), "cannot write trace record")
            }
            Err(error) => tracing::warn!(%error, "trace writer task failed"),
        }
    }
}

/// Memory keys (`results[].key`, `memories[].key`, and so on) in a tool
/// result, in order, without duplicates.
pub fn result_keys(value: &Value) -> Vec<String> {
    fn walk(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::Object(map) => {
                if let Some(Value::String(key)) = map.get("key")
                    && !out.contains(key)
                    && out.len() < MAX_IDS
                {
                    out.push(key.clone());
                }
                for (name, item) in map {
                    if name != "missing" {
                        walk(item, out);
                    }
                }
            }
            Value::Array(items) => items.iter().for_each(|item| walk(item, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(value, &mut out);
    out
}

/// Memory ids mentioned anywhere in a tool result, in order, without duplicates.
pub fn result_ids(value: &Value) -> Vec<String> {
    fn walk(value: &Value, out: &mut Vec<String>) {
        if out.len() >= MAX_IDS {
            return;
        }
        match value {
            Value::Object(map) => {
                for (key, item) in map {
                    if key == "id" {
                        if let Some(id) = item.as_str().filter(|s| Uuid::parse_str(s).is_ok())
                            && !out.iter().any(|seen| seen == id)
                        {
                            out.push(id.to_owned());
                        }
                    } else {
                        walk(item, out);
                    }
                }
            }
            Value::Array(items) => items.iter().for_each(|item| walk(item, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(value, &mut out);
    out.truncate(MAX_IDS);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn collects_nested_ids_once_in_order() {
        let a = Uuid::new_v4().to_string();
        let b = Uuid::new_v4().to_string();
        let value = json!({
            "results": [{"id": a, "linked": {"id": b}}, {"id": a}],
            "memory_ids": ["not-collected"],
            "id": "not-a-uuid",
        });
        assert_eq!(result_ids(&value), vec![a, b]);
    }

    #[test]
    fn collects_result_keys_but_not_missing_ones() {
        let value = json!({
            "results": [{"key": "a"}, {"key": "b", "links": [{"key": "c"}]}],
            "missing": [{"key": "typo"}],
        });
        assert_eq!(result_keys(&value), vec!["a", "b", "c"]);
    }

    #[tokio::test]
    async fn appends_one_json_line_per_call() {
        let dir = std::env::temp_dir().join(format!("kioku-trace-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("trace.jsonl");
        let tracer = Tracer::open(&path).unwrap();
        for tool in ["rag_search", "rag_context"] {
            tracer
                .record(&ToolCall {
                    ts: Utc::now(),
                    session: tracer.session(),
                    principal: "local",
                    vault: None,
                    run: None,
                    client: None,
                    called: None,
                    tool,
                    arguments: json!({"query": "q"}),
                    is_error: false,
                    duration_ms: 1.0,
                    result_bytes: 2,
                    result_ids: Vec::new(),
                    result_keys: Vec::new(),
                    error: None,
                })
                .await;
        }
        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<Value> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1]["tool"], "rag_context");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn vault_placeholders_give_each_vault_its_own_file() {
        let dir = std::env::temp_dir().join(format!("kioku-trace-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let files = TraceFiles::open(&dir.join("trace-{vault}.jsonl")).unwrap();
        assert!(files.per_vault());
        assert!(
            !dir.join("trace-{vault}.jsonl").exists(),
            "opened lazily, per vault"
        );
        let personal = files.tracer("personal").unwrap();
        assert_eq!(
            personal.session(),
            files.tracer("personal").unwrap().session()
        );
        assert_ne!(personal.session(), files.tracer("work").unwrap().session());
        assert!(dir.join("trace-personal.jsonl").exists() && dir.join("trace-work.jsonl").exists());
        let single = TraceFiles::open(&dir.join("trace.jsonl")).unwrap();
        assert!(!single.per_vault() && dir.join("trace.jsonl").exists());
        assert_eq!(single.path_for("work"), dir.join("trace.jsonl"));
        assert!(TraceFiles::open(&dir.join("missing/trace.jsonl")).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn scrubbing_keeps_keys_and_drops_free_text() {
        let args = serde_json::json!({
            "query": "webhook retry policy", "domain": "relay", "keys": ["webhook-retries"],
            "note": {"key": "k", "body": "secret-ish detail", "aliases": ["a", "b"]}, "limit": 3
        });
        let full = scrub(args.clone(), TraceContent::Full, "s");
        assert_eq!(full, args);
        let redacted = scrub(args.clone(), TraceContent::Redacted, "s");
        assert_eq!(redacted["query"], "[redacted: 20 chars]");
        assert_eq!(redacted["domain"], "relay");
        assert_eq!(redacted["keys"][0], "webhook-retries");
        assert_eq!(redacted["note"]["key"], "k");
        assert_eq!(redacted["note"]["body"], "[redacted: 17 chars]");
        assert_eq!(redacted["note"]["aliases"][1], "[redacted: 1 chars]");
        assert_eq!(redacted["limit"], 3);
        let hashed = scrub(args.clone(), TraceContent::Hashed, "s");
        let again = scrub(args.clone(), TraceContent::Hashed, "s");
        let other_salt = scrub(args, TraceContent::Hashed, "t");
        assert_eq!(hashed["query"], again["query"]);
        assert_ne!(hashed["query"], other_salt["query"]);
        assert!(hashed["query"].as_str().unwrap().starts_with("sha256:"));
        assert!(TraceContent::parse("nope").is_err());
    }
}

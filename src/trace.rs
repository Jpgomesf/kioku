//! Opt-in JSONL log of MCP tool calls, recorded by the server itself so agent
//! behavior can be checked the same way for every client and model.
//!
//! Each line holds the tool, its arguments, the outcome, the ids it returned,
//! and timing. Arguments include queries and note text, so the file is created
//! with owner-only permissions and should stay private.

use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

/// Upper bound on ids recorded per call.
const MAX_IDS: usize = 50;

#[derive(Clone)]
pub struct Tracer {
    path: PathBuf,
    session: Uuid,
    file: Arc<Mutex<File>>,
}

#[derive(Debug, Serialize)]
pub struct ClientInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Serialize)]
pub struct ToolCall<'a> {
    pub ts: DateTime<Utc>,
    pub session: Uuid,
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
}

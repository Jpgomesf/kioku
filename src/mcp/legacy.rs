//! Compatibility with tool names and calls from earlier releases.

use rmcp::model::{CallToolRequestParams, CallToolResult, JsonObject};
use serde_json::{Value, json};

use crate::app::ContextRequest;
use crate::rank::RankOptions;

use super::MemoryServer;
use super::output::{error_text, ok, render_error};

impl MemoryServer {
    /// Older clients' `rag_context` with a query: search, then read, in one call.
    pub(super) async fn legacy_context(&self, args: JsonObject) -> CallToolResult {
        let query = args
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let domain = self.domain(
            args.get("domain")
                .or_else(|| args.get("domain_filter"))
                .and_then(Value::as_str),
        );
        let budget = args
            .get("token_budget")
            .or_else(|| args.get("max_bytes"))
            .and_then(Value::as_i64)
            .unwrap_or(2000)
            .clamp(256, 8000);
        let include_legacy = args
            .get("include_legacy")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let result = self
            .app
            .context(&ContextRequest {
                query: Some(query),
                ids: None,
                domain: Some(&domain),
                budget: usize::try_from(budget).unwrap_or(2000),
                include_legacy,
                ranking: RankOptions::HYBRID_GRAPH,
                record_access: true,
            })
            .await;
        match result.and_then(|pack| Ok(serde_json::to_value(pack)?)) {
            Ok(value) => ok(value),
            Err(error) => error_text(render_error("memory_get", &error)),
        }
    }
}

/// Map an older tool call onto the current tools. Returns the name the client used.
pub(super) fn upgrade_legacy(request: &mut CallToolRequestParams) -> Result<String, String> {
    let called = request.name.to_string();
    let args = request.arguments.get_or_insert_with(JsonObject::new);
    let renamed = match called.as_str() {
        "rag_search" | "task_route" => "memory_search",
        "rag_context" if args.contains_key("query") && !args.contains_key("ids") => {
            "rag_context_query"
        }
        "rag_context" => {
            args.remove("include_legacy");
            "memory_get"
        }
        "graph_context" | "provenance_lookup" => {
            args.remove("include_legacy");
            "memory_inspect"
        }
        "memory_retire" | "memory_restore" => {
            args.remove("include_legacy");
            return Ok(called);
        }
        "memory_hydrate" => "memory_import",
        "memory_upsert" => {
            if let Some(Value::Object(note)) = args.remove("note") {
                for (field, value) in note {
                    match field.as_str() {
                        "pinned" if value == json!(true) => {
                            return Err("invalid_argument: memory_save does not pin memories; the user pins them with `kioku pin`. Retry without pinned".into());
                        }
                        "pinned" | "confidence" => {}
                        _ => {
                            args.entry(field).or_insert(value);
                        }
                    }
                }
            }
            "memory_save"
        }
        _ => return Ok(called),
    };
    request.name = renamed.to_owned().into();
    Ok(called)
}

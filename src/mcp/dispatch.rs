//! Routing a tool call, and recording it when tracing is on.

use std::time::Instant;

use chrono::Utc;
use rmcp::handler::server::tool::ToolCallContext;
use rmcp::model::{CallToolRequestParams, CallToolResponse};
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer};
use serde_json::Value;

use crate::trace::{self, ClientInfo, ToolCall};

use super::MemoryServer;

impl MemoryServer {
    pub(super) async fn traced(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
        called: String,
    ) -> Result<CallToolResponse, ErrorData> {
        let Some(tracer) = &self.tracer else {
            return self.dispatch(request, context).await;
        };
        let started = Instant::now();
        let tool = request.name.to_string();
        let arguments = request.arguments.clone().map_or(Value::Null, Value::Object);
        let client = context.peer.peer_info().map(|info| ClientInfo {
            name: info.client_info.name.clone(),
            version: info.client_info.version.clone(),
        });
        let response = self.dispatch(request, context).await;
        let summary = summarize(&response);
        tracer
            .record(&ToolCall {
                ts: Utc::now(),
                session: tracer.session(),
                run: self.app.config.trace_run.clone(),
                client,
                called: (called != tool).then_some(called),
                tool: &tool,
                arguments,
                is_error: summary.is_error,
                duration_ms: started.elapsed().as_secs_f64() * 1000.0,
                result_bytes: summary.bytes,
                result_ids: summary.ids,
                result_keys: summary.keys,
                error: summary.error,
            })
            .await;
        response
    }

    async fn dispatch(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        if request.name == "rag_context_query" {
            let args = request.arguments.unwrap_or_default();
            return Ok(self.legacy_context(args).await.into());
        }
        self.tool_router
            .call(ToolCallContext::new(self, request, context))
            .await
    }
}

/// Outcome summary for the trace: error flag, result size, returned ids, error text.
struct Summary {
    is_error: bool,
    bytes: usize,
    ids: Vec<String>,
    keys: Vec<String>,
    error: Option<String>,
}

fn summarize(response: &Result<CallToolResponse, ErrorData>) -> Summary {
    let empty = |is_error: bool, error: Option<String>| Summary {
        is_error,
        bytes: 0,
        ids: Vec::new(),
        keys: Vec::new(),
        error,
    };
    match response {
        Ok(CallToolResponse::Complete(result)) => {
            let text: String = result
                .content
                .iter()
                .filter_map(|block| block.as_text().map(|t| t.text.as_str()))
                .collect::<Vec<_>>()
                .join("\n");
            let is_error = result.is_error.unwrap_or(false);
            let value: Option<Value> = result
                .structured_content
                .clone()
                .or_else(|| serde_json::from_str(&text).ok());
            Summary {
                is_error,
                bytes: text.len(),
                ids: value.as_ref().map(trace::result_ids).unwrap_or_default(),
                keys: value.as_ref().map(trace::result_keys).unwrap_or_default(),
                error: is_error.then(|| text.chars().take(500).collect()),
            }
        }
        Ok(_) => empty(false, None),
        Err(error) => empty(true, Some(error.message.to_string())),
    }
}

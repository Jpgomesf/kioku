//! Routing a tool call, and recording it when tracing is on.
//!
//! Every call runs with a [`Caller`]: the principal, its vault session, and
//! the viewer the application filters notes by. A session refused by the
//! vault rules gets a refused error from every tool before any tool code runs.

use std::sync::Arc;
use std::time::Instant;

use chrono::Utc;
use rmcp::handler::server::tool::ToolCallContext;
use rmcp::model::{CallToolRequestParams, CallToolResponse};
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer};
use serde_json::Value;
use tracing::Instrument;

use crate::access::{Principal, required_scope};
use crate::error::UserError;
use crate::trace::{self, ClientInfo, ToolCall};
use crate::vault::{Placement, Session, Viewer};

use super::MemoryServer;
use super::output::{error_text, render_error};

/// Who is calling, and what they may see.
pub(super) struct Caller {
    pub(super) principal: Arc<Principal>,
    pub(super) session: Session,
    /// What the application filters by. A refused session's viewer sees
    /// nothing, so a missed check still fails closed.
    pub(super) viewer: Viewer,
}

impl Caller {
    pub(super) fn new(principal: Arc<Principal>, session: Session) -> Self {
        let viewer = Viewer::new(&principal, &session);
        Self {
            principal,
            session,
            viewer,
        }
    }

    /// The domain a call uses when it names none, when a vault decides it.
    pub(super) fn default_domain(&self) -> Option<&str> {
        self.session.placement().map(Placement::default_domain)
    }
}

tokio::task_local! {
    /// The caller of the tool call being served. Set around every call, so
    /// domain checks deep in tool code see who is calling without threading it
    /// through every helper.
    static CALLER: Arc<Caller>;
}

impl MemoryServer {
    /// The principal the HTTP layer authenticated for this request, if any.
    #[cfg(feature = "http")]
    fn http_principal(context: &RequestContext<RoleServer>) -> Option<&Arc<Principal>> {
        context
            .extensions
            .get::<axum::http::request::Parts>()
            .and_then(|parts| parts.extensions.get::<Arc<Principal>>())
    }

    /// The principal for this request: the one the HTTP layer authenticated,
    /// or this process's own for stdio. An HTTP request without one gets the
    /// server's principal, which over HTTP has no scopes, so it fails closed.
    pub(super) fn principal_for(&self, context: &RequestContext<RoleServer>) -> Arc<Principal> {
        #[cfg(feature = "http")]
        if let Some(principal) = Self::http_principal(context) {
            return principal.clone();
        }
        let _ = context;
        self.caller.principal.clone()
    }

    /// The caller for this request. Over HTTP, the session comes from the
    /// principal's access-file entry; over stdio, from this process.
    fn caller_for(&self, context: &RequestContext<RoleServer>) -> Arc<Caller> {
        #[cfg(feature = "http")]
        if let Some(principal) = Self::http_principal(context) {
            let session = Session::for_principal(self.app.config.vaults.as_ref(), principal);
            return Arc::new(Caller::new(principal.clone(), session));
        }
        let _ = context;
        self.caller.clone()
    }

    /// Who is calling inside a tool. Outside a call, this process's caller.
    pub(super) fn caller(&self) -> Arc<Caller> {
        CALLER
            .try_with(Arc::clone)
            .unwrap_or_else(|_| self.caller.clone())
    }

    pub(super) async fn traced(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
        called: String,
    ) -> Result<CallToolResponse, ErrorData> {
        let caller = self.caller_for(&context);
        let tool = request.name.to_string();
        let span = tracing::info_span!(
            "tool",
            tool = %tool,
            principal = %caller.principal.subject,
            is_error = tracing::field::Empty,
            ms = tracing::field::Empty,
        );
        let started = Instant::now();
        let arguments = self
            .tracer
            .as_ref()
            .map(|_| request.arguments.clone().map_or(Value::Null, Value::Object));
        let client = context.peer.peer_info().map(|info| ClientInfo {
            name: info.client_info.name.clone(),
            version: info.client_info.version.clone(),
        });
        let response = CALLER
            .scope(caller.clone(), self.dispatch(request, context, &caller))
            .instrument(span.clone())
            .await;
        let duration_ms = started.elapsed().as_secs_f64() * 1000.0;
        let is_error = match &response {
            Ok(CallToolResponse::Complete(result)) => result.is_error.unwrap_or(false),
            Ok(_) => false,
            Err(_) => true,
        };
        span.record("is_error", is_error);
        span.record("ms", duration_ms);
        let (Some(tracer), Some(arguments)) = (&self.tracer, arguments) else {
            return response;
        };
        let summary = summarize(&response);
        let config = &self.app.config;
        tracer
            .record(&ToolCall {
                ts: Utc::now(),
                session: tracer.session(),
                principal: &caller.principal.subject,
                vault: caller.session.vault_name(),
                run: config.trace_run.clone(),
                client,
                called: (called != tool).then_some(called),
                tool: &tool,
                arguments: trace::scrub(arguments, config.trace_content, &config.trace_salt),
                is_error: summary.is_error,
                duration_ms,
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
        caller: &Caller,
    ) -> Result<CallToolResponse, ErrorData> {
        let name = request.name.to_string();
        if !caller.principal.allows_tool(&name) {
            let scope = required_scope(&name).as_str();
            let error = anyhow::Error::from(UserError::Refused(format!(
                "{name} needs the {scope} scope, which this connection ({}) does not have. Ask the user to grant it in the client's Kioku settings",
                caller.principal.subject
            )));
            return Ok(error_text(render_error(&name, &error)).into());
        }
        if let Some(reason) = caller.session.refusal() {
            let error = anyhow::Error::from(UserError::Refused(reason.to_owned()));
            return Ok(error_text(render_error(&name, &error)).into());
        }
        if name == "rag_context_query" {
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

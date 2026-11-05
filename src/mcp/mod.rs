//! The MCP surface: tools, prompts, and server instructions.
//!
//! One server has to work for a quantized local model and for frontier
//! models, through clients that each handle schemas, results, and
//! instructions differently. The surface therefore follows the lowest common
//! denominator (see `docs/clients.md`):
//! - three core tools by default; the rest are opt-in profiles;
//! - flat input schemas without `$ref`, null unions, or `format`;
//! - memories addressed by human-readable key, never only by UUID;
//! - lenient argument parsing and errors that include a corrected example;
//! - the same JSON in text and structured content, because some clients show
//!   the model only one of the two.

mod admin_tools;
mod args;
mod core_tools;
mod dispatch;
mod legacy;
mod output;
mod profile;
mod prompts;
mod resolve;
mod schema;

pub use profile::{ALL_TOOLS, CORE_TOOLS};

use std::collections::BTreeSet;
use std::sync::Arc;

use rmcp::handler::server::router::prompt::PromptRouter;
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::model::{
    CacheScope, CallToolRequestParams, CallToolResponse, Implementation, ListToolsResult,
    PaginatedRequestParams, ProtocolVersion, ResultType, ServerCapabilities, ServerConfig,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer, ServerHandler, prompt_handler, tool_handler};

use crate::access::Principal;
use crate::app::App;
use crate::error::UserError;
use crate::trace::Tracer;
use crate::vault::Session;
use dispatch::Caller;
use legacy::upgrade_legacy;
use output::error_text;
use profile::{instructions_for, select_tools};

// Corrected calls quoted in argument errors, one per argument shape.
const SEARCH_EXAMPLE: &str = r#"{"query":"webhook retry policy","domain":"relay"}"#;
const GET_EXAMPLE: &str = r#"{"keys":["webhook-retries"],"domain":"relay"}"#;
const SAVE_EXAMPLE: &str = r#"{"key":"webhook-dedup-retention","title":"Webhook dedup token retention","body":"Relay keeps webhook dedup tokens for 72 hours because partners replay deliveries for up to 3 days.","domain":"relay","related":["webhook-retries"]}"#;
const KEY_EXAMPLE: &str = r#"{"key":"webhook-retries","domain":"relay"}"#;
const FEEDBACK_EXAMPLE: &str = r#"{"key":"webhook-retries","positive":true,"domain":"relay"}"#;
const IMPORT_EXAMPLE: &str = r#"{"path":"relay","domain":"relay"}"#;
const MAINTENANCE_EXAMPLE: &str = r#"{"dry_run":true}"#;

#[derive(Clone)]
pub struct MemoryServer {
    app: App,
    tool_router: ToolRouter<Self>,
    prompt_router: PromptRouter<Self>,
    tracer: Option<Tracer>,
    instructions: String,
    /// The process's own caller: the stdio profile and the vault its folder
    /// places it in, or over HTTP a principal with no scopes, so a request the
    /// HTTP layer didn't authenticate gets nothing.
    caller: Arc<Caller>,
}

impl MemoryServer {
    /// Build a stdio server with the tools selected by `spec`: `core`
    /// (default), `all`, or a comma-separated list mixing those with tool
    /// names. Tools outside the process principal's scopes are not listed.
    ///
    /// With a vaults file, the session is placed by `KIOKU_SESSION_DIR`, else
    /// the working directory, and declares its provider in `MEMORY_PROVIDER`.
    pub fn new(app: App, spec: Option<&str>) -> anyhow::Result<Self> {
        let principal = Arc::new(app.config.principal.clone());
        let folder = app
            .config
            .session_dir
            .clone()
            .or_else(|| std::env::current_dir().ok());
        let session = Session::for_folder(
            app.config.vaults.as_ref(),
            app.config.provider.as_deref(),
            folder.as_deref(),
        );
        match &session {
            Session::Open => {}
            Session::Placed(placement) => tracing::info!(
                vault = placement.vault(),
                area = placement.area(),
                provider = %placement.provider(),
                "session placed in a vault"
            ),
            Session::Refused(reason) => {
                tracing::warn!(reason = reason.as_str(), "this session gets no memories");
            }
        }
        Self::build(app, spec, Arc::new(Caller::new(principal, session)))
    }

    /// Build a server for the HTTP transport. Each request carries its own
    /// principal, so every selected tool is routed and `tools/list` is
    /// filtered per request.
    pub fn new_http(app: App, spec: Option<&str>) -> anyhow::Result<Self> {
        let nobody = Principal::nobody();
        let session = Session::for_principal(app.config.vaults.as_ref(), &nobody);
        Self::build(app, spec, Arc::new(Caller::new(Arc::new(nobody), session)))
    }

    fn build(app: App, spec: Option<&str>, caller: Arc<Caller>) -> anyhow::Result<Self> {
        let mut selected = select_tools(spec.unwrap_or(&app.config.tools))?;
        let principal = &caller.principal;
        if !principal.scopes.is_empty() {
            selected.retain(|tool| principal.allows_tool(tool));
        }
        let tool_router = Self::router_for(&selected, app.config.notes_root.is_some());
        let instructions = instructions_for(&selected);
        let tracer = app
            .config
            .trace_file
            .as_deref()
            .map(Tracer::open)
            .transpose()?;
        Ok(Self {
            app,
            tool_router,
            prompt_router: Self::prompt_router(),
            tracer,
            instructions,
            caller,
        })
    }

    /// The tools for a selection, fixed for the life of the process.
    fn router_for(selected: &BTreeSet<String>, can_import: bool) -> ToolRouter<Self> {
        let mut router = Self::core_router() + Self::admin_router();
        for name in ALL_TOOLS {
            if !selected.contains(name) || (name == "memory_import" && !can_import) {
                router.remove_route(name);
            }
        }
        router
    }

    /// Names of the tools this server lists.
    pub fn tool_names(&self) -> Vec<String> {
        self.tool_router
            .list_all()
            .into_iter()
            .map(|tool| tool.name.to_string())
            .collect()
    }

    /// The requested domain, or the default one, if the caller may use it.
    /// In vault mode the default is the session's area, else its vault's
    /// default domain.
    fn domain(&self, domain: Option<&str>) -> anyhow::Result<String> {
        let caller = self.caller();
        let domain = match domain.map(str::trim).filter(|d| !d.is_empty()) {
            Some(domain) => domain.to_owned(),
            None => caller
                .default_domain()
                .unwrap_or(&self.app.config.default_domain)
                .to_owned(),
        };
        self.authorize_domain(&domain)?;
        Ok(domain)
    }

    /// Every stored domain the caller may see, in name order.
    async fn visible_domains(&self) -> anyhow::Result<Vec<String>> {
        let caller = self.caller();
        let mut visible = Vec::new();
        for domain in self.app.store.domains().await? {
            if caller.viewer.sees_domain(&domain)? {
                visible.push(domain);
            }
        }
        Ok(visible)
    }

    /// Refuse a domain outside the caller's patterns, its vault, or its locks.
    fn authorize_domain(&self, domain: &str) -> anyhow::Result<()> {
        let caller = self.caller();
        if !caller.principal.allows_domain(domain) {
            return Err(UserError::Refused(format!(
                "domain {domain:?} is outside what this connection ({}) may use: {}. Use one of those domains",
                caller.principal.subject,
                caller.principal.describe_domains()
            ))
            .into());
        }
        caller.viewer.check_domain(domain)
    }
}

#[tool_handler(router = self.tool_router)]
#[prompt_handler(router = self.prompt_router)]
impl ServerHandler for MemoryServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().enable_prompts().build())
            .with_server_info(
                Implementation::new("kioku", env!("CARGO_PKG_VERSION"))
                    .with_title("Kioku")
                    .with_description("Curated long-term project memory for coding agents: hybrid search over notes with an explicit link graph"),
            )
            .with_instructions(self.instructions.clone())
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let caller = self.principal_for(&context);
        let supports_cache_hints = context
            .protocol_version()
            .is_some_and(|version| version >= ProtocolVersion::V_2026_07_28);
        let tools = self
            .tool_router
            .list_all()
            .into_iter()
            .filter(|tool| caller.allows_tool(&tool.name))
            .collect();
        Ok(ListToolsResult {
            result_type: Some(ResultType::COMPLETE),
            tools,
            meta: None,
            next_cursor: None,
            ttl_ms: supports_cache_hints.then_some(0),
            // The list depends on who asks, so shared caches must not reuse it.
            cache_scope: supports_cache_hints.then_some(CacheScope::Private),
        })
    }

    async fn call_tool(
        &self,
        mut request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let called = match upgrade_legacy(&mut request) {
            Ok(called) => called,
            Err(text) => return Ok(error_text(text).into()),
        };
        self.traced(request, context, called).await
    }
}

#[cfg(test)]
mod tests;

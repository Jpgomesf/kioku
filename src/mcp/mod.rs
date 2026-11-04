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

use rmcp::handler::server::router::prompt::PromptRouter;
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, Implementation, ServerCapabilities, ServerConfig,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer, ServerHandler, prompt_handler, tool_handler};

use crate::app::App;
use crate::trace::Tracer;
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
}

impl MemoryServer {
    /// Build the server with the tools selected by `spec`: `core` (default),
    /// `all`, or a comma-separated list mixing those with tool names.
    pub fn new(app: App, spec: Option<&str>) -> anyhow::Result<Self> {
        let selected = select_tools(spec.unwrap_or(&app.config.tools))?;
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

    fn domain(&self, domain: Option<&str>) -> String {
        self.app
            .domain(domain.map(str::trim).filter(|d| !d.is_empty()))
            .to_owned()
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

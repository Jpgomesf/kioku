//! Local HTTP transport (cargo feature `http`): MCP Streamable HTTP on a
//! loopback address, for clients that can't spawn a process or that should
//! share one server.
//!
//! Every request needs a bearer token listed (as a SHA-256 hash) in an access
//! file, even on 127.0.0.1, because any local process or a web page could
//! otherwise reach the port. Host and Origin headers are validated against DNS
//! rebinding. The token check is the only part that knows about credentials;
//! it hands tools a [`Principal`], so an OAuth verifier can replace it later.

use std::net::SocketAddr;
use std::sync::Arc;

use crate::access::{AccessFile, Principal, token_hash};
use crate::app::App;
use crate::mcp::MemoryServer;
use anyhow::{Context, Result, ensure};
use axum::extract::{Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};

/// Largest request body accepted, in bytes. Notes are capped far below this.
const MAX_BODY_BYTES: usize = 1 << 20;

pub struct HttpOptions {
    pub addr: SocketAddr,
    pub access: AccessFile,
    pub tools: Option<String>,
    /// Browser origins allowed to call the server. Empty means requests that
    /// carry an `Origin` header are refused; CLI clients send none.
    pub allowed_origins: Vec<String>,
}

/// Serve MCP at `http://<addr>/mcp` until Ctrl-C.
pub async fn serve(app: App, options: HttpOptions) -> Result<()> {
    ensure!(
        options.addr.ip().is_loopback(),
        "kioku serves HTTP only on a loopback address such as 127.0.0.1; {} would expose memories to the network",
        options.addr
    );
    // Fail at startup, not on the first request, if the tool selection is bad.
    MemoryServer::new_http(app.clone(), options.tools.as_deref())?;
    let tools = options.tools.clone();
    let factory_app = app.clone();
    let config = StreamableHttpServerConfig::default()
        .with_allowed_origins(options.allowed_origins.clone())
        .enforce_origin_validation()
        .with_max_request_body_bytes(MAX_BODY_BYTES);
    let service = StreamableHttpService::new(
        move || {
            MemoryServer::new_http(factory_app.clone(), tools.as_deref())
                .map_err(|error| std::io::Error::other(format!("{error:#}")))
        },
        Arc::new(LocalSessionManager::default()),
        config,
    );
    let principals = options.access.len();
    let router =
        axum::Router::new()
            .nest_service("/mcp", service)
            .layer(middleware::from_fn_with_state(
                Arc::new(options.access),
                authenticate,
            ));
    let listener = tokio::net::TcpListener::bind(options.addr)
        .await
        .with_context(|| format!("cannot listen on {}", options.addr))?;
    tracing::warn!(
        url = %format!("http://{}/mcp", options.addr),
        principals,
        "serving MCP over HTTP"
    );
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .context("HTTP server failed")
}

/// Resolve the bearer token to a principal, or answer 401.
async fn authenticate(
    State(access): State<Arc<AccessFile>>,
    mut request: Request,
    next: Next,
) -> Response {
    let token = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|token| !token.is_empty());
    let Some(principal) = token.and_then(|token| access.find(&token_hash(token))) else {
        tracing::warn!(
            has_token = token.is_some(),
            "rejected HTTP request without a valid token"
        );
        return (
            StatusCode::UNAUTHORIZED,
            [(header::WWW_AUTHENTICATE, r#"Bearer realm="kioku""#)],
            "a valid bearer token is required",
        )
            .into_response();
    };
    let principal: Arc<Principal> = Arc::new(principal.clone());
    request.extensions_mut().insert(principal);
    next.run(request).await
}

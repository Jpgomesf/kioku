//! Tool results: identical text and structured content, and categorized errors.

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, MetaObject};
use serde_json::{Value, json};

use crate::embedding::EmbedError;
use crate::error::UserError;

use super::args;

/// Text answer for a successful call: identical JSON in text and structured content.
pub(super) fn ok(value: Value) -> CallToolResult {
    CallToolResult::structured(value)
}

pub(super) fn error_text(text: String) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(args::clip(text))])
}

/// `_meta` asking Claude Code to load a tool up front instead of deferring it.
pub(super) fn always_load() -> MetaObject {
    let mut meta = JsonObject::new();
    meta.insert("anthropic/alwaysLoad".into(), json!(true));
    MetaObject::from(meta)
}

pub(super) fn round(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

pub(super) fn clamp(value: i64, min: i64, max: i64, name: &str, notes: &mut Vec<String>) -> usize {
    let clamped = value.clamp(min, max);
    if clamped != value {
        notes.push(format!(
            "{name} {value} was clamped to {clamped} (allowed {min}-{max})"
        ));
    }
    usize::try_from(clamped).unwrap_or(0)
}

/// Turn any failure into one short, categorized text for the model. Problems
/// the caller can fix are shown in full; internal chains go to the log only.
pub(super) fn render_error(tool: &str, error: &anyhow::Error) -> String {
    if let Some(user) = error.chain().find_map(|e| e.downcast_ref::<UserError>()) {
        return format!("{}: {error:#}", user.category());
    }
    if let Some(embed) = error.chain().find_map(|e| e.downcast_ref::<EmbedError>()) {
        return match embed {
            EmbedError::TooLong { .. } => format!("invalid_argument: {embed}"),
            EmbedError::Rejected { .. } | EmbedError::Unavailable(_) => format!(
                "unavailable: the embedding service is not working ({embed}). Continue without memory, tell the user, and suggest running `kioku doctor`"
            ),
        };
    }
    let busy = error.chain().any(|e| {
        e.downcast_ref::<sqlx::Error>().is_some_and(|e| {
            e.as_database_error()
                .and_then(|d| d.code())
                .is_some_and(|code| code == "55P03")
        })
    }) || error.to_string().contains("busy");
    if busy {
        return "busy: another Kioku write is in progress. Retry this call once in a few seconds"
            .into();
    }
    let unreachable = error.chain().any(|e| {
        e.downcast_ref::<sqlx::Error>().is_some_and(|e| {
            matches!(
                e,
                sqlx::Error::PoolTimedOut | sqlx::Error::PoolClosed | sqlx::Error::Io(_)
            )
        }) || e
            .downcast_ref::<reqwest::Error>()
            .is_some_and(|e| e.is_connect() || e.is_timeout())
    });
    tracing::warn!(tool, error = format!("{error:#}"), "tool call failed");
    if unreachable {
        return format!(
            "unavailable: {tool} could not reach PostgreSQL or Qdrant. Continue without memory, tell the user, and suggest running `kioku doctor`"
        );
    }
    let top = error.to_string();
    let top = if error.downcast_ref::<sqlx::Error>().is_some()
        || error.downcast_ref::<reqwest::Error>().is_some()
    {
        "a storage request failed".to_owned()
    } else {
        top
    };
    format!(
        "internal: {tool} failed: {top}. Details are in the server log; retry once, then continue without memory and tell the user"
    )
}

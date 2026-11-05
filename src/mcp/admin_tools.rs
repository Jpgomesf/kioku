//! Tools for curating memory, enabled by the `all` profile or by name.

use std::collections::HashSet;

use chrono::Utc;
use rmcp::model::{CallToolResult, JsonObject};
use rmcp::{tool, tool_router};
use serde_json::{Value, json};
use uuid::Uuid;

use super::args::{EmptyArgs, FeedbackArgs, ImportArgs, KeyArgs, MaintenanceArgs, parse};
use crate::error::UserError;
use crate::lifecycle;

use super::output::{error_text, ok, render_error, round};
use super::{
    FEEDBACK_EXAMPLE, IMPORT_EXAMPLE, KEY_EXAMPLE, MAINTENANCE_EXAMPLE, MemoryServer, schema,
};

/// History entries memory_inspect shows, newest first.
const INSPECT_HISTORY: i64 = 10;

#[tool_router(router = admin_router, vis = "pub(super)")]
impl MemoryServer {
    #[tool(
        name = "memory_inspect",
        title = "Inspect a memory",
        description = "Show one memory's metadata and explicit links without its text: source, status, dates, confidence, pin, usage and feedback counts, retention score, index state, and linked memories with direction. Use for provenance, freshness, or dependency questions; use memory_get to read the text. Read-only.",
        input_schema = schema::input::<KeyArgs>(),
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn memory_inspect(&self, raw: JsonObject) -> CallToolResult {
        let args: KeyArgs = match parse(
            "memory_inspect",
            raw,
            &schema::input::<KeyArgs>(),
            &[],
            KEY_EXAMPLE,
        ) {
            Ok(args) => args,
            Err(text) => return error_text(text),
        };
        match self.inspect(args).await {
            Ok(value) => ok(value),
            Err(error) => error_text(render_error("memory_inspect", &error)),
        }
    }

    #[tool(
        name = "memory_feedback",
        title = "Rate a memory",
        description = "Record that a memory proved correct and helpful (positive=true) or wrong or outdated (positive=false). Use only after explicit user feedback or a verified outcome, never just because you retrieved it. To fix wrong content, update it with memory_save. Repeats with the same request_id, or on the same day, count once.",
        input_schema = schema::input::<FeedbackArgs>(),
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn memory_feedback(&self, raw: JsonObject) -> CallToolResult {
        let args: FeedbackArgs = match parse(
            "memory_feedback",
            raw,
            &schema::input::<FeedbackArgs>(),
            &[],
            FEEDBACK_EXAMPLE,
        ) {
            Ok(args) => args,
            Err(text) => return error_text(text),
        };
        let result = async {
            let domain = self.domain(args.domain.as_deref())?;
            let id = self
                .resolve_one("memory_feedback", &domain, &args.key)
                .await?;
            let request_id = args.request_id.unwrap_or_else(|| {
                format!(
                    "auto:{id}:{}:{}",
                    args.positive,
                    Utc::now().format("%Y-%m-%d")
                )
            });
            let outcome = self
                .app
                .feedback(id, args.positive, &request_id, Some(&domain))
                .await?;
            anyhow::Ok(
                json!({"key": args.key, "domain": domain, "positive": args.positive, "applied": outcome["applied"]}),
            )
        };
        match result.await {
            Ok(value) => ok(value),
            Err(error) => error_text(render_error("memory_feedback", &error)),
        }
    }

    #[tool(
        name = "memory_retire",
        title = "Retire a memory",
        description = "Retire a memory confirmed obsolete with no replacement: it leaves default search, and memory_get still returns it marked legacy. Nothing is deleted; memory_restore reverses it. If the fact changed, update it with memory_save instead. Use only when the user asks or the obsolescence is verified.",
        input_schema = schema::input::<KeyArgs>(),
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn memory_retire(&self, raw: JsonObject) -> CallToolResult {
        self.set_status("memory_retire", raw, true).await
    }

    #[tool(
        name = "memory_restore",
        title = "Restore a memory",
        description = "Return a retired (legacy) memory to default search after verifying it is still correct. Find retired memories with memory_search and include_legacy=true.",
        input_schema = schema::input::<KeyArgs>(),
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn memory_restore(&self, raw: JsonObject) -> CallToolResult {
        self.set_status("memory_restore", raw, false).await
    }

    #[tool(
        name = "memory_import",
        title = "Import Markdown notes",
        description = "Import or re-index Markdown notes (YAML frontmatter: key, title, domain, aliases, related, tags) from the configured notes folder after you create or edit them. File content replaces the stored copy; unchanged files are skipped. Paths are relative to the notes folder and cannot leave it. Returns counts and unresolved links. Does not watch files.",
        input_schema = schema::input::<ImportArgs>(),
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    async fn memory_import(&self, raw: JsonObject) -> CallToolResult {
        let args: ImportArgs = match parse(
            "memory_import",
            raw,
            &schema::input::<ImportArgs>(),
            &[],
            IMPORT_EXAMPLE,
        ) {
            Ok(args) => args,
            Err(text) => return error_text(text),
        };
        let domain = match self.domain(args.domain.as_deref()) {
            Ok(domain) => domain,
            Err(error) => return error_text(render_error("memory_import", &error)),
        };
        let caller = self.caller();
        let imported = self
            .app
            .hydrate(args.path.as_deref(), Some(&domain), Some(&caller.viewer));
        match imported.await {
            Ok(report) => {
                let mut out = json!({
                    "domain": domain,
                    "imported": report.imported,
                    "notes": report.notes.iter().map(|n| json!({"key": n.key, "revision": n.revision})).collect::<Vec<_>>(),
                    "truncated": report.truncated,
                    "unresolved_related": report.unresolved_relationships.iter().take(20).map(|u| json!({"ref": u.reference, "reason": u.reason})).collect::<Vec<_>>(),
                    "unresolved_count": report.unresolved_count,
                    "failed": report.failed.iter().take(20).collect::<Vec<_>>(),
                    "failed_count": report.failed.len() + report.hidden_failures,
                });
                // Only vault sessions have failures they aren't told about.
                if let Some(hint) = report.unnamed_failures() {
                    out["hint"] = json!(hint);
                }
                if report.not_sent_to_embedder > 0 {
                    out["not_sent_to_embedder"] = json!(report.not_sent_to_embedder);
                }
                ok(out)
            }
            Err(error) => error_text(render_error("memory_import", &error)),
        }
    }

    #[tool(
        name = "memory_maintenance",
        title = "Age memories",
        description = "Preview (default) or apply the monthly aging pass: active, unpinned memories whose retention score fell below the threshold move to legacy. Nothing is deleted and memory_restore reverses it. The server already runs it daily, so use it to preview, or apply only when the user asks.",
        input_schema = schema::input::<MaintenanceArgs>(),
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn memory_maintenance(&self, raw: JsonObject) -> CallToolResult {
        let args: MaintenanceArgs = match parse(
            "memory_maintenance",
            raw,
            &schema::input::<MaintenanceArgs>(),
            &[],
            MAINTENANCE_EXAMPLE,
        ) {
            Ok(args) => args,
            Err(text) => return error_text(text),
        };
        let caller = self.caller();
        let refusal = if caller.session.placement().is_some() {
            Some("memory_maintenance ages the memories of every vault, so a vault session can't run it. Ask the user to run `kioku maintenance` from a shell".to_owned())
        } else if !caller.principal.sees_all_domains() {
            Some(format!(
                "memory_maintenance ages every domain, and this connection ({}) may use only {}",
                caller.principal.subject,
                caller.principal.describe_domains()
            ))
        } else {
            None
        };
        if let Some(text) = refusal {
            let error = anyhow::Error::from(UserError::Refused(text));
            return error_text(render_error("memory_maintenance", &error));
        }
        match self.app.maintenance(args.dry_run.unwrap_or(true)).await {
            Ok(value) => ok(value),
            Err(error) => error_text(render_error("memory_maintenance", &error)),
        }
    }

    #[tool(
        name = "memory_stats",
        title = "Memory statistics",
        description = "Count memories by status and by domain, plus pending index work, links, and feedback events. Use to check store health or find which domains exist. Reads no memory text.",
        input_schema = schema::empty(),
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn memory_stats(&self, raw: JsonObject) -> CallToolResult {
        if let Err(text) = parse::<EmptyArgs>("memory_stats", raw, &schema::empty(), &[], "{}") {
            return error_text(text);
        }
        let caller = self.caller();
        let result = async {
            if let Some(placement) = caller.session.placement() {
                return self.vault_stats(placement.vault()).await;
            }
            let by_domain: serde_json::Map<String, Value> = self
                .app
                .store
                .domain_counts()
                .await?
                .into_iter()
                .filter(|(domain, _)| caller.principal.allows_domain(domain))
                .map(|(domain, count)| (domain, json!(count)))
                .collect();
            if !caller.principal.sees_all_domains() {
                // Store-wide totals would reveal domains this caller can't see.
                return anyhow::Ok(json!({"by_domain": by_domain}));
            }
            let mut stats = self.app.store.stats().await?;
            stats["by_domain"] = Value::Object(by_domain);
            anyhow::Ok(stats)
        };
        match result.await {
            Ok(value) => ok(value),
            Err(error) => error_text(render_error("memory_stats", &error)),
        }
    }
}

impl MemoryServer {
    async fn inspect(&self, args: KeyArgs) -> anyhow::Result<Value> {
        let domain = self.domain(args.domain.as_deref())?;
        let id = self
            .resolve_one("memory_inspect", &domain, &args.key)
            .await?;
        let note = self.app.require_note(id, Some(&domain)).await?;
        let caller = self.caller();
        let graph = self
            .app
            .graph_context(id, Some(&domain), true, Some(&caller.viewer))
            .await?;
        let history = self.app.store.revisions(id, INSPECT_HISTORY).await?;
        let retention = lifecycle::retention(&note, Utc::now(), self.app.config.half_life_days);
        let source = self.display_source(note.input.source.as_deref());
        let origin = if note
            .input
            .source
            .as_deref()
            .is_some_and(|s| std::path::Path::new(s).is_absolute())
        {
            "file"
        } else {
            "agent"
        };
        let mut out = json!({
            "key": note.input.key,
            "id": note.id,
            "domain": note.input.domain,
            "title": note.input.title,
            "status": note.status,
            "pinned": note.input.pinned,
            "confidence": note.input.confidence,
            "source": source,
            "origin": origin,
            "created_at": note.created_at,
            "updated_at": note.updated_at,
            "last_used_at": note.last_accessed_at,
            "access_count": note.access_count,
            "feedback": {"positive": note.positive_feedback, "negative": note.negative_feedback},
            "retention": round(retention),
            "revision": note.revision,
            "indexed": note.vector_synced,
            "links": graph["neighbors"],
            "links_total": graph["total_neighbors"],
            "truncated": graph["truncated"],
            "history": history,
        });
        // Without a vector, search finds the note only by keyword and link.
        if !self.app.embedder_reads(&note.input) {
            out["not_sent_to_embedder"] = json!(true);
        }
        Ok(out)
    }

    /// Statistics over the notes a vault session may see, and nothing else:
    /// store-wide totals would reveal other vaults.
    async fn vault_stats(&self, vault: &str) -> anyhow::Result<Value> {
        let caller = self.caller();
        let viewer = &caller.viewer;
        let domains = self.visible_domains(true).await?;
        let mut by_domain = serde_json::Map::new();
        let (mut total, mut active, mut pending, mut edges) = (0usize, 0usize, 0usize, 0usize);
        for domain in &domains {
            let mut notes = self.app.store.notes(Some(domain), true).await?;
            notes.retain(|note| viewer.sees(note));
            if notes.is_empty() {
                continue;
            }
            total += notes.len();
            active += notes.iter().filter(|n| n.status.is_active()).count();
            pending += notes.iter().filter(|n| !n.vector_synced).count();
            let ids: HashSet<Uuid> = notes.iter().map(|n| n.id).collect();
            edges += self
                .app
                .store
                .edges(Some(domain))
                .await?
                .iter()
                .filter(|e| ids.contains(&e.source) && ids.contains(&e.target))
                .count();
            by_domain.insert(domain.clone(), json!(notes.len()));
        }
        Ok(json!({
            "vault": vault,
            "total": total,
            "active": active,
            "legacy": total - active,
            "pending_vectors": pending,
            "domains": by_domain.len(),
            "edges": edges,
            "by_domain": by_domain,
        }))
    }

    async fn set_status(&self, tool: &str, raw: JsonObject, retire: bool) -> CallToolResult {
        let args: KeyArgs = match parse(tool, raw, &schema::input::<KeyArgs>(), &[], KEY_EXAMPLE) {
            Ok(args) => args,
            Err(text) => return error_text(text),
        };
        let result = async {
            let domain = self.domain(args.domain.as_deref())?;
            let id = self.resolve_one(tool, &domain, &args.key).await?;
            let outcome = self.app.set_legacy(id, retire, Some(&domain)).await?;
            anyhow::Ok(
                json!({"key": outcome["key"], "domain": domain, "status": outcome["status"], "changed": outcome["changed"]}),
            )
        };
        match result.await {
            Ok(value) => ok(value),
            Err(error) => error_text(render_error(tool, &error)),
        }
    }
}

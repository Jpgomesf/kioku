//! Application services shared by the CLI and the MCP server.
//!
//! PostgreSQL is authoritative and Qdrant is a derived index. Every mutation
//! that touches both stores, or rebuilds a domain's graph, runs under
//! [`Store::mutation_lock`]. Embeddings are computed before taking the lock, so
//! a slow or failing embedding service never blocks other writers and never
//! leaves a half-saved note behind.

mod cache;
mod codemap;
mod context;
mod excerpt;
mod import;
mod search;
mod upkeep;
mod write;

pub use codemap::{
    CodePlace, FileMap, Neighbour, PurposeCounts, Relation, UpdateOptions, UpdateReport,
    lookup_file, update_repo,
};
pub use context::{ContextMemory, ContextPack, ContextRequest, SkippedMemory};
pub use import::{ImportFailure, ImportFormat, ImportReport, ImportedNote, OkfImport};
pub use search::{SearchHit, SearchRequest, SearchResults, SearchStats, Signals};
pub use upkeep::{ReindexReport, RepairFailure, RepairReport};
pub use write::{UpsertOutcome, WriteOrigin};

use std::path::Path;

use anyhow::{Context, Result};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::config::Config;
use crate::embedding::{Embedder, is_too_long};
use crate::error::{UserError, not_found};
use crate::model::{Note, NoteInput};
use crate::store::Store;
use crate::vector::Qdrant;

#[derive(Clone)]
pub struct App {
    pub config: Config,
    pub store: Store,
    pub vector: Qdrant,
    embedder: Embedder,
    /// This process's search indexes, shared by its clones.
    cache: std::sync::Arc<cache::SearchCache>,
}

/// Text embedded for a note: its identifying labels, then the body.
fn document_text(input: &NoteInput) -> String {
    format!(
        "{}\nAliases: {}\nTags: {}\n{}",
        input.title,
        input.aliases.join(", "),
        input.tags.join(", "),
        input.body
    )
}

/// For `skip_serializing_if`: counts that are usually zero stay out of reports.
fn is_zero(count: &usize) -> bool {
    *count == 0
}

fn is_file_source(source: &str) -> bool {
    Path::new(source).is_absolute()
}

/// Say which note was too long, and that nothing was saved.
fn too_long_context(error: anyhow::Error, input: &NoteInput) -> anyhow::Error {
    if is_too_long(&error) {
        let size = input.body.len();
        let note = match input.source.as_deref() {
            Some(source) if is_file_source(source) => {
                format!("{}/{} ({source})", input.domain, input.key)
            }
            _ => format!("{}/{}", input.domain, input.key),
        };
        UserError::InvalidArgument(format!(
            "{note} is too long for the embedding model ({size} bytes of text). Split it into focused notes, one decision each, and link them with related. Nothing was saved"
        ))
        .into()
    } else {
        error
    }
}

impl App {
    pub async fn connect(config: Config) -> Result<Self> {
        let store = Store::connect(&config.database_url).await?;
        store.migrate().await?;
        let vector = Qdrant::new(
            &config.qdrant_url,
            &config.collection,
            config.qdrant_api_key.clone(),
            config.embedding_dim,
        )?;
        {
            let _guard = store.mutation_lock().await?;
            store
                .ensure_embedding_identity(&config.embedding_identity())
                .await?;
            let created = vector.ensure_collection_created().await?;
            if created || vector.point_count().await? == 0 {
                store.invalidate_vectors().await?;
            }
        }
        let embedder = Embedder::new(&config)?;
        Ok(Self {
            config,
            store,
            vector,
            embedder,
            cache: Default::default(),
        })
    }

    pub fn domain<'a>(&'a self, domain: Option<&'a str>) -> &'a str {
        domain.unwrap_or(&self.config.default_domain)
    }

    /// A note's source as shown to models: relative to `MEMORY_NOTES_ROOT` for
    /// notes imported from there, otherwise as stored.
    pub fn display_source(&self, source: Option<&str>) -> Option<String> {
        let source = source?;
        let relative = self
            .config
            .notes_root
            .as_ref()
            .and_then(|root| Path::new(source).strip_prefix(root).ok())
            .map(|path| path.to_string_lossy().into_owned());
        Some(relative.unwrap_or_else(|| source.to_owned()))
    }

    /// Whether the embedding service may receive this note; see
    /// [`Embedder::reads`].
    pub fn embedder_reads(&self, input: &NoteInput) -> bool {
        self.embedder.reads(input)
    }

    async fn embed_note(&self, input: &NoteInput) -> Result<Vec<f32>> {
        let mut vectors = self
            .embedder
            .embed_documents(&[document_text(input)])
            .await
            .map_err(|error| too_long_context(error, input))?;
        vectors
            .pop()
            .context("the embedding service returned no vector")
    }

    pub async fn require_note(&self, id: Uuid, domain: Option<&str>) -> Result<Note> {
        let domain = self.domain(domain);
        match self.store.get(id).await? {
            Some(note) if note.input.domain == domain => Ok(note),
            _ => not_found!("no memory {id} in domain {domain:?}"),
        }
    }

    pub async fn doctor(&self) -> Result<Value> {
        self.vector.health().await?;
        let probe = self.embedder.embed_query("kioku health check").await?;
        Ok(json!({
            "postgres": "ok",
            "qdrant": "ok",
            "embeddings": "ok",
            "embedding_model": self.config.embedding_model,
            "embedding_prompts": self.config.embedding_prompts.profile,
            "embedding_reader": self.config.embedding_reader.as_str(),
            "dimensions": probe.len(),
            "stats": self.store.stats().await?,
        }))
    }
}

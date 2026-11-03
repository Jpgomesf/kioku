//! Configuration from environment variables (optionally loaded from a dotenv file).

use std::path::PathBuf;

use anyhow::{Context, Result, bail, ensure};
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EmbeddingProvider {
    /// Ollama's `/api/embed`.
    Ollama,
    /// Any OpenAI-compatible `/embeddings` endpoint (llama.cpp, vLLM, LM Studio, OpenAI).
    #[serde(rename = "openai")]
    OpenAi,
}

/// Text added in front of queries and documents before embedding. Asymmetric
/// models are trained with these and lose accuracy without them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EmbeddingPrompts {
    /// Short name stored in the embedding identity when it changes vectors.
    pub profile: String,
    pub query: String,
    pub document: String,
}

impl EmbeddingPrompts {
    /// Known prompt formats by model family, matched on the model name.
    pub fn for_model(model: &str) -> Self {
        let name = model.to_ascii_lowercase();
        let base = name.rsplit('/').next().unwrap_or(&name);
        let (profile, query, document) = if base.contains("nomic-embed-text") {
            ("nomic", "search_query: ", "search_document: ")
        } else if base.starts_with("qwen3-embedding") {
            (
                "qwen3",
                "Instruct: Given a question about a software project, retrieve the notes that answer it\nQuery:",
                "",
            )
        } else if base.starts_with("embeddinggemma") {
            (
                "gemma",
                "task: search result | query: ",
                "title: none | text: ",
            )
        } else if base.starts_with("snowflake-arctic-embed") {
            ("arctic", "query: ", "")
        } else if base.starts_with("mxbai-embed-large") {
            (
                "mxbai",
                "Represent this sentence for searching relevant passages: ",
                "",
            )
        } else {
            ("none", "", "")
        };
        Self {
            profile: profile.to_owned(),
            query: query.to_owned(),
            document: document.to_owned(),
        }
    }

    /// Profiles whose behavior predates this registry. Leaving them out of the
    /// stored identity keeps existing databases valid.
    fn is_legacy(&self) -> bool {
        matches!(self.profile.as_str(), "nomic" | "none")
    }
}

#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub qdrant_url: String,
    pub collection: String,
    pub qdrant_api_key: Option<String>,
    pub embedding_provider: EmbeddingProvider,
    pub embedding_url: String,
    pub embedding_model: String,
    pub embedding_dim: usize,
    pub embedding_api_key: Option<String>,
    pub embedding_prompts: EmbeddingPrompts,
    pub half_life_days: f64,
    pub legacy_threshold: f64,
    pub default_domain: String,
    pub notes_root: Option<PathBuf>,
    /// Run aging and index repair in the background while serving MCP.
    pub background_upkeep: bool,
    /// Append every MCP tool call to this JSONL file (opt-in; contains note text).
    pub trace_file: Option<PathBuf>,
    /// Free-form label written into every trace record, such as an eval run id.
    pub trace_run: Option<String>,
    /// Tools the MCP server lists: `core` (default), `all`, or a comma-separated list.
    pub tools: String,
}

/// Field order is the serialized order. It must stay alphabetical so the
/// string matches identities stored by earlier versions.
#[derive(Serialize)]
struct EmbeddingIdentity<'a> {
    collection: &'a str,
    dimension: usize,
    model: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    prompts: Option<String>,
    provider: EmbeddingProvider,
}

/// Whether a URL points at this machine. The URL parser has already normalized
/// IPv4 shorthand such as `127.1` and hex forms to dotted decimal.
fn is_loopback(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

impl Config {
    pub fn from_env() -> Result<Self> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    /// Build the configuration from any variable source, so tests never mutate
    /// the process environment.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self> {
        let optional = |name: &str| lookup(name).filter(|v| !v.is_empty());
        let value =
            |name: &str, default: &str| optional(name).unwrap_or_else(|| default.to_owned());
        let embedding_model = value("EMBEDDING_MODEL", "nomic-embed-text");
        let mut prompts = EmbeddingPrompts::for_model(&embedding_model);
        if let Some(query) = optional("EMBEDDING_QUERY_PREFIX") {
            prompts.query = query;
            prompts.profile = "custom".to_owned();
        }
        if let Some(document) = optional("EMBEDDING_DOCUMENT_PREFIX") {
            prompts.document = document;
            prompts.profile = "custom".to_owned();
        }
        let cfg = Self {
            database_url: optional("DATABASE_URL")
                .context("DATABASE_URL is required; run scripts/start.sh to create .env")?,
            qdrant_url: value("QDRANT_URL", "http://127.0.0.1:16333"),
            collection: value("QDRANT_COLLECTION", "local_memory_v1"),
            qdrant_api_key: optional("QDRANT_API_KEY"),
            embedding_provider: match value("EMBEDDING_PROVIDER", "ollama").as_str() {
                "ollama" => EmbeddingProvider::Ollama,
                "openai" => EmbeddingProvider::OpenAi,
                other => bail!("EMBEDDING_PROVIDER must be ollama or openai, got {other:?}"),
            },
            embedding_url: value("EMBEDDING_URL", "http://127.0.0.1:11435"),
            embedding_model,
            embedding_dim: value("EMBEDDING_DIM", "768")
                .parse()
                .context("EMBEDDING_DIM must be a whole number")?,
            embedding_api_key: optional("EMBEDDING_API_KEY"),
            embedding_prompts: prompts,
            half_life_days: value("MEMORY_HALF_LIFE_DAYS", "90")
                .parse()
                .context("MEMORY_HALF_LIFE_DAYS must be a number")?,
            legacy_threshold: value("MEMORY_LEGACY_THRESHOLD", "0.2")
                .parse()
                .context("MEMORY_LEGACY_THRESHOLD must be a number")?,
            default_domain: value("MEMORY_DEFAULT_DOMAIN", "local"),
            notes_root: optional("MEMORY_NOTES_ROOT").map(PathBuf::from),
            background_upkeep: value("MEMORY_BACKGROUND_UPKEEP", "true") != "false",
            trace_file: optional("MEMORY_TRACE_FILE").map(PathBuf::from),
            trace_run: optional("MEMORY_TRACE_RUN"),
            tools: value("MEMORY_TOOLS", "core"),
        };
        ensure!(
            (1..=8192).contains(&cfg.embedding_dim),
            "EMBEDDING_DIM must be between 1 and 8192"
        );
        ensure!(
            cfg.half_life_days.is_finite() && cfg.half_life_days >= 1.0,
            "MEMORY_HALF_LIFE_DAYS must be at least one day"
        );
        ensure!(
            cfg.legacy_threshold.is_finite() && (0.0..1.0).contains(&cfg.legacy_threshold),
            "MEMORY_LEGACY_THRESHOLD must be in [0, 1)"
        );
        ensure!(
            !cfg.default_domain.trim().is_empty(),
            "MEMORY_DEFAULT_DOMAIN cannot be empty"
        );
        ensure!(
            cfg.notes_root
                .as_ref()
                .is_none_or(|root| root.is_absolute()),
            "MEMORY_NOTES_ROOT must be an absolute path, because MCP clients start the server from other directories"
        );
        let embedding_url =
            reqwest::Url::parse(&cfg.embedding_url).context("EMBEDDING_URL is not a valid URL")?;
        ensure!(
            ["http", "https"].contains(&embedding_url.scheme()),
            "EMBEDDING_URL must use http or https"
        );
        ensure!(
            is_loopback(&embedding_url) || value("ALLOW_REMOTE_EMBEDDINGS", "false") == "true",
            "EMBEDDING_URL is not local; set ALLOW_REMOTE_EMBEDDINGS=true only if you intend to send note text there"
        );
        let qdrant_url =
            reqwest::Url::parse(&cfg.qdrant_url).context("QDRANT_URL is not a valid URL")?;
        ensure!(
            is_loopback(&qdrant_url) || qdrant_url.scheme() == "https",
            "QDRANT_URL must use https unless it is on this machine, because requests carry the API key"
        );
        Ok(cfg)
    }

    /// The PostgreSQL database named in `DATABASE_URL`.
    pub fn database_name(&self) -> Result<String> {
        let url =
            reqwest::Url::parse(&self.database_url).context("DATABASE_URL is not a valid URL")?;
        let name = url.path().trim_start_matches('/');
        ensure!(!name.is_empty(), "DATABASE_URL must name a database");
        Ok(name.to_owned())
    }

    /// `DATABASE_URL` pointing at another database on the same server.
    pub fn with_database(&self, name: &str) -> Result<String> {
        let mut url =
            reqwest::Url::parse(&self.database_url).context("DATABASE_URL is not a valid URL")?;
        url.set_path(&format!("/{name}"));
        Ok(url.to_string())
    }

    /// Everything that determines the vector space. A stored identity that
    /// differs means the index was built with another model or prompt format.
    pub fn embedding_identity(&self) -> String {
        let identity = EmbeddingIdentity {
            collection: &self.collection,
            dimension: self.embedding_dim,
            model: &self.embedding_model,
            prompts: (!self.embedding_prompts.is_legacy()).then(|| {
                format!(
                    "{}|{}|{}",
                    self.embedding_prompts.profile,
                    self.embedding_prompts.query,
                    self.embedding_prompts.document
                )
            }),
            provider: self.embedding_provider,
        };
        serde_json::to_string(&identity).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn config(vars: &[(&str, &str)]) -> Result<Config> {
        let mut map: HashMap<String, String> = HashMap::from([(
            "DATABASE_URL".to_owned(),
            "postgresql://memory:secret@127.0.0.1:15432/memory".to_owned(),
        )]);
        for (k, v) in vars {
            map.insert((*k).to_owned(), (*v).to_owned());
        }
        Config::from_lookup(|name| map.get(name).cloned())
    }

    #[test]
    fn identity_string_matches_existing_databases() {
        // Stored by earlier versions; changing it would refuse to start existing installs.
        assert_eq!(
            config(&[]).unwrap().embedding_identity(),
            r#"{"collection":"local_memory_v1","dimension":768,"model":"nomic-embed-text","provider":"ollama"}"#
        );
    }

    #[test]
    fn new_prompt_profiles_are_part_of_the_identity() {
        let cfg = config(&[
            ("EMBEDDING_MODEL", "qwen3-embedding:0.6b"),
            ("EMBEDDING_DIM", "1024"),
        ])
        .unwrap();
        assert_eq!(cfg.embedding_prompts.profile, "qwen3");
        assert!(
            cfg.embedding_identity()
                .contains("\"prompts\":\"qwen3|Instruct:")
        );
        let custom = config(&[("EMBEDDING_QUERY_PREFIX", "q: ")]).unwrap();
        assert!(
            custom
                .embedding_identity()
                .contains("custom|q: |search_document: ")
        );
    }

    #[test]
    fn prompt_registry_matches_model_families() {
        assert_eq!(
            EmbeddingPrompts::for_model("nomic-embed-text:latest").query,
            "search_query: "
        );
        assert_eq!(
            EmbeddingPrompts::for_model("nomic-embed-text-v2-moe").profile,
            "nomic"
        );
        assert_eq!(
            EmbeddingPrompts::for_model("text-embedding-nomic-embed-text-v1.5").profile,
            "nomic"
        );
        assert_eq!(
            EmbeddingPrompts::for_model("embeddinggemma").document,
            "title: none | text: "
        );
        assert_eq!(EmbeddingPrompts::for_model("bge-m3").profile, "none");
    }

    #[test]
    fn remote_services_need_explicit_consent_or_tls() {
        assert!(config(&[("EMBEDDING_URL", "http://10.0.0.5:11434")]).is_err());
        assert!(
            config(&[
                ("EMBEDDING_URL", "https://api.example.com/v1"),
                ("ALLOW_REMOTE_EMBEDDINGS", "true"),
                ("EMBEDDING_PROVIDER", "openai"),
            ])
            .is_ok()
        );
        for local in [
            "http://localhost:1",
            "http://127.0.0.1:1",
            "http://[::1]:1",
            "http://127.1.2.3:1",
        ] {
            assert!(config(&[("EMBEDDING_URL", local)]).is_ok(), "{local}");
        }
        for tricky in [
            "http://localhost.evil.com:1",
            "http://0.0.0.0:1",
            "http://127.0.0.1.nip.io:1",
        ] {
            assert!(config(&[("EMBEDDING_URL", tricky)]).is_err(), "{tricky}");
        }
        assert!(config(&[("QDRANT_URL", "http://qdrant.lan:6333")]).is_err());
        assert!(config(&[("QDRANT_URL", "https://qdrant.example.com")]).is_ok());
    }

    #[test]
    fn invalid_values_are_rejected_with_their_names() {
        let error = config(&[("EMBEDDING_PROVIDER", "cohere")])
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("EMBEDDING_PROVIDER"), "{error}");
        assert!(config(&[("MEMORY_NOTES_ROOT", "notes")]).is_err());
        assert!(config(&[("MEMORY_HALF_LIFE_DAYS", "0")]).is_err());
        assert!(config(&[("MEMORY_LEGACY_THRESHOLD", "1")]).is_err());
    }

    #[test]
    fn database_url_can_point_at_a_sibling_database() {
        let cfg = config(&[]).unwrap();
        assert_eq!(cfg.database_name().unwrap(), "memory");
        assert_eq!(
            cfg.with_database("memory_eval").unwrap(),
            "postgresql://memory:secret@127.0.0.1:15432/memory_eval"
        );
    }
}

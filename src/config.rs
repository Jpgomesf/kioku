use anyhow::{Context, Result, ensure};
use std::env;

#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub qdrant_url: String,
    pub collection: String,
    pub qdrant_api_key: Option<String>,
    pub embedding_provider: String,
    pub embedding_url: String,
    pub embedding_model: String,
    pub embedding_dim: usize,
    pub embedding_api_key: Option<String>,
    pub half_life_days: f64,
    pub legacy_threshold: f64,
    pub default_domain: String,
    pub notes_root: Option<std::path::PathBuf>,
}

fn optional(name: &str) -> Option<String> {
    env::var(name).ok().filter(|v| !v.is_empty())
}
fn value(name: &str, default: &str) -> String {
    optional(name).unwrap_or_else(|| default.into())
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let cfg = Self {
            database_url: env::var("DATABASE_URL")
                .context("DATABASE_URL is required; run scripts/start.sh first")?,
            qdrant_url: value("QDRANT_URL", "http://127.0.0.1:16333"),
            collection: value("QDRANT_COLLECTION", "local_memory_v1"),
            qdrant_api_key: optional("QDRANT_API_KEY"),
            embedding_provider: value("EMBEDDING_PROVIDER", "ollama"),
            embedding_url: value("EMBEDDING_URL", "http://127.0.0.1:11435"),
            embedding_model: value("EMBEDDING_MODEL", "nomic-embed-text"),
            embedding_dim: value("EMBEDDING_DIM", "768")
                .parse()
                .context("invalid EMBEDDING_DIM")?,
            embedding_api_key: optional("EMBEDDING_API_KEY"),
            half_life_days: value("MEMORY_HALF_LIFE_DAYS", "90").parse()?,
            legacy_threshold: value("MEMORY_LEGACY_THRESHOLD", "0.2").parse()?,
            default_domain: value("MEMORY_DEFAULT_DOMAIN", "local"),
            notes_root: optional("MEMORY_NOTES_ROOT").map(std::path::PathBuf::from),
        };
        ensure!(
            ["ollama", "openai"].contains(&cfg.embedding_provider.as_str()),
            "EMBEDDING_PROVIDER must be ollama or openai"
        );
        ensure!(
            (1..=8192).contains(&cfg.embedding_dim),
            "EMBEDDING_DIM must be 1–8192"
        );
        ensure!(
            cfg.half_life_days.is_finite() && cfg.half_life_days >= 1.0,
            "half life must be at least one day"
        );
        ensure!(
            cfg.legacy_threshold.is_finite() && (0.0..1.0).contains(&cfg.legacy_threshold),
            "legacy threshold must be in [0,1)"
        );
        ensure!(
            !cfg.default_domain.trim().is_empty(),
            "default domain cannot be empty"
        );
        let url = reqwest::Url::parse(&cfg.embedding_url)?;
        ensure!(
            ["http", "https"].contains(&url.scheme()),
            "embedding URL must use HTTP(S)"
        );
        let local = matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
        );
        ensure!(
            local || value("ALLOW_REMOTE_EMBEDDINGS", "false") == "true",
            "embedding endpoint is not local; set ALLOW_REMOTE_EMBEDDINGS=true only if you intend to send note text there"
        );
        Ok(cfg)
    }

    pub fn embedding_identity(&self) -> String {
        serde_json::json!({"provider":self.embedding_provider,"model":self.embedding_model,"dimension":self.embedding_dim,"collection":self.collection}).to_string()
    }
}

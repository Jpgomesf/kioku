//! Configuration from environment variables (optionally loaded from a dotenv file).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result, bail, ensure};
use serde::Serialize;

use crate::access::Principal;
use crate::trace::TraceContent;
use crate::vault::{Provider, Vaults};

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
    /// The model provider that reads the text sent to the embedding service
    /// (`EMBEDDING_READER`): `local` by default for an address on this
    /// machine, `other` for any other. Anything but `local` receives only the
    /// notes that provider may read.
    pub embedding_reader: Provider,
    pub half_life_days: f64,
    pub legacy_threshold: f64,
    pub default_domain: String,
    pub notes_root: Option<PathBuf>,
    /// Repair the index and log aging candidates in the background while
    /// serving MCP. Aging itself is applied only by explicit maintenance.
    pub background_upkeep: bool,
    /// Append every MCP tool call to this JSONL file (opt-in; contains note text).
    pub trace_file: Option<PathBuf>,
    /// Free-form label written into every trace record, such as an eval run id.
    pub trace_run: Option<String>,
    /// Tools the MCP server lists: `core` (default), `all`, or a comma-separated list.
    pub tools: String,
    /// Who a stdio server acts for, from `MEMORY_PRINCIPAL`, `MEMORY_SCOPES`, and
    /// `MEMORY_DOMAINS`. Each MCP client starts its own process, so each client's
    /// config can grant a different profile.
    pub principal: Principal,
    /// How much free text the tool-call trace keeps (`MEMORY_TRACE_CONTENT`).
    pub trace_content: TraceContent,
    /// Salt for `MEMORY_TRACE_CONTENT=hashed`. Set `MEMORY_TRACE_SALT` to compare
    /// hashes across runs; otherwise each process picks its own.
    pub trace_salt: String,
    /// Vault rules from `MEMORY_VAULTS_FILE` (default
    /// `~/.config/kioku/vaults.toml`). `None` when that file doesn't exist:
    /// compatibility mode, with no vault restrictions at all.
    pub vaults: Option<Arc<Vaults>>,
    /// The provider of this client's model (`MEMORY_PROVIDER`). Checked only
    /// in vault mode, per call, so a bad value refuses calls instead of
    /// stopping the server.
    pub provider: Option<String>,
    /// The folder that places a stdio session in a vault
    /// (`KIOKU_SESSION_DIR`); without it, the process working directory.
    pub session_dir: Option<PathBuf>,
}

/// Where the vaults file is looked for when `MEMORY_VAULTS_FILE` is unset.
const DEFAULT_VAULTS_FILE: &str = "~/.config/kioku/vaults.toml";

/// Load the vaults file, which may be absent. A path given explicitly that
/// doesn't exist is logged, since it is probably a typo.
fn load_vaults(explicit: Option<String>, home: Option<&Path>) -> Result<Option<Arc<Vaults>>> {
    let named = explicit.is_some();
    let text = explicit.unwrap_or_else(|| DEFAULT_VAULTS_FILE.to_owned());
    let path = match crate::vault::expand_home(&text, home) {
        Ok(path) => path,
        // No home folder and no explicit file: there is nowhere to look. Say
        // so, since vault rules the user set up would silently be off.
        Err(_) if !named => {
            tracing::warn!(
                "the home folder is unknown (HOME is not set), so {DEFAULT_VAULTS_FILE} can't be read; running without vaults. Set MEMORY_VAULTS_FILE to the vaults file's absolute path if you use vaults"
            );
            return Ok(None);
        }
        Err(error) => return Err(error.context("invalid MEMORY_VAULTS_FILE")),
    };
    ensure!(
        path.is_absolute(),
        "MEMORY_VAULTS_FILE must be an absolute path (or start with ~), because MCP clients start the server from other directories"
    );
    let vaults = Vaults::load(&path, home)?;
    if vaults.is_none() && named {
        tracing::warn!(path = %path.display(), "MEMORY_VAULTS_FILE does not exist; running without vaults");
    }
    Ok(vaults.map(Arc::new))
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

/// `HOME`, or when it is unset or empty, the account's home folder from the
/// system (`account`), so a client that starts the server without `HOME`
/// still gets the default vaults file.
fn home_folder(var: Option<String>, account: impl FnOnce() -> Option<PathBuf>) -> Option<String> {
    var.filter(|home| !home.is_empty()).or_else(|| {
        account()
            .map(|path| path.to_string_lossy().into_owned())
            .filter(|home| !home.is_empty())
    })
}

impl Config {
    pub fn from_env() -> Result<Self> {
        Self::from_env_with(&std::collections::HashMap::new())
    }

    /// The environment with `overrides` on top: how `kioku reindex
    /// --to-env-file` reads the settings it switches to.
    pub fn from_env_with(overrides: &std::collections::HashMap<String, String>) -> Result<Self> {
        Self::from_lookup(|name| match (overrides.get(name), name) {
            (Some(value), _) => Some(value.clone()),
            (None, "HOME") => home_folder(std::env::var("HOME").ok(), std::env::home_dir),
            (None, _) => std::env::var(name).ok(),
        })
    }

    /// Build the configuration from any variable source, so tests never mutate
    /// the process environment.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self> {
        let optional = |name: &str| lookup(name).filter(|v| !v.is_empty());
        let value =
            |name: &str, default: &str| optional(name).unwrap_or_else(|| default.to_owned());
        let home = optional("HOME").map(PathBuf::from);
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
        let embedding_url = value("EMBEDDING_URL", "http://127.0.0.1:11435");
        let embedding_reader = match optional("EMBEDDING_READER") {
            Some(name) => Provider::parse(&name).context("invalid EMBEDDING_READER")?,
            None if reqwest::Url::parse(&embedding_url).is_ok_and(|url| is_loopback(&url)) => {
                Provider::Local
            }
            None => Provider::Other,
        };
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
            embedding_url,
            embedding_model,
            embedding_dim: value("EMBEDDING_DIM", "768")
                .parse()
                .context("EMBEDDING_DIM must be a whole number")?,
            embedding_api_key: optional("EMBEDDING_API_KEY"),
            embedding_prompts: prompts,
            embedding_reader,
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
            principal: Principal::new(
                &value("MEMORY_PRINCIPAL", "local"),
                &value("MEMORY_SCOPES", "read,write,admin"),
                &value("MEMORY_DOMAINS", "*"),
            )
            .context("invalid MEMORY_PRINCIPAL, MEMORY_SCOPES, or MEMORY_DOMAINS")?,
            trace_content: TraceContent::parse(&value("MEMORY_TRACE_CONTENT", "full"))?,
            trace_salt: optional("MEMORY_TRACE_SALT")
                .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string()),
            vaults: load_vaults(optional("MEMORY_VAULTS_FILE"), home.as_deref())?,
            provider: optional("MEMORY_PROVIDER"),
            session_dir: optional("KIOKU_SESSION_DIR")
                .map(|dir| crate::vault::expand_home(&dir, home.as_deref()))
                .transpose()
                .context("invalid KIOKU_SESSION_DIR")?,
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
            cfg.principal.allows_domain(&cfg.default_domain),
            "MEMORY_DEFAULT_DOMAIN {:?} is outside MEMORY_DOMAINS ({}); set it to a domain this profile may use",
            cfg.default_domain,
            cfg.principal.describe_domains()
        );
        ensure!(
            cfg.session_dir.as_ref().is_none_or(|dir| dir.is_absolute()),
            "KIOKU_SESSION_DIR must be an absolute path (or start with ~)"
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
    fn the_embedding_reader_defaults_by_where_the_service_runs() {
        assert_eq!(config(&[]).unwrap().embedding_reader, Provider::Local);
        let remote = [
            ("EMBEDDING_URL", "https://openrouter.ai/api/v1"),
            ("ALLOW_REMOTE_EMBEDDINGS", "true"),
            ("EMBEDDING_PROVIDER", "openai"),
        ];
        assert_eq!(config(&remote).unwrap().embedding_reader, Provider::Other);
        let named = [remote.as_slice(), &[("EMBEDDING_READER", "OpenAI")]].concat();
        assert_eq!(config(&named).unwrap().embedding_reader, Provider::OpenAi);
        // A proxy on this machine can forward to a hosted model.
        let proxy = config(&[("EMBEDDING_READER", "openai")]).unwrap();
        assert_eq!(proxy.embedding_reader, Provider::OpenAi);
        let error = config(&[("EMBEDDING_READER", "openrouter")]).err().unwrap();
        assert!(format!("{error:#}").contains("EMBEDDING_READER"));
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
    fn vaults_load_only_when_the_file_exists() {
        // No HOME and no MEMORY_VAULTS_FILE: compatibility mode.
        assert!(config(&[]).unwrap().vaults.is_none());
        let dir = std::env::temp_dir().join(format!("kioku-config-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let home = dir.to_string_lossy().into_owned();
        assert!(
            config(&[("HOME", &home)]).unwrap().vaults.is_none(),
            "no file at the default path"
        );
        let file = dir.join(".config/kioku/vaults.toml");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(
            &file,
            "[[vault]]\nname = \"p\"\npaths = [\"~\"]\ndomains = [\"local\"]\nproviders = [\"local\"]\ndefault_domain = \"local\"\n",
        )
        .unwrap();
        let cfg = config(&[("HOME", &home), ("MEMORY_PROVIDER", "local")]).unwrap();
        assert!(cfg.vaults.is_some());
        assert_eq!(cfg.provider.as_deref(), Some("local"));
        let named = file.to_string_lossy().into_owned();
        assert!(
            config(&[("MEMORY_VAULTS_FILE", &named), ("HOME", &home)])
                .unwrap()
                .vaults
                .is_some()
        );
        assert!(
            config(&[("MEMORY_VAULTS_FILE", &named)]).is_err(),
            "~ in the file needs HOME"
        );
        assert!(config(&[("MEMORY_VAULTS_FILE", "vaults.toml")]).is_err());
        let missing = dir.join("missing.toml").to_string_lossy().into_owned();
        assert!(
            config(&[("MEMORY_VAULTS_FILE", &missing)])
                .unwrap()
                .vaults
                .is_none()
        );
        std::fs::write(&file, "[[vault]]\nname = \"p\"\n").unwrap();
        assert!(
            config(&[("HOME", &home)]).is_err(),
            "a broken file stops startup"
        );
        let session = config(&[
            ("HOME", &home),
            ("MEMORY_VAULTS_FILE", &missing),
            ("KIOKU_SESSION_DIR", "~/p"),
        ])
        .unwrap()
        .session_dir;
        assert_eq!(session, Some(dir.join("p")));
        assert!(config(&[("KIOKU_SESSION_DIR", "relative")]).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_missing_home_falls_back_to_the_account_folder() {
        let account = || Some(PathBuf::from("/Users/me"));
        assert_eq!(
            home_folder(Some("/home/x".into()), account).as_deref(),
            Some("/home/x")
        );
        assert_eq!(home_folder(None, account).as_deref(), Some("/Users/me"));
        assert_eq!(
            home_folder(Some(String::new()), account).as_deref(),
            Some("/Users/me")
        );
        assert_eq!(home_folder(None, || None), None);
        assert_eq!(home_folder(None, || Some(PathBuf::new())), None);
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

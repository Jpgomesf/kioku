//! Health: `get_stats`, `get_service_status`.

use serde::{Deserialize, Serialize};

use std::collections::BTreeMap;
use std::time::Duration;

use kioku::config::EmbeddingProvider;
use kioku::embedding::Embedder;
use kioku::model::Status;
use kioku::vault::Provider;
use kioku::vector::Qdrant;
use tauri::State;
use tokio::time::{error::Elapsed, timeout};

use crate::data::counts::{self, Tally};
use crate::data::{env, vaults_file};
use crate::error::CommandResult;
use crate::state::{AppState, PROBE_TTL};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainStats {
    pub domain: String,
    pub active: u32,
    pub legacy: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub domains: Vec<DomainStats>,
    pub links: u32,
    pub pending_vectors: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ServiceState {
    Running,
    Degraded,
    Down,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceHealth {
    pub state: ServiceState,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    pub postgres: ServiceHealth,
    pub qdrant: ServiceHealth,
    pub ollama: ServiceHealth,
    pub embedding_model: String,
    /// Which API the embeddings go through.
    pub embedding_provider: EmbeddingApi,
    /// Whether note text stays on this machine when it is embedded.
    pub embedding_local: bool,
    /// Who reads the text when it isn't local, in plain words.
    pub embedding_reader: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EmbeddingApi {
    Ollama,
    Openai,
}

/// Where embeddings go, from the config.
pub(crate) fn embedding_target(config: &kioku::config::Config) -> (EmbeddingApi, bool, String) {
    let api = match config.embedding_provider {
        EmbeddingProvider::Ollama => EmbeddingApi::Ollama,
        EmbeddingProvider::OpenAi => EmbeddingApi::Openai,
    };
    let local = config.embedding_reader == Provider::Local;
    let reader = match config.embedding_reader {
        Provider::Local => "this Mac".to_owned(),
        Provider::Other => "a hosted service".to_owned(),
        other => vaults_file::provider_label(other).to_owned(),
    };
    (api, local, reader)
}

/// How long each service check may take.
const CHECK_TIMEOUT: Duration = Duration::from_secs(3);
/// The embedding check runs a model, which can take longer on first use.
const EMBED_TIMEOUT: Duration = Duration::from_secs(8);

/// Active and legacy counts per domain, largest first.
pub(crate) fn domain_stats(rows: &[Tally]) -> Vec<DomainStats> {
    let mut by_domain: BTreeMap<&str, (u32, u32)> = BTreeMap::new();
    for row in rows {
        let entry = by_domain.entry(row.domain.as_str()).or_default();
        match row.status {
            Status::Active => entry.0 += row.count,
            Status::Legacy => entry.1 += row.count,
        }
    }
    let mut out: Vec<DomainStats> = by_domain
        .into_iter()
        .map(|(domain, (active, legacy))| DomainStats {
            domain: domain.to_owned(),
            active,
            legacy,
        })
        .collect();
    out.sort_by_key(|a| std::cmp::Reverse(a.active + a.legacy));
    out
}

fn count(stats: &serde_json::Value, field: &str) -> u32 {
    stats[field]
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(0)
}

#[tauri::command]
pub async fn get_stats(state: State<'_, AppState>) -> CommandResult<Stats> {
    let services = state.read_only().await?;
    let rows = counts::tallies(&services.pool).await?;
    let totals = services.store.stats().await?;
    Ok(Stats {
        domains: domain_stats(&rows),
        links: count(&totals, "edges"),
        pending_vectors: count(&totals, "pending_vectors"),
    })
}

/// A check's outcome in plain words. Error text is left out on purpose: it
/// can carry addresses and, for some drivers, credentials.
pub(crate) fn health<T, E>(outcome: Result<Result<T, E>, Elapsed>, ok: &str) -> ServiceHealth {
    match outcome {
        Ok(Ok(_)) => ServiceHealth {
            state: ServiceState::Running,
            detail: ok.to_owned(),
        },
        Ok(Err(_)) => ServiceHealth {
            state: ServiceState::Down,
            detail: "Not reachable".to_owned(),
        },
        Err(_) => ServiceHealth {
            state: ServiceState::Down,
            detail: "Timed out".to_owned(),
        },
    }
}

fn not_configured() -> ServiceHealth {
    ServiceHealth {
        state: ServiceState::Down,
        detail: "Not configured".to_owned(),
    }
}

/// The embedding check, reused for [`PROBE_TTL`]: each probe runs the model
/// (keeping it loaded) or, with a hosted service, sends it a request.
async fn embedding_health(state: &AppState, config: &kioku::config::Config) -> ServiceHealth {
    if let Some(known) = state.embed_probe.fresh(PROBE_TTL) {
        return known;
    }
    let health = match Embedder::new(config) {
        Ok(embedder) => health(
            timeout(EMBED_TIMEOUT, embedder.embed_query("kioku health check")).await,
            "Ready",
        ),
        Err(_) => return not_configured(),
    };
    remember_probe(state, &health);
    health
}

/// Keeps only a healthy probe, so a service that was down or still loading
/// shows as up on the next poll once it is, not after [`PROBE_TTL`].
fn remember_probe(state: &AppState, health: &ServiceHealth) {
    if health.state == ServiceState::Running {
        state.embed_probe.store(health.clone());
    }
}

#[tauri::command]
pub async fn get_service_status(state: State<'_, AppState>) -> CommandResult<ServiceStatus> {
    service_status(&state).await
}

async fn service_status(state: &AppState) -> CommandResult<ServiceStatus> {
    let Ok(config) = env::load_config() else {
        return Ok(ServiceStatus {
            postgres: not_configured(),
            qdrant: not_configured(),
            ollama: not_configured(),
            embedding_model: String::new(),
            embedding_provider: EmbeddingApi::Ollama,
            embedding_local: true,
            embedding_reader: "this Mac".to_owned(),
        });
    };
    let postgres = async {
        // Reuses the shared handle instead of opening a pool every poll.
        let outcome = timeout(CHECK_TIMEOUT, async {
            let services = state.read_only().await?;
            services
                .store
                .domain_counts()
                .await
                .map_err(crate::error::CommandError::from)
        })
        .await;
        health(outcome, "Connected")
    };
    let qdrant = async {
        match Qdrant::new(
            &config.qdrant_url,
            &config.collection,
            config.qdrant_api_key.clone(),
            config.embedding_dim,
        ) {
            Ok(vector) => health(timeout(CHECK_TIMEOUT, vector.health()).await, "Ready"),
            Err(_) => not_configured(),
        }
    };
    let embedding = embedding_health(state, &config);
    let (postgres, qdrant, ollama) = tokio::join!(postgres, qdrant, embedding);
    let (embedding_provider, embedding_local, embedding_reader) = embedding_target(&config);
    Ok(ServiceStatus {
        postgres,
        qdrant,
        ollama,
        embedding_model: config.embedding_model.clone(),
        embedding_provider,
        embedding_local,
        embedding_reader,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::notes::tests::note;

    #[test]
    fn stats_count_per_domain() -> Result<(), serde_json::Error> {
        let mut old = note("demo", "b", &[], None);
        old.status = Status::Legacy;
        let notes = vec![
            note("local", "x", &[], None),
            note("demo", "a", &[], None),
            old,
        ];
        let stats = domain_stats(&counts::from_notes(&notes));
        assert_eq!(stats[0].domain, "demo");
        assert_eq!((stats[0].active, stats[0].legacy), (1, 1));
        let json = serde_json::to_value(Stats {
            domains: stats,
            links: 2,
            pending_vectors: 0,
        })?;
        assert_eq!(json["pendingVectors"], 0);
        assert_eq!(count(&serde_json::json!({"edges": 7}), "edges"), 7);
        Ok(())
    }

    #[tokio::test]
    async fn timeouts_and_errors_map_to_down() -> Result<(), serde_json::Error> {
        let ok: Result<Result<(), ()>, Elapsed> = Ok(Ok(()));
        assert_eq!(health(ok, "Ready").state, ServiceState::Running);
        let failed: Result<Result<(), &str>, Elapsed> = Ok(Err("secret://x"));
        let down = health(failed, "Ready");
        assert_eq!(down.state, ServiceState::Down);
        assert!(!down.detail.contains("secret"));
        let slow = timeout(
            Duration::from_millis(1),
            std::future::pending::<Result<(), ()>>(),
        )
        .await;
        assert_eq!(health(slow, "Ready").detail, "Timed out");
        assert_eq!(serde_json::to_string(&ServiceState::Down)?, r#""down""#);
        assert_eq!(serde_json::to_string(&EmbeddingApi::Openai)?, r#""openai""#);
        Ok(())
    }

    #[test]
    fn only_healthy_probes_are_remembered() {
        let state = AppState::default();
        remember_probe(&state, &not_configured());
        assert!(state.embed_probe.fresh(PROBE_TTL).is_none());
        let ready = ServiceHealth {
            state: ServiceState::Running,
            detail: "Ready".to_owned(),
        };
        remember_probe(&state, &ready);
        assert_eq!(
            state.embed_probe.fresh(PROBE_TTL).map(|h| h.state),
            Some(ServiceState::Running)
        );
    }

    #[tokio::test]
    #[ignore = "needs the live Kioku services"]
    async fn live_service_status() -> CommandResult<()> {
        let status = service_status(&AppState::default()).await?;
        assert_eq!(status.postgres.state, ServiceState::Running);
        Ok(())
    }
}

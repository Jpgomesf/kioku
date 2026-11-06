//! Shared, lazily opened, read-only access to Kioku.
//!
//! This deliberately avoids `kioku::app::App::connect`: that runs migrations,
//! takes the mutation lock and writes embedding and collection metadata. The
//! viewer only ever reads, so it opens the store directly and nothing else.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use kioku::config::Config;
use kioku::embedding::Embedder;
use kioku::store::Store;
use kioku::vector::Qdrant;
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use tokio::sync::OnceCell;
use tokio::time::timeout;

use crate::commands::health::ServiceHealth;
use crate::data::env;
use crate::error::{CommandError, CommandResult};

/// How long opening the database may take before commands report it down.
const OPEN_TIMEOUT: Duration = Duration::from_secs(3);
/// How long a failed open is remembered, so queued commands fail at once.
const FAILURE_TTL: Duration = Duration::from_secs(5);
/// How long an embedding probe's result is reused.
pub const PROBE_TTL: Duration = Duration::from_secs(300);

/// Read-only handles to Kioku's services.
pub struct ReadOnly {
    pub config: Config,
    pub store: Store,
    /// A small pool for the viewer's own SELECT-only queries. Every
    /// transaction on it is read-only at the server.
    pub pool: PgPool,
    pub vector: Qdrant,
    pub embedder: Embedder,
}

/// The database URL with every session set to read-only transactions.
pub(crate) fn read_only_url(url: &str) -> String {
    let joiner = if url.contains('?') { '&' } else { '?' };
    format!("{url}{joiner}options=-c%20default_transaction_read_only%3Don")
}

fn unreachable() -> CommandError {
    CommandError::unavailable("PostgreSQL is not reachable.")
}

impl ReadOnly {
    async fn open() -> CommandResult<Self> {
        let config = env::load_config()?;
        let options: PgConnectOptions = config
            .database_url
            .parse()
            .map_err(|_| CommandError::unavailable("The database address is not valid."))?;
        let options = options.options([("default_transaction_read_only", "on")]);
        let connect = async {
            // The store's own pool gets a read-only session too, so a write method
            // called by mistake fails at the server instead of writing.
            let store = Store::connect(&read_only_url(&config.database_url)).await?;
            let pool = PgPoolOptions::new()
                .max_connections(2)
                .acquire_timeout(OPEN_TIMEOUT)
                .connect_with(options)
                .await?;
            anyhow::Ok((store, pool))
        };
        let (store, pool) = match timeout(OPEN_TIMEOUT, connect).await {
            Ok(Ok(handles)) => handles,
            Ok(Err(_)) | Err(_) => return Err(unreachable()),
        };
        let vector = Qdrant::new(
            &config.qdrant_url,
            &config.collection,
            config.qdrant_api_key.clone(),
            config.embedding_dim,
        )?;
        let embedder = Embedder::new(&config)?;
        Ok(Self {
            config,
            store,
            pool,
            vector,
            embedder,
        })
    }
}

/// A value remembered until it is older than a time to live.
pub struct Remembered<T> {
    slot: Mutex<Option<(Instant, T)>>,
}

impl<T> Default for Remembered<T> {
    fn default() -> Self {
        Self {
            slot: Mutex::new(None),
        }
    }
}

impl<T: Clone> Remembered<T> {
    /// The value, if one was stored less than `ttl` ago.
    pub fn fresh(&self, ttl: Duration) -> Option<T> {
        let slot = self.slot.lock().ok()?;
        slot.as_ref()
            .filter(|(at, _)| at.elapsed() < ttl)
            .map(|(_, value)| value.clone())
    }

    pub fn store(&self, value: T) {
        if let Ok(mut slot) = self.slot.lock() {
            *slot = Some((Instant::now(), value));
        }
    }
}

/// Managed by Tauri once; commands take `tauri::State<'_, AppState>`.
#[derive(Default)]
pub struct AppState {
    read_only: OnceCell<ReadOnly>,
    last_failure: Remembered<CommandError>,
    /// The last embedding check, reused so status polling doesn't keep the
    /// model loaded or send a request to a hosted service every poll.
    pub embed_probe: Remembered<ServiceHealth>,
}

impl AppState {
    /// The read-only handle, connecting on first use. A failed connection is
    /// remembered for a few seconds, then the next command tries again.
    pub async fn read_only(&self) -> CommandResult<&ReadOnly> {
        if let Some(ready) = self.read_only.get() {
            return Ok(ready);
        }
        self.read_only
            .get_or_try_init(|| async {
                if let Some(err) = self.last_failure.fresh(FAILURE_TTL) {
                    return Err(err);
                }
                let opened = ReadOnly::open().await;
                if let Err(err) = &opened {
                    self.last_failure.store(err.clone());
                }
                opened
            })
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remembered_values_expire() {
        let memo: Remembered<u32> = Remembered::default();
        assert_eq!(memo.fresh(Duration::from_secs(60)), None);
        memo.store(7);
        assert_eq!(memo.fresh(Duration::from_secs(60)), Some(7));
        assert_eq!(memo.fresh(Duration::ZERO), None);
    }

    #[test]
    fn the_store_url_asks_for_read_only_sessions() -> Result<(), sqlx::Error> {
        for url in [
            "postgres://u@localhost/kioku",
            "postgres://u@localhost/kioku?sslmode=disable",
        ] {
            let options: PgConnectOptions = read_only_url(url).parse()?;
            assert_eq!(
                options.get_options(),
                Some("-c default_transaction_read_only=on")
            );
        }
        Ok(())
    }

    #[tokio::test]
    #[ignore = "needs the live Kioku services"]
    async fn live_sessions_are_read_only() -> CommandResult<()> {
        let config = env::load_config()?;
        let store_pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&read_only_url(&config.database_url))
            .await
            .map_err(|_| unreachable())?;
        let services = AppState::default();
        let services = services.read_only().await?;
        for pool in [&store_pool, &services.pool] {
            let (value,): (String,) = sqlx::query_as("SHOW default_transaction_read_only")
                .fetch_one(pool)
                .await
                .map_err(|_| unreachable())?;
            assert_eq!(value, "on");
        }
        Ok(())
    }
}

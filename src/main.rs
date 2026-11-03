use anyhow::{Result, ensure};
use clap::{Parser, Subcommand};
use local_memory_mcp::{app::App, config::Config, mcp::MemoryServer};
use rmcp::ServiceExt;
use serde_json::{Value, json};
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Parser)]
#[command(version, about)]
struct Cli {
    #[arg(long, global = true)]
    env_file: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    /// Run the MCP server over stdin/stdout (logs go to stderr).
    Serve,
    /// Import focused Markdown notes with YAML frontmatter. Repeated input is idempotent.
    Ingest {
        #[arg(long)]
        path: PathBuf,
        #[arg(long, default_value = "local")]
        domain: String,
    },
    Search {
        query: String,
        #[arg(long)]
        domain: Option<String>,
        #[arg(long, default_value_t = 5)]
        limit: usize,
        #[arg(long)]
        include_legacy: bool,
    },
    Context {
        query: String,
        #[arg(long)]
        domain: Option<String>,
        #[arg(long, default_value_t = 1500)]
        token_budget: usize,
        #[arg(long)]
        include_legacy: bool,
    },
    Graph {
        id: Uuid,
        #[arg(long)]
        domain: Option<String>,
        #[arg(long)]
        include_legacy: bool,
    },
    Maintenance {
        #[arg(long)]
        dry_run: bool,
    },
    Doctor,
    Stats,
    Feedback {
        id: Uuid,
        #[arg(long, conflicts_with = "negative")]
        positive: bool,
        #[arg(long, conflicts_with = "positive")]
        negative: bool,
        #[arg(long)]
        request_id: String,
        #[arg(long)]
        domain: Option<String>,
    },
    Retire {
        id: Uuid,
        #[arg(long)]
        domain: Option<String>,
    },
    Restore {
        id: Uuid,
        #[arg(long)]
        domain: Option<String>,
    },
    /// Repair interrupted indexing; --all also rebuilds vectors after restoring Qdrant from backup.
    Repair {
        #[arg(long)]
        all: bool,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    if let Some(file) = cli.env_file {
        dotenvy::from_path(file)?;
    } else {
        let _ = dotenvy::dotenv();
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into()),
        )
        .with_writer(std::io::stderr)
        .init();
    let app = App::connect(Config::from_env()?).await?;
    let output: Value = match cli.command {
        Command::Serve => {
            MemoryServer::new(app)
                .serve(rmcp::transport::stdio())
                .await?
                .waiting()
                .await?;
            return Ok(());
        }
        Command::Ingest { path, domain } => app.ingest(&path, &domain).await?,
        Command::Search {
            query,
            domain,
            limit,
            include_legacy,
        } => {
            json!({"results":app.search(&query,domain.as_deref(),limit,include_legacy,"rerank").await?})
        }
        Command::Context {
            query,
            domain,
            token_budget,
            include_legacy,
        } => {
            app.context(
                Some(&query),
                None,
                domain.as_deref(),
                token_budget,
                include_legacy,
            )
            .await?
        }
        Command::Graph {
            id,
            domain,
            include_legacy,
        } => {
            app.graph_context(id, domain.as_deref(), include_legacy)
                .await?
        }
        Command::Maintenance { dry_run } => app.maintenance(dry_run).await?,
        Command::Doctor => app.doctor().await?,
        Command::Stats => app.store.stats().await?,
        Command::Feedback {
            id,
            positive,
            negative,
            request_id,
            domain,
        } => {
            ensure!(positive || negative, "choose --positive or --negative");
            app.feedback(id, positive, &request_id, domain.as_deref())
                .await?
        }
        Command::Retire { id, domain } => app.set_legacy(id, true, domain.as_deref()).await?,
        Command::Restore { id, domain } => app.set_legacy(id, false, domain.as_deref()).await?,
        Command::Repair { all } => app.repair(all).await?,
    };
    println!("{}", serde_json::to_string_pretty(&output)?);
    Ok(())
}

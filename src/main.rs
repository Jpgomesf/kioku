use std::path::PathBuf;

use anyhow::{Context, Result, ensure};
use clap::{Args, Parser, Subcommand, ValueEnum};
use kioku::app::{App, ContextRequest, SearchRequest};
use kioku::config::Config;
use kioku::eval::{self, EvalOptions};
use kioku::mcp::MemoryServer;
use kioku::rank::RankOptions;
use rmcp::ServiceExt;
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Parser)]
#[command(version, about)]
struct Cli {
    /// Read configuration from this dotenv file. Its values take precedence over
    /// inherited environment variables, so another project's DATABASE_URL cannot
    /// redirect Kioku. Without it, `serve` uses only the environment and other
    /// commands also read ./.env.
    #[arg(long, global = true, env = "KIOKU_ENV_FILE")]
    env_file: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the MCP server over stdin/stdout (logs go to stderr).
    Serve {
        /// Tools to expose: core (search, get, save), all, or a comma-separated
        /// list such as core,memory_import. Overrides MEMORY_TOOLS.
        #[arg(long)]
        tools: Option<String>,
        /// Serve MCP over HTTP at this loopback address (for example
        /// 127.0.0.1:7373) instead of stdio. Needs a build with `--features http`.
        #[arg(long, value_name = "ADDR")]
        http: Option<std::net::SocketAddr>,
        /// Access file listing who may connect over HTTP (see `kioku token`).
        #[arg(long, env = "MEMORY_ACCESS_FILE", requires = "http")]
        access_file: Option<PathBuf>,
        /// Browser origin allowed to call the HTTP server, such as
        /// http://localhost:5173. Repeat for several; by default none is.
        #[arg(long = "allowed-origin", requires = "http")]
        allowed_origins: Vec<String>,
    },
    /// Create a bearer token for the HTTP transport and print the access-file
    /// entry for it. Only the hash goes in the file; store the token in the
    /// client's configuration.
    Token {
        /// Name for this client, shown in traces and errors.
        subject: String,
        /// Comma-separated scopes: read, write, admin.
        #[arg(long, default_value = "read,write")]
        scopes: String,
        /// Comma-separated domain globs, or `re:<regex>`.
        #[arg(long, default_value = "*")]
        domains: String,
    },
    /// Print the tool list a client sees, as JSON (no services needed beyond startup).
    Tools {
        #[arg(long)]
        tools: Option<String>,
    },
    /// Protect a memory from aging into legacy status.
    Pin {
        /// Memory key (or id).
        key: String,
        #[arg(long)]
        domain: Option<String>,
    },
    /// Let a pinned memory age normally again.
    Unpin {
        key: String,
        #[arg(long)]
        domain: Option<String>,
    },
    /// Import focused Markdown notes with YAML frontmatter. Repeated input is idempotent.
    Ingest {
        #[arg(long)]
        path: PathBuf,
        /// Domain for notes without one in their frontmatter; defaults to MEMORY_DEFAULT_DOMAIN.
        #[arg(long)]
        domain: Option<String>,
    },
    /// Rank memories for a query.
    Search {
        query: String,
        #[arg(long)]
        domain: Option<String>,
        #[arg(long, default_value_t = 5)]
        limit: usize,
        #[arg(long)]
        include_legacy: bool,
        /// Skip graph expansion through explicit links.
        #[arg(long)]
        no_graph: bool,
        /// Also print candidate counts and time per stage. Each result always
        /// carries its match kind, the note that linked to it, and its signals.
        #[arg(long)]
        explain: bool,
    },
    /// Build a bounded evidence pack for a query, like the rag_context tool.
    Context {
        query: String,
        #[arg(long)]
        domain: Option<String>,
        #[arg(long, default_value_t = 1500)]
        token_budget: usize,
        #[arg(long)]
        include_legacy: bool,
    },
    /// Show a memory's explicit relationships.
    Graph {
        id: Uuid,
        #[arg(long)]
        domain: Option<String>,
        #[arg(long)]
        include_legacy: bool,
    },
    /// Preview or apply monthly aging.
    Maintenance {
        #[arg(long)]
        dry_run: bool,
    },
    /// Check PostgreSQL, Qdrant, and the embedding service.
    Doctor,
    /// Count memories, links, and pending vector updates.
    Stats,
    /// Record one feedback event; reusing --request-id makes retries idempotent.
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
    /// Move a memory to legacy status. Nothing is deleted.
    Retire {
        id: Uuid,
        #[arg(long)]
        domain: Option<String>,
    },
    /// Return a legacy memory to active retrieval.
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
    /// Measure retrieval quality on a graded dataset (see evals/README.md).
    Eval(EvalArgs),
    /// Switch embedding models: re-embed every memory into a new collection,
    /// then point the database at it. Close MCP clients first.
    Reindex {
        /// Embedding model to switch to, for example qwen3-embedding:0.6b.
        #[arg(long)]
        embedding_model: String,
        /// Its vector size, for example 1024.
        #[arg(long)]
        embedding_dim: usize,
        /// New, empty Qdrant collection for the new vectors.
        #[arg(long)]
        collection: String,
    },
}

#[derive(Args)]
struct EvalArgs {
    /// Dataset manifest.
    #[arg(long, default_value = "evals/retrieval/dataset.json")]
    dataset: PathBuf,
    /// Results scored per query.
    #[arg(long, default_value_t = 5)]
    k: usize,
    /// Context pack budget in UTF-8 bytes.
    #[arg(long, default_value_t = 1500)]
    context_budget: usize,
    /// Isolated database for datasets with a corpus. It is dropped and
    /// recreated on every run. Defaults to <database>_eval_<model>.
    #[arg(long)]
    database: Option<String>,
    /// Isolated Qdrant collection, recreated on every run. Defaults to <collection>_eval_<model>.
    #[arg(long)]
    collection: Option<String>,
    #[arg(long, value_enum, default_value_t = Format::Markdown)]
    format: Format,
    /// Also write the full JSON report, including per-query rankings, here.
    #[arg(long)]
    output: Option<PathBuf>,
    /// Exit with an error if nDCG@k of the default ranking is below this value.
    #[arg(long)]
    min_ndcg: Option<f64>,
    /// Exit with an error if recall@k of the default ranking is below this value.
    #[arg(long)]
    min_recall: Option<f64>,
    /// Exit with an error if one note appears in unrelated results more than
    /// this many times as often as a uniform pick would (for example 3).
    #[arg(long)]
    max_hub_exposure: Option<f64>,
    /// Exit with an error if any query returns a forbidden (superseded) note.
    #[arg(long)]
    no_leaks: bool,
    /// Evaluate another embedding model (for example qwen3-embedding:0.6b) without editing the env file.
    #[arg(long, requires = "embedding_dim")]
    embedding_model: Option<String>,
    /// Vector size of --embedding-model.
    #[arg(long, requires = "embedding_model")]
    embedding_dim: Option<usize>,
}

#[derive(Clone, Copy, ValueEnum)]
enum Format {
    Markdown,
    Json,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    if let Some(file) = &cli.env_file {
        dotenvy::from_path_override(file)
            .with_context(|| format!("cannot read env file {}", file.display()))?;
    } else if !matches!(cli.command, Command::Serve { .. })
        && std::path::Path::new(".env").is_file()
    {
        // Only the current directory: an MCP client starts `serve` inside other
        // projects, whose own .env files must never configure Kioku.
        dotenvy::from_path_override(".env").context("cannot read ./.env")?;
    }
    init_logging()?;
    if let Command::Token {
        subject,
        scopes,
        domains,
    } = &cli.command
    {
        let principal = kioku::access::Principal::new(subject, scopes, domains)?;
        let token = kioku::access::new_token();
        return emit(&serde_json::to_string_pretty(&json!({
            "token": token,
            "access_file_entry": kioku::access::access_entry(&principal, &token),
            "note": "Shown once. Add the entry to the access file and give the token to the client as `Authorization: Bearer <token>`.",
        }))?);
    }
    let config = Config::from_env()?;
    if let Command::Eval(args) = &cli.command {
        return run_eval(config, args).await;
    }
    let app = App::connect(config).await?;
    let output: Value = match cli.command {
        Command::Serve {
            tools,
            http,
            access_file,
            allowed_origins,
        } => {
            let upkeep = app.config.background_upkeep.then(|| {
                let app = app.clone();
                tokio::spawn(async move {
                    // Let the client finish its handshake first, then run daily.
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    let mut daily = tokio::time::interval(std::time::Duration::from_secs(86_400));
                    loop {
                        daily.tick().await;
                        app.upkeep().await;
                    }
                })
            });
            let served = match http {
                Some(addr) => serve_http(app, addr, access_file, tools, allowed_origins).await,
                None => {
                    async {
                        MemoryServer::new(app, tools.as_deref())?
                            .serve(rmcp::transport::stdio())
                            .await?
                            .waiting()
                            .await?;
                        anyhow::Ok(())
                    }
                    .await
                }
            };
            if let Some(task) = upkeep {
                task.abort();
            }
            return served;
        }
        Command::Ingest { path, domain } => {
            let domain = domain.unwrap_or_else(|| app.config.default_domain.clone());
            serde_json::to_value(app.ingest(&path, &domain).await?)?
        }
        Command::Search {
            query,
            domain,
            limit,
            include_legacy,
            no_graph,
            explain,
        } => {
            let results = app
                .search(&SearchRequest {
                    query: &query,
                    domain: domain.as_deref(),
                    limit,
                    include_legacy,
                    ranking: if no_graph {
                        RankOptions::HYBRID
                    } else {
                        RankOptions::HYBRID_GRAPH
                    },
                    edges: None,
                })
                .await?;
            if explain {
                json!({"results": results.hits, "warnings": results.warnings, "stats": results.stats})
            } else {
                json!({"results": results.hits, "warnings": results.warnings})
            }
        }
        Command::Context {
            query,
            domain,
            token_budget,
            include_legacy,
        } => serde_json::to_value(
            app.context(&ContextRequest {
                query: Some(&query),
                ids: None,
                domain: domain.as_deref(),
                budget: token_budget,
                include_legacy,
                ranking: RankOptions::HYBRID_GRAPH,
                record_access: true,
            })
            .await?,
        )?,
        Command::Graph {
            id,
            domain,
            include_legacy,
        } => {
            app.graph_context(id, domain.as_deref(), include_legacy)
                .await?
        }
        Command::Tools { tools } => {
            let server = MemoryServer::new(app, tools.as_deref())?;
            json!({"tools": server.tool_names()})
        }
        Command::Pin { key, domain } => {
            let domain = domain.unwrap_or_else(|| app.config.default_domain.clone());
            app.set_pinned(resolve_key(&app, &domain, &key).await?, true, Some(&domain))
                .await?
        }
        Command::Unpin { key, domain } => {
            let domain = domain.unwrap_or_else(|| app.config.default_domain.clone());
            app.set_pinned(
                resolve_key(&app, &domain, &key).await?,
                false,
                Some(&domain),
            )
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
        Command::Repair { all } => serde_json::to_value(app.repair(all).await?)?,
        Command::Reindex {
            embedding_model,
            embedding_dim,
            collection,
        } => {
            let mut target = app.config.clone();
            target.embedding_prompts = kioku::config::EmbeddingPrompts::for_model(&embedding_model);
            target.embedding_model = embedding_model;
            target.embedding_dim = embedding_dim;
            target.collection = collection;
            let report = app.reindex(&target).await?;
            json!({
                "report": report,
                "next": format!(
                    "Set EMBEDDING_MODEL={}, EMBEDDING_DIM={}, and QDRANT_COLLECTION={} in your env file, then restart MCP clients. The previous collection {} is kept until you delete it.",
                    report.embedding_model, report.embedding_dim, report.collection, report.previous_collection
                ),
            })
        }
        Command::Eval(_) | Command::Token { .. } => unreachable!("handled before connecting"),
    };
    emit(&serde_json::to_string_pretty(&output)?)
}

/// A memory id from a key in `domain`, or the id itself.
async fn resolve_key(app: &App, domain: &str, key: &str) -> Result<Uuid> {
    if let Ok(id) = Uuid::parse_str(key) {
        return Ok(id);
    }
    let id = kioku::model::NoteInput::id_for(domain, key);
    app.store
        .get(id)
        .await?
        .with_context(|| format!("no memory {key:?} in domain {domain:?}"))?;
    Ok(id)
}

/// Write command output to stdout. `serve` never calls this: its stdout carries
/// only MCP messages, and the `print_stdout` lint keeps it that way elsewhere.
fn emit(text: &str) -> Result<()> {
    use std::io::Write;
    let mut stdout = std::io::stdout().lock();
    writeln!(stdout, "{}", text.trim_end_matches('\n'))?;
    stdout.flush()?;
    Ok(())
}

async fn run_eval(mut config: Config, args: &EvalArgs) -> Result<()> {
    let dataset = eval::Dataset::load(&args.dataset)?;
    if let (Some(model), Some(dim)) = (&args.embedding_model, args.embedding_dim) {
        ensure!(
            dataset.corpus.is_some(),
            "--embedding-model needs a dataset with a corpus: existing memories were indexed with {}",
            config.embedding_model
        );
        config.embedding_model = model.clone();
        config.embedding_dim = dim;
        config.embedding_prompts = kioku::config::EmbeddingPrompts::for_model(model);
    }
    if dataset.corpus.is_some() {
        let database = match &args.database {
            Some(database) => database.clone(),
            None => eval::isolated_name(&config.database_name()?, &config.embedding_model, 63),
        };
        let collection = args.collection.clone().unwrap_or_else(|| {
            eval::isolated_name(&config.collection, &config.embedding_model, 128)
        });
        eval::isolate_storage(&mut config, &database, &collection).await?;
        eprintln!("evaluating in isolated database {database} and collection {collection}");
    } else {
        eprintln!(
            "dataset has no corpus: evaluating domain {} read-only",
            dataset.domain
        );
    }
    let app = App::connect(config).await?;
    eval::prepare(&app, &dataset).await?;
    let report = eval::run(
        &app,
        &dataset,
        &EvalOptions {
            k: args.k,
            context_budget: args.context_budget,
        },
    )
    .await?;
    match args.format {
        Format::Markdown => emit(&eval::render_markdown(&report))?,
        Format::Json => emit(&serde_json::to_string_pretty(&report)?)?,
    }
    if let Some(path) = &args.output {
        std::fs::write(path, serde_json::to_vec_pretty(&report)?)?;
    }
    eval::check_thresholds(
        &report,
        eval::Gates {
            min_ndcg: args.min_ndcg,
            min_recall: args.min_recall,
            max_hub_exposure: args.max_hub_exposure,
            no_leaks: args.no_leaks,
        },
    )
}

/// Logs go to stderr (stdout carries the protocol). `RUST_LOG` filters them;
/// at `kioku=info` every tool call and search logs a span with its duration.
/// `MEMORY_LOG_FORMAT=json` emits one JSON object per line.
fn init_logging() -> Result<()> {
    use tracing_subscriber::fmt::format::FmtSpan;
    let filter =
        tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into());
    let builder = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_span_events(FmtSpan::CLOSE)
        .with_writer(std::io::stderr);
    match std::env::var("MEMORY_LOG_FORMAT").as_deref() {
        Ok("json") => builder.json().init(),
        Ok("text") | Err(_) => builder.init(),
        Ok(other) => anyhow::bail!("MEMORY_LOG_FORMAT must be text or json, got {other:?}"),
    }
    Ok(())
}

#[cfg(feature = "http")]
async fn serve_http(
    app: App,
    addr: std::net::SocketAddr,
    access_file: Option<PathBuf>,
    tools: Option<String>,
    allowed_origins: Vec<String>,
) -> Result<()> {
    let path = access_file.context(
        "serving over HTTP needs an access file (--access-file or MEMORY_ACCESS_FILE); create entries with `kioku token`",
    )?;
    let access = kioku::access::AccessFile::load(&path)?;
    kioku::http::serve(
        app,
        kioku::http::HttpOptions {
            addr,
            access,
            tools,
            allowed_origins,
        },
    )
    .await
}

#[cfg(not(feature = "http"))]
async fn serve_http(
    _app: App,
    _addr: std::net::SocketAddr,
    _access_file: Option<PathBuf>,
    _tools: Option<String>,
    _allowed_origins: Vec<String>,
) -> Result<()> {
    anyhow::bail!(
        "this build has no HTTP transport; rebuild with `cargo build --release --features http`"
    )
}

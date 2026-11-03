# Kioku (記憶)

Local long-term memory for coding agents, served over MCP. PostgreSQL stores
curated Markdown notes, their explicit links, and lifecycle state; Qdrant
retrieves similar notes; Personalized PageRank over the links ranks them; and
Ollama computes embeddings locally.

## Quick start

```sh
cargo build --release --locked
./scripts/start.sh
./target/release/local-memory-mcp --env-file .env doctor
./target/release/local-memory-mcp --env-file .env ingest --path examples/notes --domain demo
./target/release/local-memory-mcp --env-file .env search "Which service replaces the old indexing worker?" --domain demo
```

MCP clients start `scripts/mcp.sh`, which serves the tools over stdio.

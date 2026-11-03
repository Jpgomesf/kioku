# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-11-03

### Added

- Hybrid retrieval: BM25 over keys, titles, aliases, tags, and bodies (with
  accent folding and whole identifiers) fused with vector search by Reciprocal
  Rank Fusion. Graph expansion fills reserved result slots from explicit links.
- `kioku eval`: graded retrieval evaluation in isolated storage or read-only
  over your own notes, with per-category, per-query, context-pack, and
  abstention reports, and an `--embedding-model` switch for comparisons.
- Behavior evaluation: opt-in server-side tool-call traces
  (`MEMORY_TRACE_FILE`), six scenarios, and a client-agnostic checker with
  pass^k and Wilson intervals.
- `kioku reindex` to switch embedding models without losing memories, and
  `kioku pin` / `unpin`, `kioku tools`.
- Embedding prompt formats per model family (nomic, Qwen3, EmbeddingGemma,
  Arctic, mxbai), overridable with `EMBEDDING_QUERY_PREFIX` and
  `EMBEDDING_DOCUMENT_PREFIX`.
- MCP prompts `recall` and `remember`, tool annotations and titles, and a
  correct `serverInfo` (`kioku`).
- Background upkeep while serving: index repair and monthly aging.
- CI (formatting, clippy, tests, MSRV, cargo-deny, stdio smoke test against
  PostgreSQL and Qdrant), a weekly retrieval eval, and Dependabot.

### Changed

- The crate and binary are now `kioku` (was `local-memory-mcp`); note ids,
  collections, and Docker volumes are unchanged.
- New tool surface: `memory_search`, `memory_get`, and `memory_save` by
  default; `MEMORY_TOOLS=all` adds `memory_inspect`, `memory_feedback`,
  `memory_retire`, `memory_restore`, `memory_import`, `memory_maintenance`,
  and `memory_stats`. Old tool and argument names are still accepted.
- Tools take and return keys instead of UUIDs, accept lenient arguments, use
  flat schemas without `$ref` or nullable unions, return the same JSON as text
  and structured content, and report categorized errors with an example.
- `memory_save` requires a domain, updates as a patch, preserves pin and
  confidence, and stamps provenance when none is given.
- Values from `--env-file` override inherited environment variables, and
  `serve` no longer reads `.env` from the working directory.
- Search no longer runs maintenance; it is read-only.
- Retention weighs less in ranking (0.05), so it only breaks near-ties.
- Frontmatter parsing uses `serde-saphyr`: plain numbers are accepted as text,
  `yes`/`no` are not booleans, and headings in code blocks are not titles.
- Dependencies: sqlx 0.9, reqwest 0.13; MSRV 1.94. Compose images are pinned
  by digest and Qdrant telemetry is off.

### Fixed

- The previous ranking seeded PageRank with nearly every note, so a pinned hub
  note ranked first for most queries (Hit@1 0.22 on the eval; now 0.86).
- A note too long for the embedding model was saved and then stayed hidden;
  embeddings are now computed before anything is written, and `repair`
  continues past failures.
- Searches failed for every domain once all domains together held more than
  10,000 notes; maintenance and repair now work per domain.
- Moving the notes folder made every later import fail.
- `memory_upsert` defaulted to the `local` domain while reads used
  `MEMORY_DEFAULT_DOMAIN`.
- `rag_context` cut notes at 2,400 characters without reporting truncation,
  failed entirely when one id was wrong, and held the global write lock.
- Concurrent writers could exhaust the connection pool.
- Wiki links with `#` or `|` outside `[[...]]` collided, and titles or retired
  notes could shadow exact keys.
- Imports were quadratic in the number of notes.
- The PostgreSQL integration test invalidated vectors for the whole database
  it ran against; it now creates and drops its own.

### Security

- Tools cannot overwrite Markdown-backed notes or save likely credentials.
- HTTP clients ignore proxy variables and don't follow redirects; a non-local
  Qdrant must use HTTPS.

## [0.1.0] - 2026-10-28

- Initial release: Markdown notes with frontmatter, PostgreSQL and Qdrant
  storage, Personalized PageRank ranking, retention aging, and twelve MCP tools.

# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `kioku bench` times retrieval at scale. It grows the bundled dataset's
  domain in isolated storage with synthetic distractor notes (English and
  Portuguese, linked within each of 400 made-up systems, embedded for real) to
  `--notes` notes, then runs the graded queries warm and as the first query of
  a new process, reporting quality, p50 and p95 latency, and time per stage.
  `--reuse-storage` measures again without embedding anything
  ([docs/evaluation.md](docs/evaluation.md#scale)). It lifts the 10,000-note
  limit for the domain it grows.

- `memory_get` and `memory_inspect` return each note's `aliases`, `[]` when it
  has none, so a client can tell a note without aliases from an older server.
  A save replaces the list, so an agent that adds an alias reads the current
  ones with `memory_get` and sends them all; `memory_save`'s description now
  says so. In `memory_get` the aliases count toward `max_bytes` and are never
  cut: the text shrinks instead, and a note whose aliases don't fit is left
  out with `truncated` set. Notes the session may not see stay out, aliases
  and all. Packs built for a query (`rag_context` with a query,
  `kioku context`, the eval) leave aliases out, and so do `memory_list` rows.
- Notes anchor to the code they govern with `paths`, globs relative to a
  repository's root (`src/vault/**`), set with `memory_save` or in
  frontmatter. A code map lookup names the notes anchored to its file, and
  `memory_list` takes `path` to list them. The note doesn't describe the code;
  it says which code a decision governs.
- `memory_get` takes `count_use`. A read with `count_use: false` isn't counted
  as use, so agents that read notes only to compare, deduplicate, or audit
  them don't keep those notes from aging out.
- A code map for small models: `kioku codemap update` parses a repository's
  source files at HEAD (only those that changed since the last update) into
  their purpose, main definitions, and the files they import. It is stored
  apart from notes, in the domain the repository's folder is placed in.
  `kioku codemap show` and the `code_map` tool (outside the core profile)
  return a file's entry with up to five neighbouring files, parsing the file
  again first if it changed. A summarizer program can write purposes for files
  without a doc comment, and gets code only from vaults its provider may read.
- Open Knowledge Format (OKF v0.2) bundles. `kioku ingest` reads a folder
  whose `index.md` declares `okf_version` as a bundle (`--format okf` forces
  it): each concept becomes a note keyed by its concept ID, with its producer
  `id` and `aliases` as aliases and its own file as the source. Links between
  concepts become `related` links, and concepts over 4,000 bytes become a hub
  plus one note per section keyed by GitHub's heading anchor. Each note opens
  with a facts line built from the spec's fields (type, lifecycle, trust tier,
  `stale_after`, `generated`, `resource`) and the producer's other plain
  fields. Deprecated concepts become legacy, and so do notes whose concept
  left the bundle, so a re-import follows the bundle. `memory_import` refuses
  a path in a bundle and points to the command line, and a Markdown import
  lists a bundle it meets under `failed` instead of reading it.
- An imported note whose source is a section (`file.md#anchor`) belongs to its
  file while the file exists, as other file-backed notes do.
- `scripts/vaults.py` edits the vaults file safely, with no recompile.
  - Commands: `check`, `where`, `add-area`, `add-vault`, `add-lock`,
    `remove-area`, and `sync-areas`, which adds an area for every git
    repository under a folder that has none.
  - Each change is made on a copy. The installed binary validates it, and the
    script checks where the affected folders would place a session, then
    shows the diff.
  - Only `--apply` writes, after a backup.
- Prebuilt binaries. Every push to main builds the macOS (Apple Silicon)
  binary and publishes it as the prerelease `main-build`.
  - `make install-prebuilt` downloads it, verifies its checksums, checks that
    it was built from the checked-out commit, and installs it without
    compiling.
- `memory_list` (in the `all` profile, read scope) pages through a domain's
  notes, or at a vault's root every domain of the vault. Each note shows key,
  title, status, tags, origin (agent or file), link count, and last update.
  It filters by status, origin, and tag, and applies vault and lock rules.
- `memory_save` reports `links`, the active notes the saved note links to or
  is linked from, and a new `next` field with advice. It says when a new note
  links to nothing while its domain has other notes. For a new note it also
  lists up to three unlinked stored notes at least
  `MEMORY_SIMILAR_NOTE_SCORE` similar (default 0.9) under `similar`, which may
  hold the same fact or be notes to link. The lookup reuses the note's vector,
  leaves every other active note out of the vector query so they can't
  crowd out candidates, and runs after the write lock is released. `hint` is
  unchanged: it still only reports unresolved `related` entries.
- Hosted embeddings. The OpenAI-compatible provider works with OpenRouter,
  OpenAI, and similar services (docs/configuration.md, "Hosted embeddings"). The service
  reads what it embeds, so `EMBEDDING_READER` names its provider (`local` by
  default on this machine, `other` elsewhere), and any reader but `local`
  receives only the notes that provider may read: vault providers, area
  locks, and note locks all apply. Other notes keep no vector and are found
  by keyword, label, and link, ranked on their keyword rank in place of the
  missing one; queries are not sent when the service may read none of the
  searched domains. `memory_inspect`, imports, `repair`, and `reindex` report
  `not_sent_to_embedder`, and `repair --all` applies a changed vaults file.
  `kioku reindex --to-env-file` moves an index to another service, and
  `Retry-After` on a 429 is honored for up to 30 seconds. Isolated evaluation
  storage ignores the vaults file.
- Embeddings on the Apple GPU. `make start` starts the Ollama container only
  when `EMBEDDING_URL` points at it (`127.0.0.1:11435`). With a native Ollama
  (`brew install ollama`, `EMBEDDING_URL=http://127.0.0.1:11434`) it starts
  only PostgreSQL and Qdrant and pulls the model natively, and
  `make stop-docker-ollama` stops the unused container. The vector index
  stays valid, since it depends on the model, not where it runs.
- Vaults and locks. A vaults file (`MEMORY_VAULTS_FILE`, default
  `~/.config/kioku/vaults.toml`) groups domains into vaults that never see
  each other. A stdio session is placed by the git remote of its repository,
  else by the longest matching folder (`KIOKU_SESSION_DIR` or the working
  directory), and declares its model provider with `MEMORY_PROVIDER`. Area
  locks in the file and `lock` in note frontmatter limit which providers may
  read notes. The server's instructions name the session's vault, or its
  area, and tell the agent to search without a domain instead of guessing one
  from the folder name. Search, get, inspect, links, stats, imports, and the older
  `rag_*` tools all filter before ranking, and the vector index leaves hidden
  notes out of its candidates. Domain lists (a vault-wide search's `domains`,
  the empty-search hint, `memory_stats`) name only domains holding a note the
  session may see, and a save's unresolved `related` links are checked
  against those notes too. A vault-wide search leaves out domains whose notes
  are all retired unless it sets `include_legacy`. A session that isn't placed, or names no
  provider, gets a `refused` error from every tool. Without the file, nothing
  changes.
- In vault mode, `memory_import` imports only files whose frontmatter names
  their `domain`: one notes folder serves every vault, so a file without one
  is counted as failed instead of joining the session's domain. Files of
  notes the session may not see, or whose vault can't be told, are counted in
  `failed_count` but not named, and a `hint` says so.
- Note locks fail closed: `lock: []`, an empty `lock:`, and near misses such
  as `Lock`, `locks`, or `locked` fail the file instead of importing the note
  unlocked.
- Placement by git remote resolves SSH host aliases from `~/.ssh/config`, so
  `git@github-work:org/repo` matches `github.com/org/*`. Without `HOME`, the
  default vaults file is found through the account's home folder, and Kioku
  warns when it can't find one.
- Vault-wide search: at a vault's root, `memory_search` without a domain
  searches every visible domain of the vault together, and each result names
  its domain.
- HTTP access-file entries take `provider` and `vault`
  (`kioku token --provider --vault`); in vault mode a token needs both.
- Traces record the vault, and `{vault}` in `MEMORY_TRACE_FILE` gives each
  vault its own file.
- Note history: every write that changes a note's content or status appends
  it to the append-only `memory_note_revisions` table in the same transaction,
  so overwritten text stays recoverable. Existing notes start their history at
  their current revision. `memory_inspect` shows the ten latest entries
  (revision, status, title, time).
- Graph evaluation: shuffled-link and dropped-link ablations (5 seeds each),
  complete multi-hop support (`required` notes per query), graph-slot
  precision against the same positions without links, hub exposure per note,
  link resolution rate, and 95% bootstrap or Wilson intervals on every mean
  and paired comparison. `kioku eval --max-hub-exposure` and `--no-leaks` gate
  CI.
- Access control: `MEMORY_SCOPES` (read, write, admin) and `MEMORY_DOMAINS`
  (globs or `re:` regexes) give each MCP client its own profile. Tools outside
  the scopes aren't listed, and calls on other domains are refused.
- Optional local HTTP transport (`--features http`, `kioku serve --http`):
  loopback only, bearer tokens hashed in an access file (`kioku token`), Host
  and Origin checks against DNS rebinding, and `tools/list` per principal.
- Observability: `tool` and `search` spans with durations (`RUST_LOG=kioku=info`),
  `MEMORY_LOG_FORMAT=json`, `kioku search --explain` with candidate counts and
  time per stage, the principal in every trace record, and
  `MEMORY_TRACE_CONTENT=redacted|hashed`.
- Evaluation harnesses: `evals/behavior/run_openai.py` runs the behavior
  scenarios against any OpenAI-compatible model with no client in between, and
  `evals/answers/` scores answers (fact correctness, citation validity and
  support, abstention, groundedness with a pluggable judge) against a
  no-memory baseline.

### Changed

- Search no longer loads and tokenizes its whole domain for every query. Each
  server process keeps an index of every domain it searches: BM25 postings and
  statistics, exact labels, retention inputs, and links, read with only the
  columns ranking needs. Triggers in the schema bump a per-domain version on
  every write to notes or links, by any process, so a search checks one row
  and, when it moved, reads only the notes written since the index's snapshot.
  A deletion, a TRUNCATE, or a note moving to another domain rebuilds the
  indexes it touches, and so does a count below the index's, as after
  restoring the database. Statistics are kept per status and lock, so a
  hidden note still neither matches nor shifts the scores of visible ones.
  The query is embedded while the index is checked, and BM25 runs while
  Qdrant answers. A warm search at 10,000 notes takes 12 ms instead of 214 ms
  (median), and 16 ms instead of 2 s at 100,000; the first search in a new
  process still reads the domain (182 ms at 10,000 notes). Rankings are
  unchanged: the bundled eval matches the previous version on every variant,
  ablation, and context pack, and so does every query of the scale benchmark.
- Graph expansion computes Personalized PageRank by pushing probability out
  from the top matches instead of iterating over every note of the domain, so
  its cost follows the matches' neighbourhood. Masses agree with the global
  computation to within 1e-8.
- Search counts a domain's legacy notes too against its 10,000-note limit, as
  saves do, since the index holds every note of the domain.
- The schema needs PostgreSQL 13 or later; on an older server, Kioku stops at
  startup with an error that names the requirement and the server's version.
  The bundled services run 17.
- The README leads with how to use Kioku well: the memory loop, the
  kioku-skills hooks and skills, tool habits, note writing and upkeep, then
  results, design choices, a comparison and limits. Its long reference
  sections moved to `docs/`: `usage.md`, `configuration.md`, `vaults.md`,
  `access-control.md`, `notes.md`, `code-map.md` and `design.md`.
- The README's Kilo example now passes variables under `environment`, the key
  Kilo reads, instead of `env`.
- Imports skip the files they can't import (unreadable, invalid frontmatter
  or content, another domain, a duplicate or owned key, too long to embed)
  and list them under `failed` with a reason and a path relative to the import
  root; the other files import as before. An import in which every file fails
  is still an `invalid_argument` error that writes nothing. Ownership is now
  checked for every file before any is written.
- Background upkeep no longer retires notes. It still repairs the index
  daily, but only logs the notes whose retention fell below
  `MEMORY_LEGACY_THRESHOLD`, as a warning so the default log filter shows it;
  `kioku maintenance` and `memory_maintenance` with `dry_run: false` still
  apply aging. Retention stays a ranking prior.
- Context packs fill their budget in three passes: the query-matching
  sentences of the strongest notes and the notes they link to, then those notes
  in full, then the rest. Left-out text shows as `…`. Packs drop the UUID, the
  default `active` status, and absolute source paths, cutting metadata per note
  from about 314 to about 180 bytes. At 1,500 bytes, packs now hold every expected
  fact for 31/32 queries (was 29/32), and for 27/32 at 800 bytes (was 21/32).
  `kioku eval --context-budget` takes several budgets (default 800,1500,3000).
- Source split into focused modules (`app/`, `mcp/`, `eval/`, `rank/`,
  `store/`, `markdown`, `lifecycle`, `text`) with no behavior change.

### Fixed

- The `memory_maintenance` tool description no longer says the server ages
  memories daily: background upkeep only previews aging (#13).
- Docs: the `all` profile has twelve tools, not ten, and the `read` scope also
  covers `memory_list` and `code_map`.

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

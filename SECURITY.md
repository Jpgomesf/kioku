# Security

## Reporting

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/Jpgomesf/kioku/security/advisories/new)
rather than in a public issue.

## Threat model

Kioku runs on one machine for one user. The MCP client and the server share
that machine's trust; stdio is not a sandbox.

- **Memory text is untrusted.** A note may contain text written to steer a
  model ("ignore previous instructions..."). Results are labelled
  `untrusted_evidence`, the server's instructions tell models to treat them as
  evidence only, and tool descriptions and instructions are static: they are
  never built from stored data. Behavior evals include an injected note.
- **Writes are constrained on the server.** Through MCP a model cannot pin
  notes, change their confidence, overwrite notes that come from Markdown
  files, claim a file path as provenance, save likely credentials (private
  keys, cloud and Git tokens, JWTs), import outside `MEMORY_NOTES_ROOT`, or
  reach another domain's memories by id. Nothing is ever hard-deleted.
- **Credentials stay local.** `scripts/start.sh` generates `.env` with mode
  0600 and random secrets. Services bind to 127.0.0.1. Note text goes to a
  remote embedding endpoint only with `ALLOW_REMOTE_EMBEDDINGS=true`, and a
  non-local Qdrant must use HTTPS. HTTP clients ignore proxy variables and
  don't follow redirects, so the Qdrant API key stays on the configured host.
  Qdrant's payloads hold each note's folded words for keyword search, so a
  hosted Qdrant holds note text as PostgreSQL does.
- **Configuration is explicit.** Values in the file named by `--env-file` win
  over inherited variables, and `serve` never reads a `.env` from the client's
  working directory, so another project's `DATABASE_URL` cannot redirect it.
- **Traces contain note text unless told otherwise.** `MEMORY_TRACE_FILE` is off
  by default and created with mode 0600. `MEMORY_TRACE_CONTENT=redacted` or
  `hashed` drops queries, titles, and bodies while keeping keys and timing.
  With `{vault}` in the path, each vault gets its own file.
- **Clients can be scoped.** `MEMORY_SCOPES` and `MEMORY_DOMAINS` in a client's
  MCP config limit that client's process to some tools and domains. The checks
  run on the server for every call, including through older tool names, and
  `memory_stats` hides domains outside the profile.
- **Vaults keep companies and models apart.** With a vaults file, each
  session is placed in at most one vault, by its git remote or its folder,
  and sees only that vault's domains. Area locks and note locks hide notes
  from model providers they leave out. Every read path filters before
  ranking (search, get, inspect, links, stats, import reports, older tool
  names), so a hidden note is never returned and never shifts the ranking of
  visible ones. Writes may target only visible domains, and a save can't
  overwrite a hidden note. One notes folder serves every vault, so a vault
  session's import reads only files whose frontmatter names their domain; a
  file without one can't be copied into the session's domain. A note lock
  that lists no provider, or a misspelled `lock` key, fails the file instead
  of leaving the note readable. A session that isn't placed, or declares no
  provider, gets nothing. A broken vaults file stops the server, and a domain
  claimed by two vaults is an error, never shared.
- **The provider is declared, not proven.** `MEMORY_PROVIDER` comes from the
  client's own MCP config, and an access-file entry for HTTP. Kioku trusts
  that config as it trusts the rest of your machine. It keeps the declaration
  honest only against mistakes: `.env` values override a client's, so Kioku
  warns when `.env` sets `MEMORY_PROVIDER` or `KIOKU_SESSION_DIR`. A hidden
  note's key still can't be reused by a session that can't see it, so a save
  can tell that the key is taken, and import reports count files they don't
  name. A save's unresolved `related` references are checked against the
  notes the session may see, so they can't probe hidden titles or aliases.
  The CLI is not restricted.
- **HTTP is opt-in and local.** `serve --http` exists only in builds with the
  `http` feature, binds only to loopback addresses, and requires a bearer token
  on every request. Only SHA-256 hashes of tokens are stored, and they are
  compared in constant time. Host and Origin headers are validated against DNS
  rebinding, and request bodies are capped at 1 MiB. A request that reaches a
  tool without an authenticated principal gets a principal with no scopes, so
  a wiring mistake fails closed. In vault mode, a token works only if its
  access-file entry names a provider and a vault. There is no OAuth yet; the
  transport is meant for one machine.

## Supply chain

`Cargo.lock` is committed and CI builds with `--locked`. cargo-deny checks
advisories, licenses, and sources; Dependabot proposes updates to crates,
GitHub Actions (pinned to commit SHAs), and the Compose images (pinned by
digest).

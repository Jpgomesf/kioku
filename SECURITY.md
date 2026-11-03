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
- **Configuration is explicit.** Values in the file named by `--env-file` win
  over inherited variables, and `serve` never reads a `.env` from the client's
  working directory, so another project's `DATABASE_URL` cannot redirect it.
- **Traces contain note text.** `MEMORY_TRACE_FILE` is off by default and
  created with mode 0600.

## Supply chain

`Cargo.lock` is committed and CI builds with `--locked`. cargo-deny checks
advisories, licenses, and sources; Dependabot proposes updates to crates,
GitHub Actions (pinned to commit SHAs), and the Compose images (pinned by
digest).

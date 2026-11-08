# Configuration

Kioku reads its settings from `.env` (see [`.env.example`](../.env.example)) or
from environment variables. Values in the file named by `--env-file` win over
inherited variables, so another project's `DATABASE_URL` can't redirect Kioku.
Without `--env-file`, `kioku serve` uses only the environment, and the other
commands also read `./.env`.

- [Services](#services)
- [Embeddings on the Apple GPU](#embeddings-on-the-apple-gpu)
- [Hosted embeddings](#hosted-embeddings)
- [Variables](#variables)

## Services

`make start` writes `.env` (mode 0600) with unique credentials on first run and
never evaluates it as shell code. It also points `MEMORY_NOTES_ROOT` at the
checkout's `notes/` folder, which git ignores. The services bind to 127.0.0.1
only:

| Service | Address | Volume |
|---|---|---|
| PostgreSQL | `127.0.0.1:15432` | `local-memory_postgres_data` |
| Qdrant | `http://127.0.0.1:16333` | `local-memory_qdrant_data` |
| Ollama | `http://127.0.0.1:11435` | `local-memory_ollama_models` |

`make stop` stops them and keeps the volumes. Back up PostgreSQL together with
your notes; the Qdrant index is derived data that `kioku repair --all` rebuilds.

## Embeddings on the Apple GPU

Docker on macOS can't use the GPU, so the bundled Ollama container embeds on
the CPU. That's fine for everyday saves, but importing thousands of notes keeps
every core busy for minutes. An Ollama installed on the Mac itself runs on the
GPU:

```sh
brew install ollama && brew services start ollama
# in .env:
EMBEDDING_URL=http://127.0.0.1:11434
make start               # now starts only PostgreSQL and Qdrant, and pulls the model natively
make stop-docker-ollama  # the container is no longer used
```

`ollama ps` should show `100% GPU`. The vector index stays valid: it depends
on the model and prompts, not on where they run, and the same model gives the
same vectors (cosine similarity above 0.9999 between the two runtimes).

## Hosted embeddings

To run no embedding model at all, use a hosted service with an
OpenAI-compatible `/embeddings` endpoint, such as
[OpenRouter](https://openrouter.ai/collections/embedding-models) or OpenAI:

```sh
# in .env
EMBEDDING_PROVIDER=openai                      # the API's shape, whoever serves it
EMBEDDING_URL=https://openrouter.ai/api/v1     # or https://api.openai.com/v1
EMBEDDING_MODEL=openai/text-embedding-3-small  # OpenRouter's name for it; OpenAI's is text-embedding-3-small
EMBEDDING_DIM=1536                             # the model's vector size
EMBEDDING_API_KEY=...
ALLOW_REMOTE_EMBEDDINGS=true
EMBEDDING_READER=openai                        # who reads the text you send; see below
```

`make start` then starts only PostgreSQL and Qdrant. Kioku picks query and
document prompts from the model's name (`qwen/qwen3-embedding-8b` gets
Qwen3's), and a wrong `EMBEDDING_DIM` stops the first embedding with a clear
error.

An install that already has an index moves in three steps:

1. Copy `.env` to `hosted.env`, and change the embedding settings and
   `QDRANT_COLLECTION` there.
2. Compare the model on the bundled retrieval set with
   `./bin/kioku --env-file hosted.env eval`.
3. Run `./bin/kioku reindex --to-env-file hosted.env`, which embeds every note
   again before switching, and make `hosted.env` your `.env`.

### What the service may read

The service reads every text it embeds, so Kioku treats it like a model of the
provider named in `EMBEDDING_READER`: `local` by default for an address on this
machine, `other` for any other. Through OpenRouter the text passes both
OpenRouter and the model's host, so name the host's provider only if you trust
both.

- A service read only locally (`local`) receives every note, as before.
- Any other receives a note only if that provider may read it. Without vaults,
  a note whose `lock` leaves the provider out is kept from it. With vaults, the
  note's vault must list the provider, no area lock may leave it out, and the
  note's own lock, if any, must name it ([vaults.md](vaults.md)).
- A note kept from the service has no vector. Search finds it by keyword,
  label, and link, with its keyword rank standing in for the meaning rank it
  can't have; `memory_inspect` marks it `not_sent_to_embedder`, and imports
  and `kioku repair` count such notes.
- Queries go to the service too, unless it may read none of the domains
  searched.
- After changing which providers a vault lists, or its locks, run
  `./bin/kioku repair --all`: it embeds the notes the service may now read and
  removes the vectors of those it no longer may.

## Variables

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | (required) | PostgreSQL connection |
| `QDRANT_URL`, `QDRANT_COLLECTION`, `QDRANT_API_KEY` | `http://127.0.0.1:16333`, `local_memory_v1` | Vector index; non-local URLs must use https |
| `EMBEDDING_PROVIDER` | `ollama` | `ollama` or `openai` (any OpenAI-compatible `/embeddings`) |
| `EMBEDDING_URL`, `EMBEDDING_MODEL`, `EMBEDDING_DIM` | `http://127.0.0.1:11435`, `nomic-embed-text`, `768` | Embedding service; non-local URLs need `ALLOW_REMOTE_EMBEDDINGS=true` |
| `EMBEDDING_API_KEY` | unset | Key for a hosted embedding service |
| `ALLOW_REMOTE_EMBEDDINGS` | `false` | Allow an `EMBEDDING_URL` that isn't on this machine |
| `EMBEDDING_READER` | `local` on this machine, else `other` | The provider that reads what the service embeds ([above](#what-the-service-may-read)) |
| `EMBEDDING_QUERY_PREFIX`, `EMBEDDING_DOCUMENT_PREFIX` | per model family | Override query/document prompts |
| `MEMORY_DEFAULT_DOMAIN` | `local` | Domain used when a call names none |
| `MEMORY_NOTES_ROOT` | unset (`make start` sets `notes/`) | Absolute folder `memory_import` may read |
| `MEMORY_TOOLS` | `core` | `core`, `all`, or a comma-separated list |
| `MEMORY_SIMILAR_NOTE_SCORE` | `0.9` | How similar (cosine) a stored note must be for a save to list it under `similar`; suits `nomic-embed-text`, lower it for models whose similarities run lower |
| `MEMORY_HALF_LIFE_DAYS`, `MEMORY_LEGACY_THRESHOLD` | `90`, `0.2` | Aging policy ([usage.md](usage.md#aging-and-maintenance)) |
| `MEMORY_BACKGROUND_UPKEEP` | `true` | Daily index repair while serving, and a log of notes aging would retire |
| `MEMORY_TRACE_FILE`, `MEMORY_TRACE_RUN` | unset | Record every tool call as JSONL; `{vault}` in the path gives each vault its own file |
| `MEMORY_TRACE_CONTENT`, `MEMORY_TRACE_SALT` | `full`, random | `redacted` or `hashed` keep keys, domains, and timing but drop query and note text |
| `MEMORY_PRINCIPAL`, `MEMORY_SCOPES`, `MEMORY_DOMAINS` | `local`, `read,write,admin`, `*` | Access profile for a stdio server ([access-control.md](access-control.md)) |
| `MEMORY_ACCESS_FILE` | unset | Who may connect to `serve --http` |
| `MEMORY_VAULTS_FILE` | `~/.config/kioku/vaults.toml` | Vault rules ([vaults.md](vaults.md)); no file means no vaults |
| `MEMORY_PROVIDER` | unset | The client's model provider; set it in each client's MCP config, never in `.env` |
| `KIOKU_SESSION_DIR` | the working directory | The folder that places a session in a vault; set it per client |
| `KIOKU_ENV_FILE` | unset | Same as `--env-file` |
| `MEMORY_LOG_FORMAT` | `text` | `json` for one JSON object per log line; filter with `RUST_LOG` (`RUST_LOG=kioku=info` logs every tool call and search with its duration) |

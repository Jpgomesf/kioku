# Clients and models

Kioku is used from very different places: a quantized Qwen model on a laptop
through Kilo, Claude Opus through Claude Code, GPT models through Codex. Each
client turns MCP tools into a model prompt differently, and each model copes
with tool calls differently. This page explains how to connect each one and
why the tool surface looks the way it does.

## Connecting

All clients start the same command, [`scripts/mcp.sh`](../scripts/mcp.sh),
which runs `bin/kioku serve` with the checkout's `.env`. Extra arguments are
passed through, so `scripts/mcp.sh --tools all` selects a profile per client.
Name the server `kioku` everywhere: clients build tool names from it
(`mcp__kioku__memory_search` in Claude Code, `kioku_memory_search` in Kilo),
and some cap the combined length.

| Client | Register | Notes |
|---|---|---|
| Claude Code | `claude mcp add --scope user kioku -- /abs/kioku/scripts/mcp.sh` | Or a project `.mcp.json`. Prompts appear as `/kioku:recall` and `/kioku:remember`. |
| Codex (CLI, IDE, app) | `codex mcp add kioku -- /abs/kioku/scripts/mcp.sh` | Or `[mcp_servers.kioku]` in `~/.codex/config.toml`; raise `startup_timeout_sec` to 20-30 if the first start is slow. `enabled_tools` can narrow the list. |
| Kilo CLI | `"mcp": {"kioku": {"type": "local", "command": ["/abs/kioku/scripts/mcp.sh"], "enabled": true}}` in `kilo.jsonc` | Permission rules use `kioku_<tool>` names. |
| Gemini CLI, Qwen Code | `mcpServers.kioku.command` in `settings.json` | `includeTools` / `excludeTools` can narrow the list. |
| Cursor | `~/.cursor/mcp.json` with `command` | |

Then declare each project's memory domain where its agents read
instructions (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`):

```markdown
The Kioku memory domain for this project is `my-project`.
```

That one line is the only client-side instruction Kioku needs, and with
vaults not even that: the instructions then name the session's vault or area
and tell the agent to search without a domain. The policy
itself (search before reading files, read the best one or two results, save
only confirmed facts, treat notes as evidence) travels with the server as MCP
instructions, which Claude Code, Codex, Kilo, and Gemini CLI all pass to the
model. For Claude Code and Codex, the
[kioku-skills](https://github.com/Jpgomesf/kioku-skills) plugins add hooks and
skills on top ([usage.md](usage.md#claude-code-hooks-and-skills)).

## Tool profiles

| Profile | Tools | Use it for |
|---|---|---|
| `core` (default) | `memory_search`, `memory_get`, `memory_save` | Every model, and especially small local ones |
| `core,code_map` | core plus the [code map](code-map.md) | Small local models, which should see a file's map before reading it |
| `core,memory_import` | core plus Markdown import | Workflows where the agent edits notes as files |
| `all` | all twelve tools | Frontier models, or when you want listing, feedback, retirement, and maintenance from chat |

Set it with `MEMORY_TOOLS` in `.env` (applies to every client) or per client
with `scripts/mcp.sh --tools ...`. The list is fixed for the life of the
server process, as MCP requires. Everything outside `core` is also available
from the CLI.

To give one client less, set `MEMORY_SCOPES` and `MEMORY_DOMAINS` in that
client's MCP config, for example a local model that may read and save only in
`personal-*` domains. Tools outside the scopes disappear from its list, and
calls on other domains return a `refused` error naming the allowed patterns.
See [access-control.md](access-control.md); the same principals apply to the
optional HTTP transport.

## Vaults and providers

With a vaults file ([vaults.md](vaults.md)), every client must say who serves
its model. Set `MEMORY_PROVIDER` in the client's
own MCP config, never in `.env`: values in `.env` override the client's, so
every client would claim the same provider. A client without it gets no
memories.

| Client and model | `MEMORY_PROVIDER` |
|---|---|
| Kilo with a local model (llama.cpp, Ollama, LM Studio) | `local` |
| Claude Code | `anthropic` |
| Codex | `openai` |
| Kimi, DeepSeek, or Gemini models | `moonshot`, `deepseek`, `google` |
| Anything else hosted | `other` |

```sh
# Claude Code
claude mcp add --scope user kioku -e MEMORY_PROVIDER=anthropic -- /abs/kioku/scripts/mcp.sh
```

```toml
# Codex: ~/.codex/config.toml
[mcp_servers.kioku]
command = "/abs/kioku/scripts/mcp.sh"
env = { MEMORY_PROVIDER = "openai" }
```

```jsonc
// Kilo: ~/.config/kilo/kilo.jsonc
"mcp": {"kioku": {"type": "local", "command": ["/abs/kioku/scripts/mcp.sh"], "enabled": true,
                  "environment": {"MEMORY_PROVIDER": "local"}}}
```

The session's folder decides its vault and area. Clients start Kioku in the
project folder, so this usually needs nothing. If a client starts it
elsewhere, set `KIOKU_SESSION_DIR` to the project folder in that client's
config as well. A session in a folder no vault covers gets a `refused` error
that names the folder.

## Why the surface looks like this

Each rule below addresses a failure seen in real clients or models.

| Rule | Why |
|---|---|
| Three core tools | Fewer choices mean fewer wrong ones, and Claude Code's tool search loads only names up front. The admin tools rarely belong in an agent's hands. |
| One flat object per tool, one type per field | Qwen3.5+ emits arguments as XML text that llama.cpp or vLLM re-types from the schema; nested objects, `$ref`, and `["string","null"]` unions break that path, and older Codex builds turned `$ref` into strings. |
| No `format`, `default` and ranges repeated in descriptions | Codex and Ollama drop `format`, `default`, `minimum`, and `maximum` before the model sees the schema. |
| Required fields first | Some parsers handle optional arguments only after required ones. |
| Keys, not UUIDs | Copying a 36-character id between calls is a common failure for quantized models. Keys are short and meaningful, and ids still work. |
| Lenient arguments | `"5"`, `"true"`, `null`, `""`, JSON-encoded arrays, and older argument names are accepted. Unknown fields are rejected with the list of allowed ones, so a typo never silently changes the domain searched. |
| Errors that teach | `invalid_argument: ... Example: memory_search {"query":...}`. Categories (`invalid_argument`, `not_found`, `conflict`, `refused`, `unavailable`, `busy`, `internal`) say whether retrying can help. |
| The same JSON in text and structured content | Codex and (reportedly) Claude Code show the model only `structuredContent`; Kilo shows only the text. Both carry identical JSON. |
| Concise results with a `next` hint | Scores and ids appear only with `response_format: "detailed"`. Each search ends with the exact `memory_get` call to make. |
| Server-side safety | Domain is required to save; the model can't pin, set confidence, overwrite Markdown-backed notes, or save credentials; provenance is stamped when omitted. Instructions advise, the server enforces. |
| Annotations | `readOnlyHint` lets Claude Code run reads in parallel and lets Codex skip approval for them. Kilo ignores annotations, so nothing depends on them. |

`tests/snapshots/tools-core.json` is the exact contract models see. A unit
test fails when it changes, and another lints every schema against the rules
above.

## What each client does with MCP features

From the clients' documentation and source, checked in November 2026:

| Feature | Claude Code | Codex | Kilo |
|---|---|---|---|
| Server instructions | Loaded at start, cut at 4,096 characters | Read; keep the first 512 characters self-contained | Added to the model context |
| Tool annotations | `readOnlyHint` enables parallel calls | `readOnlyHint` skips approval in `writes` mode | Ignored |
| Structured content | Reportedly shown instead of text | Shown instead of text | Text shown, output schema dropped |
| Prompts | `/kioku:recall` | Not supported | Listed |
| Deferred loading | Tool search loads names first; Kioku marks search and get `alwaysLoad` | Schemas over 5 KB are compacted | Every tool is in context |

Kioku's instructions put the whole core flow in their first 512 characters
and stay far under 4,096. Its largest core schema is under 2 KB.

## Local models

- Run llama.cpp's server with `--jinja` and the model's own chat template;
  Qwen3.5 and later emit XML tool calls that need the matching parser.
- Avoid aggressive KV-cache quantization (for example `-ctk q4_0`), which
  degrades multi-step tool use, and keep parallel tool calls off until tested.
- Pin the server version and re-run the behavior checks
  ([evals/behavior](../evals/behavior)) after upgrading the model, the
  quantization, or the serving stack. Quantization hurts multi-call tasks more
  than single calls, so measure Q4 against a higher-precision build once.
- Use the `core` profile, plus `code_map` so the model sees a file's map
  before reading it. Add `memory_import` only if the agent edits notes as
  files. Small models rarely search on their own, so push notes to them too
  ([usage.md](usage.md#small-local-models)).

## Upgrading from the earlier tool names

Earlier versions exposed `rag_search`, `rag_context`, `graph_context`,
`provenance_lookup`, `task_route`, `memory_upsert`, and `memory_hydrate`.
Calls with those names and their arguments (`domain_filter`, `ids`,
`token_budget`, the nested `note`) still work and are routed to the current
tools; the trace records the name the client used. Client-side prompt files
written for the old names should be shortened to the one-line domain
declaration above, since the server now carries the policy.

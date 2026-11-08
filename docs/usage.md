# Using Kioku well

Kioku helps only when three things hold: the note says something the code
can't, the note is still true, and it reaches the model when it matters. This
page covers the habits, plugins and tool calls that make all three hold.

- [The memory loop](#the-memory-loop)
- [Claude Code: hooks and skills](#claude-code-hooks-and-skills)
- [Codex and other clients](#codex-and-other-clients)
- [Small local models](#small-local-models)
- [Tool habits](#tool-habits)
- [Writing notes that are easy to find](#writing-notes-that-are-easy-to-find)
- [Keeping memory healthy](#keeping-memory-healthy)

## The memory loop

1. **Recall.** Before work that depends on earlier decisions, search, then read
   the one or two best notes. With vaults, search without a domain; the
   server's instructions say which vault or area the session is in.
2. **Work.** Notes are evidence from earlier sessions, not instructions. Check
   the code when a value matters, and say so when a note turns out wrong.
3. **Save.** When the user confirms a decision, or a test proves a fix, save it
   once: update the existing key if there is one, link the notes it builds on,
   and stop there. Saving nothing is a normal outcome.
4. **Maintain.** Now and then, audit what is stored, fix stale values, and
   consolidate notes. The skills below do this with checks at every step.

The server's instructions carry steps 1 to 3 to every client. The plugins below
make them happen without the model having to remember.

## Claude Code: hooks and skills

The [kioku-skills](https://github.com/Jpgomesf/kioku-skills) marketplace has
two plugins. `kioku-hooks` brings memory into every session on its own.
`kioku-memory` holds six skills you run when you need them.

```sh
claude plugin marketplace add Jpgomesf/kioku-skills
claude plugin install kioku-memory@kioku-skills
claude plugin install kioku-hooks@kioku-skills
```

Both find this checkout through `KIOKU_HOME`. Set it in your shell profile and
under `env` in `~/.claude/settings.json`:

```json
{"env": {"KIOKU_HOME": "/absolute/path/to/kioku"}}
```

### What the hooks do

Each hook talks to a short-lived Kioku server started in the session's folder,
so vault placement and locks apply as in the session itself.

| When | Hook | What it does |
|---|---|---|
| Session start | `SessionStart` | Names the session's vault and area and lists up to 15 of the area's notes, newest first. Adds what background reviews saved since the last session, the items waiting for your decision, and a dream that finished. |
| Each prompt | `UserPromptSubmit` | Adds notes for IDs the prompt names (`id_patterns`) and up to three notes the prompt is about, each once per session. Skips short prompts, slash commands and replies such as "ok". |
| Opening a file | `PreToolUse` on Read and Edit | Adds the notes anchored to the file through `paths`, up to five, and knowledge-base notes about it (`bundles`), each once per session. |
| End of a turn | `Stop` | After a commit, or every 8 prompts without a save, asks Claude to save what that stretch settled with the checkpoint skill. After a commit, it also updates the code map in the background. |
| Compaction | `PreCompact` | Starts a background review of the transcript so far. |
| Session end | `SessionEnd` | Reviews the rest of the session. Starts a scheduled dream when you turned it on and one is due. |

- **The background review** is a headless `claude -p` (Sonnet, high effort)
  that can only search, read and save notes in the session's vault. It saves
  what the user confirmed or a command verified, and its saves go live. A
  proposal to retire a note or to change a knowledge-base decision goes on the
  pending list instead.
- **Spending caps:** 24 review runs and 2.5 million characters a day, and $2
  per run. What a session-end review can't read goes on the pending list, with
  the command that reviews it.
- **Only sessions a person attends** nudge and review. `claude -p` runs
  don't.
- **Settings** live in `~/.config/kioku/hooks.json`, over the plugin's
  defaults: how many notes a prompt brings up and the relevance floor (0.68,
  set for `nomic-embed-text`), how often to nudge, the review's model and caps,
  and the scheduled dream. `KIOKU_HOOKS=off` turns every hook off. The
  kioku-skills README lists them.

### Which skill when

| Skill | Use it when | Example |
|---|---|---|
| `checkpoint` | Before you compact or end a session, or when you say "remember this": it saves what the session settled. | `/kioku-memory:checkpoint the retry decision` |
| `decide` | A design, data-model, tooling or convention choice comes up: it checks the stored decisions first, then records yours. | `/kioku-memory:decide which amount refund retries charge` |
| `memory-refresh` | A note turns out stale, or before you rely on notes written before a large refactor: it fixes paths, commands and defaults against the code. | `/kioku-memory:memory-refresh work/payments` |
| `project-sync` | A project's memory is behind its commits, PRs and threads, or has no notes yet: it harvests what they settled. | `/kioku-memory:project-sync personal/notes dry-run` |
| `reflect` | You want to know how the memory is doing: a quick health check, or an audit for contradictions and drift that changes nothing. | `/kioku-memory:reflect work/payments health` |
| `dream` | An area's notes are messy: it splits, merges, links, anchors them to code, and keeps one hub note per topic. | `/kioku-memory:dream personal/notes` |

What each one writes without asking:

| Skill | Saved at once | Waits for you (asked, or on the pending list) |
|---|---|---|
| `checkpoint` | New and updated notes for what you confirmed | Retiring a replaced note; open questions |
| `decide` | Nothing until you confirm; then the decision note | Retiring the note it replaces; a knowledge-base change |
| `memory-refresh` | Stale values in agent notes; Markdown notes, after a backup; a commit on a branch of a knowledge-base repository | Pushing or opening a PR; decisions the code now contradicts; claims it couldn't verify |
| `project-sync` | Verified new notes, refreshed agent notes, and the sources you confirm | Anything that contradicts or replaces a decision, retires a note, or changes a file |
| `reflect` | Nothing | Every confirmed finding, and each fix |
| `dream` | Rewrites, splits, links and anchors on agent notes, and topic hubs | Merges that retire a note, replaced decisions, and changes to files |

`project-sync`, `reflect` and `dream` run their agents with Claude Code's
Workflow tool; `project-sync` and `dream` check every proposal with an
independent agent, and `reflect` every finding. The kioku-skills README covers
each skill's settings and the scheduled dream.

## Codex and other clients

- **Codex.** Add the marketplace with
  `codex plugin marketplace add Jpgomesf/kioku-skills`, then install
  `kioku-memory` from `/plugins`. `checkpoint`, `decide` and `memory-refresh`
  work there. `project-sync`, `reflect` and `dream` need Claude Code's Workflow
  tool, so in Codex they say so and stop. The hooks read Claude Code's
  transcripts and are Claude Code only.
- **Other clients** (Kilo, Gemini CLI, Qwen Code, Cursor) get the memory policy
  from the server's instructions and the three core tools.
  [clients.md](clients.md) shows how to connect each one.
- **Without vaults,** declare each project's domain where its agents read
  instructions (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`):
  `The Kioku memory domain for this project is my-project.`

## Small local models

A quantized local model rarely decides on its own to search memory, so push
memory to it instead. Kioku provides two pieces; a plugin or script in your
client delivers them.

- **The code map** says what a file is for before the model reads it: its
  purpose, main definitions with line numbers, up to five neighbouring files,
  and the notes anchored to it. Serve it with
  `scripts/mcp.sh --tools core,code_map`, and the server's instructions ask the
  model to call `code_map` before reading a source file. A client plugin can
  also call it whenever the model opens a file. Keep the map current with
  `kioku codemap update --repo <repo>` after commits ([code-map.md](code-map.md)).
- **Context packs** are the best notes for a query, fitted to a byte budget.
  `kioku context "<prompt>" --domain <domain>` prints one (its
  `--token-budget` counts bytes, default 1,500). Over MCP, the older
  `rag_context` call with a `query` builds one the same way, under the
  session's vault rules. A client plugin can add one to each prompt. Packs put
  the sentences that match the query first
  ([evaluation.md](evaluation.md#context-packs)).
- **Keep the tool list short:** the `core` profile, plus `code_map`. Add
  `memory_import` only if the model edits notes as files. Serving tips for
  llama.cpp and quantized models are in [clients.md](clients.md#local-models).

The kioku `context` command ignores vaults, like the rest of the CLI, so a
script that uses it must choose the domain itself.

## Tool habits

### Search, then read

- `memory_search` returns previews (key, title, snippet, score). Its `next`
  field holds the exact `memory_get` call for the best one or two results.
- Scores rank relevance; they don't say whether a note is true or whether
  anything relevant exists. Judge from the snippets, and say so when nothing
  fits.
- `include_legacy: true` also returns retired notes, for history questions.
- `response_format: "detailed"` adds ids, sources, dates and ranking signals,
  for debugging a ranking.

### Read without counting: `count_use`

A `memory_get` counts as use, which keeps a note from aging out. A read that
only compares, deduplicates or audits notes should pass `"count_use": false`,
so audits don't keep unused notes alive. If an older server rejects the
argument, read again without it.

### Size: `max_bytes`

`memory_get` returns at most 2,000 bytes by default, for the whole response.
When a reply says `truncated`, raise `max_bytes` (up to 8,000) or ask for fewer
keys. Up to ten keys fit in one call.

### Aliases

`memory_get` returns every note's `aliases`, `[]` when it has none, so a client
can tell a note without aliases from an older server that doesn't send them. A
save replaces the list with the one it sends, and leaving the field out keeps
it.
To add an alias, read the note and send its whole list plus the new one.
Aliases count toward `max_bytes` and are never cut: the text shrinks to make
room, and a note whose aliases don't fit is left out, with `truncated` set.

### Anchor decisions to code: `paths`

`paths` on a save (or in frontmatter) lists globs relative to the repository
root, such as `["services/refunds/**"]`. Opening a matching file then brings
the note up, through the Claude Code hook or the code map. List a file's
notes with `memory_list {"path": "services/refunds/retry.py"}`. An anchor says
which code a note governs; it never describes the code.

### What a save reports

Besides the key and revision, `memory_save` returns `links`, the number of
active notes the saved note links to or is linked from, and a `next` field with
advice:

- **A new note that links to nothing,** in a domain that has other notes, is
  reachable by search but never through the graph. `next` says to add the notes
  it builds on, narrows, or replaces to `related`.
- **A new note close in meaning** to up to three stored notes it doesn't link
  to gets them listed under `similar`, with their similarity.
  - If one already holds the fact, update that note instead.
  - If the new note refines or replaces one, link it.
  - Similarity is cosine over the stored vectors. The threshold,
    `MEMORY_SIMILAR_NOTE_SCORE` (default 0.9), suits `nomic-embed-text`: in a
    dense single-project knowledge base, pairs at 0.9 or more were mostly
    restatements, refinements, and replacements, and few were unrelated.
  - Models whose similarities run lower need a lower value.
- `unresolved_related` lists `related` entries that matched no note, and
  `hint` says to use exact keys from search results. Fix them with another
  save.

The server refuses credentials, and agents can't overwrite notes that come
from files; change the file and import it again.

### Audit with `memory_list` and `memory_inspect`

These two are in the `all` profile (`scripts/mcp.sh --tools all`).

- `memory_list` pages through a domain (or, at a vault's root, every domain of
  the vault) without reading text: key, title, status, tags, paths, origin,
  links and last update. Filter with `origin: "agent"`, `tag: "decision"`,
  `status: "legacy"` or `"all"`, and `path`. Rows with `links: 0` are orphans.
  Pass `next_offset` to get the next page.
- `memory_inspect` shows one note's aliases, source, status, dates,
  confidence, pin, usage and feedback counts, retention, index state, links
  with their direction, and its ten latest revisions (revision, status, title
  and time). No tool reads an old revision's text back.

### Retire and restore

`memory_retire` moves a note that is obsolete with no replacement to `legacy`:
it leaves default search, and `memory_get` still returns it, marked legacy.
`memory_restore` reverses it. Nothing is ever deleted. Retire only when the
user confirms; when a fact changed, update the note instead. A decision that
replaces another is a new note that says "Replaces <key> (<date>)", links the
old one, and retires it after the user confirms.

### Prompts

Clients that support MCP prompts offer two shortcuts: `recall` looks up what
Kioku knows about a topic or the current task, and `remember` saves the
conversation's confirmed decisions, tested fixes, and lasting preferences. In
Claude Code they appear as `/kioku:recall` and `/kioku:remember`.

## Writing notes that are easy to find

Kioku finds a note in four ways: an exact key, title or alias; keywords
(BM25); meaning (vectors); and links from the notes that matched. Write every
note so all four work.

| Field | Rule | Example |
|---|---|---|
| key | Stable kebab-case, subject first. Reuse it to update. | `refund-retries-use-stored-amount` |
| title | The claim, specific enough to answer a question on its own | Refund retries charge the amount stored at request time, not the current order total |
| aliases | Every ID and name people will search with, including their own words | `ADR-12`, `PAY-381`, `payment.refund_requested` |
| tags | One kind (`decision`, `convention`, `gotcha`, `fix`, `preference`, `setup`), plus topic tags | `decision`, `refunds` |
| body | One to three sentences under 600 characters: the fact, why it holds, where it applies. A decision adds the options rejected and the consequence. | Chose X over Y because Z; this means W. |
| related | One to three keys a reader needs next, in the same domain | `[refund-flow]` |
| paths | The code it governs, as globs | `services/refunds/**` |

- **One fact per note.** Two decisions are two notes, linked.
- **Save what the code can't show:** decisions and the options rejected,
  gotchas with their exact error text, conventions, and preferences.
- **Never save** descriptions of code, progress, transcripts, guesses, or
  secrets.
- **Links resolve only within one domain,** so put a note where the notes it
  relates to live.

The format for Markdown files and knowledge-base bundles is in
[notes.md](notes.md).

## Keeping memory healthy

### Health check

`/kioku-memory:reflect <domain> health` reports a short card with no agents:
notes active and legacy, links, pending vectors, agent notes that link to
nothing, undecided proposals, drift, topics never audited, and recall against
the last baseline when the area has a retrieval dataset. Run it monthly, or
whenever retrieval seems off.

### Retrieval checks

Put a dataset of your own questions at
`~/.config/kioku/evals/<vault>/<domain with / as ->/dataset.json`
([format](../evals/README.md)). `reflect` then compares recall with the
`baseline.json` beside it, and `project-sync` and `dream` compare recall before
and after their changes. A drop goes on the pending list. For a one-off check,
`kioku eval --dataset <file>` with a dataset that has no corpus searches an
existing domain read-only ([evaluation.md](evaluation.md)).

### The pending list

Whatever needs your decision waits on one list per vault, in
`~/.local/state/kioku/pending/<vault>.json`: notes to retire, knowledge-base
changes, contradicted decisions, unverified claims, retrieval regressions, and
unreviewed transcripts. With the hooks, each session start shows how many items
wait and the oldest three. Settle an item by telling Claude what you decided;
the skill or Claude marks it done.

### The scheduled dream

`dream` can run weekly on its own, from a desktop scheduled task or from the
hooks' session-end trigger. A scheduled run never asks and never retires a
note: merges and replacements wait on the pending list. The first dream of an
area is always one you start yourself. The kioku-skills README has the setup.

### Aging and maintenance

Each note has a retention score: its confidence times a feedback factor, a
small boost for use, and a decay that halves every 90 days
(`MEMORY_HALF_LIFE_DAYS`) since its last edit or counted read. With the
defaults (confidence 0.8, no feedback), an unpinned note that nobody reads or
edits for seven 30-day periods falls below `MEMORY_LEGACY_THRESHOLD` (0.2).
Search previews and reads with `count_use: false` don't count.

- **Nothing ages on its own.** Background upkeep repairs the index daily and
  logs a warning naming the notes whose retention fell below the threshold, but
  never retires them.
- `kioku maintenance --dry-run` previews. `kioku maintenance`, or
  `memory_maintenance` with `dry_run: false`, moves those notes to `legacy`,
  where default search skips them. `memory_restore` brings one back. With
  vaults, `memory_maintenance` is refused because it ages every vault; use the
  CLI.
- `kioku pin KEY --domain D` protects a note that must stay findable, and
  `kioku unpin` lets it age again.
- `memory_feedback` records that a note proved right or wrong, which moves its
  retention.

### Service health

```sh
./bin/kioku doctor        # PostgreSQL, Qdrant and the embedding service
./bin/kioku stats         # counts, links and pending vector updates
./bin/kioku repair        # finish interrupted indexing; --all rebuilds every vector
./bin/kioku repair --payloads  # rewrite payloads for BM25 in Qdrant, without embedding
```

Pending vectors above zero for more than a minute, or a `memory_stats` error,
point to a service problem: start with `kioku doctor`.

# Vaults and locks

A vault holds everything about one company or one part of your life, such as
`personal` and `work`. Its areas are domains. Vaults never see each other, in
either direction. A lock limits which model providers may read an area or a
note.

Vaults are off until `~/.config/kioku/vaults.toml` exists (or the file named by
`MEMORY_VAULTS_FILE`). Without that file, Kioku works exactly as before. When a
client starts Kioku without `HOME`, `~` is the account's home folder; if even
that is unknown, Kioku warns that it runs without vaults.

- [The file](#the-file)
- [Editing the file](#editing-the-file)
- [Placement](#placement)
- [Providers](#providers)
- [What a session sees](#what-a-session-sees)
- [Mistakes, HTTP and traces](#mistakes-http-and-traces)

## The file

```toml
[[vault]]
name = "personal"
paths = ["~"]                         # folders that place a session here
domains = ["personal", "personal/*", "local"]
providers = ["local", "anthropic"]    # who may read this vault
default_domain = "personal"

[[vault]]
name = "work"
paths = ["~/work"]
git_remotes = ["github.com/acme-corp/*"]   # a match wins over paths
domains = ["work", "work/*"]
providers = ["local", "anthropic", "openai"]
default_domain = "work"

[[area]]
domain = "personal/notes"
paths = ["~/code/notes"]

[[lock]]
domains = ["personal/finances"]       # only local models may read these notes
providers = ["local"]
```

## Editing the file

A mistake in the file stops Kioku for every new session, so
[`scripts/vaults.py`](../scripts/vaults.py) makes each change on a copy.

- **What it checks.** The installed binary validates the copy, and the script
  shows where each folder the change affects would place a session. It does
  that by asking a Kioku server started there.
- **What it writes.** It prints the diff, and only with `--apply` backs up the
  old file to `backups/` beside it and replaces it.
- **New sessions** see the change. Running ones must reconnect Kioku (in
  Claude Code, `/mcp`).

```sh
scripts/vaults.py check                                  # is the file valid?
scripts/vaults.py where ~/code/notes ~/work              # where would sessions land?
scripts/vaults.py add-area personal/notes ~/code/notes --apply
scripts/vaults.py sync-areas --root ~/code --prefix personal --apply   # area personal/<repo> for each repo under ~/code without one
scripts/vaults.py add-vault work --path ~/work --domain work --domain 'work/*' --allow local --allow anthropic
scripts/vaults.py add-lock --domain personal/finances --allow local
scripts/vaults.py remove-area personal/notes --apply
```

- **Folders must exist** for `add-area` and `add-vault`, unless you pass
  `--allow-missing`.
- **Placement is checked as provider `anthropic`,** or as one the vault admits
  (`--provider` picks another).
- **Re-embedding:** after changing a vault's providers or a lock, run
  `kioku repair --all`. That's needed only with a hosted embedding service
  (`EMBEDDING_READER` other than `local`; see
  [configuration.md](configuration.md#what-the-service-may-read)).

## Placement

A session's folder is `KIOKU_SESSION_DIR`, or else the folder the client
started Kioku in.

- If that folder is in a git repository whose remote matches a vault's
  `git_remotes`, that vault wins. Remotes are compared as `host/owner/repo` in
  lowercase, `origin` first. Kioku reads `.git/config` itself; it needs no
  network and no `git`. An SSH remote through a `Host` alias in
  `~/.ssh/config` (`git@github-work:acme-corp/api.git`) also matches as its
  `HostName` (`github.com/acme-corp/api`). Kioku doesn't follow `Include` or
  `Match` there, nor git's `insteadOf` rewrites; for those, a host-agnostic
  glob such as `*/acme-corp/*` matches the remote on any host.
- Otherwise the vault with the longest matching `paths` entry wins.
- Inside an area's folder, calls without a domain use that area. At the
  vault's root they use `default_domain`, and `memory_search` without a domain
  searches every domain of the vault at once. Each result then names its
  domain.
- The server's instructions name the session's vault, or its area, and tell
  the agent to search without a domain, so it doesn't guess one from the
  folder name. A project's `AGENTS.md` needs no domain line.
- A session that no vault covers gets no memories. Every tool returns a
  `refused` error that names its folder and the vaults file.

## Providers

Each client declares the provider of its model with `MEMORY_PROVIDER`:
`local`, `anthropic`, `openai`, `moonshot`, `deepseek`, `google`, or `other`.
A client without it gets no memories. Set it in the client's MCP config env,
never in `.env`: values in `.env` override the client's, so every client would
claim the same provider. Kioku logs a warning when `.env` sets
`MEMORY_PROVIDER` or `KIOKU_SESSION_DIR`.
[clients.md](clients.md#vaults-and-providers) shows each client.

## What a session sees

The domains of its vault, narrowed by `MEMORY_DOMAINS` if that is set, minus
areas whose lock leaves out its provider. The vault must list the provider too.
A note can also carry its own lock in frontmatter (`lock: local`, or
`lock: [local, anthropic]`); `memory_save` keeps a note's lock but can't set
one.

- A note a session may not see is missing everywhere: search, `memory_get`,
  `memory_inspect`, `memory_list`, links, `memory_stats`, import reports, the
  unresolved links and similar notes a save reports, and the older `rag_*`
  tools. Hidden notes never shift the ranking of visible ones; the vector index
  leaves them out of its candidates.
- Domain lists (a vault-wide search's `domains`, the hint when a domain has no
  memories, `memory_stats`) name only domains that hold a note the session may
  see. A vault-wide search also leaves out domains whose notes are all retired,
  unless it sets `include_legacy`.
- `memory_save` and `memory_import` may write only to visible domains.
- `memory_import` reads only files whose frontmatter names their `domain`. One
  notes folder serves every vault, so a file without one could belong to any
  vault and is skipped rather than imported into the session's domain.
- An import's report names only notes the session may see. Files of other
  vaults or locked notes, and files whose vault can't be told (no `domain`,
  unreadable, or unparseable), are counted in `failed_count` but not named,
  and a `hint` says so.
- `memory_stats` counts only what the session may see.
- `memory_maintenance` is refused, because it ages every vault. Run
  `kioku maintenance` instead.
- The CLI is not restricted. It is your own shell.

## Mistakes, HTTP and traces

Mistakes in the vaults file stop the server at startup. A domain that matches
no vault is invisible. A domain that matches two vaults is a configuration
error, reported when a session meets it. Locks apply only with a vaults file,
because only then do clients declare a provider.

Over HTTP, each `[[principal]]` in the access file names its `provider` and
`vault`; `kioku token NAME --provider anthropic --vault personal` writes both.
In vault mode, a token without both gets nothing. HTTP sessions sit at their
vault's root. See [access-control.md](access-control.md#local-http).

`MEMORY_TRACE_FILE=/path/trace-{vault}.jsonl` gives each vault its own trace
file, and every record names its vault. Sessions that were refused write to
`trace-_unplaced.jsonl`. Without vaults, `{vault}` becomes `default`.

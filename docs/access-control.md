# Access control

Each MCP client starts its own `kioku serve`, so a client's MCP config can give
it a narrower profile than the others.

- **Scopes gate tools.** `read`: search, get, inspect, stats, list, and
  `code_map`. `write`: save and feedback. `admin`: retire, restore, import,
  and maintenance. Tools outside the scopes aren't listed at all.
- **Domain patterns gate every read and write.** Calls on other domains return
  a `refused` error that names the allowed patterns.

```jsonc
// Kilo with a local model: read and save, personal domains only
"environment": { "MEMORY_SCOPES": "read,write", "MEMORY_DOMAINS": "personal-*,kioku", "MEMORY_DEFAULT_DOMAIN": "kioku" }
```

Patterns are globs (`work-*`) or anchored regexes (`re:client-(acme|globex)`),
matched in linear time. A bad pattern, or a default domain outside the
patterns, stops the server at startup.

`MEMORY_PRINCIPAL` names the profile in traces and errors (default `local`).
With a vaults file, scopes and patterns narrow what the session's vault already
allows ([vaults.md](vaults.md#what-a-session-sees)).

## Local HTTP

Clients that can't spawn a process, or that should share one server, can use
MCP Streamable HTTP. It's a cargo feature, so default builds open no port:

```sh
cargo build --release --features http
./target/release/kioku token kilo-qwen --scopes read,write --domains 'personal-*,kioku'
# prints the token once, plus a [[principal]] entry with its SHA-256 for the access file
./target/release/kioku serve --http 127.0.0.1:7373 --access-file ~/.config/kioku/access.toml
```

The server binds only to loopback addresses and requires a bearer token on
every request, even from 127.0.0.1. It rejects foreign `Host` headers and any
browser `Origin` that isn't allowed with `--allowed-origin`, which blocks DNS
rebinding from web pages. Tokens resolve to a principal before any tool runs,
and `tools/list` differs per principal. That token check is the only code that
knows about credentials, so an OAuth provider can replace it later without
changing tools.

With a vaults file, each token also needs `--provider` and `--vault`
([vaults.md](vaults.md#mistakes-http-and-traces)).

# Kioku Viewer

A desktop app for browsing and governing Kioku memory. Tauri 2, React 19 and TypeScript.

## Run it

```sh
npm install
npm run dev         # browser only, on http://localhost:1420, with mock data
npm run tauri dev   # the desktop app, with the Rust backend
npm run check       # typecheck, lint (Biome), tests (Vitest) and the version check
npm run build       # typecheck and a production Vite build
```

From the repo root, `make viewer-check` runs `npm run check` plus `cargo fmt --check`,
clippy with warnings denied and `cargo test` in `src-tauri/`. Versions live in
`package.json`, `src-tauri/Cargo.toml`, `tauri.conf.json` and `CHANGELOG.md`;
`npm run version:check` checks they agree and `npm run version:set X.Y.Z` changes them
together. Releasing is described in `RELEASING.md`.

The desktop app reads the Kioku env file named by `KIOKU_ENV_FILE`; debug builds fall back
to the checkout's `.env`.

## Pages

| Route | Page |
| --- | --- |
| `#/library` | Notes of the current area, with type, status, origin and "since" filters in the URL (`kind=decision,design-review`, any type id, `since=YYYY-MM-DD` or `since=last-visit`) |
| `#/note/<domain>/<key>` | One note: body as plain text, links, history, source and findings |
| `#/graph?domain=&focus=` | One semantic zoom from the whole area to a note's neighbourhood |
| `#/health` | Services, counts, drafts and the latest Reflect run |
| `#/reflect` | Reflect findings and settings, in Manual or Automatic mode |
| `#/vaults` | Vaults, one visibility switch per app, reviewed and confirmed before it applies |
| `#/guide/<section>` | Getting started, shortcuts, what's new and updates |

Overlays: ⌘K opens the command palette, ⌘O the search-first area picker. The area button
reads "<area> in <vault>"; picking an area goes through `pickArea()` in `src/app/area.ts`,
which also moves the graph when its URL names another area.

## Folder map

| Path | What lives there |
| --- | --- |
| `src/api/<area>/types.ts` | The contract for one area (app, graph, health, notes, reflect, search, vaults) |
| `src/api/<area>/client.ts` | One async function per backend command |
| `src/api/<area>/mock.ts` | Answers outside Tauri, loaded lazily |
| `src/api/fixtures/` | Sample data the mocks share (personal vault only, plus invented demo notes) |
| `src/api/core.ts`, `index.ts` | The Tauri/mock switch, the one error shape, and the re-exports |
| `src/app/` | App shell, hash router, area store, overlay presence, global shortcuts |
| `src/components/shell/` | Sidebar with views, recent areas and one services line |
| `src/components/ui/` | Shared primitives: Button, Chip, Switch, Dialog, Toast, Icon and more |
| `src/components/palette/`, `src/components/area-switcher/` | Command palette and area picker |
| `src/motion/` | Duration and easing tokens, reduced-motion hook, view transitions |
| `src/pages/<name>/` | One folder per page: library, graph, note, health, reflect, vaults, guide |
| `src/styles/` | `tokens.css` (generated from the design system), `kioku.css` (k-* classes), `base.css` |
| `scripts/version.mjs` | Version check and bump |
| `src-tauri/` | Rust backend; `src/commands/` has one module per area, `src/data/` the reads behind them |

## The contract rule

Each `src/api/<area>/types.ts` and its Rust twin in `src-tauri/src/commands/<area>.rs` must
match. Rust types use `#[serde(rename_all = "camelCase")]`, enums use kebab-case strings,
and `Option<T>` is `T | null`. Command names in `client.ts` (`invoke("list_notes", …)`) match
the `#[tauri::command]` functions registered in `src-tauri/src/lib.rs`. Change both sides,
the fixtures and the mock in the same change. Shared limits are exported from the types:
`MAX_NOTE_LIST` (10,000) and `MAX_SEARCH` (20).

Outside Tauri (`window.__TAURI_INTERNALS__` missing) the client answers from the mocks, so
every page works in a plain browser.

## What it writes

One thing: the vaults file, when you allow a visibility change. On macOS, Allow first asks
for Touch ID, or the Mac password when Touch ID can't be used; agents can ask for access but
can't pass that check. Kioku then re-reads the file (a file that changed meanwhile is left
alone), backs it up under `backups/` beside it, and swaps the new text in whole, as
`scripts/vaults.py` does. Other systems and the browser preview can't confirm, so they stay
read-only. Everything else is read-only: saving Reflect settings, dismissing a finding and
answering an access request return a `read_only` error; `list_access_requests` returns `[]`
and `start_reflect` returns `read_only`. Update checks
report `configured: false` until signing keys exist. Note text is shown as plain text and
links only navigate.

# Notes

A note is one focused fact with a stable key. Agents save notes with
`memory_save`; you can also keep notes as Markdown files and import them. This
page covers the file format, imports, and Open Knowledge Format bundles. For
how to write notes that are easy to find, see
[usage.md](usage.md#writing-notes-that-are-easy-to-find).

- [Markdown notes](#markdown-notes)
- [Importing](#importing)
- [Open Knowledge Format bundles](#open-knowledge-format-bundles)

## Markdown notes

Markdown notes use YAML frontmatter. Editing the file and importing it again
updates the same memory:

```markdown
---
key: jobs-worker
title: Jobs worker owns background indexing
domain: my-project
aliases: [indexing worker, worker de indexação]
related: [local-stack, batch-worker-retirement]
tags: [service, indexing]
paths: [services/jobs-worker/**]
confidence: 0.9
pinned: false
---

The jobs-worker is the current owner of background document indexing.
It replaces the retired batch-worker.
```

- `related` links resolve within the domain by key, then title, then alias;
  `[[wiki links]]` work. Missing or ambiguous references are reported.
- `lock: local` (or a list of providers) limits which models may read the
  note. It takes effect with a vaults file; see [vaults.md](vaults.md). A
  `lock` that lists no provider (`lock: []`, `lock:`), or a near miss such as
  `Lock`, `locks`, or `locked`, fails the file instead of importing the note
  unlocked.
- `paths` anchors the note to the code it governs: globs relative to the
  repository root, one or a list. `*` stays within a folder, `**` spans
  folders, and a bare folder covers everything under it. A file's code map
  entry names the notes anchored to it, and `memory_list` filters by file with
  `path`. An anchor says which code a decision governs; it never describes the
  code.
- Saving a key again replaces its text, but nothing is lost: every save, edit,
  retirement, and restore appends the note's content and status to
  `memory_note_revisions`, and `memory_inspect` lists the ten latest entries.
- Each note must fit the embedding model's context window (about 6 KB of
  English text for `nomic-embed-text`); `memory_save` rejects a longer note
  before anything is saved, with a request to split it.

[`examples/notes`](../examples/notes) holds three example notes in the `demo`
domain.

## Importing

Import with `memory_import` (paths stay inside `MEMORY_NOTES_ROOT`, which
`make start` points at the checkout's `notes/` folder) or with
`kioku ingest --path DIR --domain DOMAIN`.

- A file's path is its provenance; agents can't overwrite file-backed notes
  through `memory_save`. Change the file and import it again.
- A file that can't be imported (unreadable, bad frontmatter, another domain, a
  key another file or source owns, too long to embed) is skipped and listed
  under `failed` with the reason; the other files import. Only when every file
  fails is the import an error, and then nothing is written.
- With vaults, a session's `memory_import` lists only failures of notes it may
  see; the rest are counted in `failed_count` but not named (see
  [vaults.md](vaults.md#what-a-session-sees)).

## Open Knowledge Format bundles

`kioku ingest` reads an
[Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format)
(OKF v0.2) bundle as it is, with no converted copy. A folder whose `index.md`
declares `okf_version` is read as a bundle (`--format okf` forces it):

```sh
kioku ingest --path ~/code/team-kb --domain work/kb
```

- **Keys.** Each concept becomes a note keyed by its concept ID, the file's
  path in the bundle without `.md` (`kb/decisions/ADR-350-cites`). A producer
  `id` and `aliases` become aliases, so `memory_get ADR-350` works. The source
  is the concept's own file, so a re-import after `git pull` re-embeds only
  what changed.
- **Links.** Bundle-relative (`/kb/x.md`) and relative links become `related`
  links. In the stored text a link keeps its words, plus the target's id when
  they lack it. A list item that is only links becomes a list of ids. Links to
  concepts the bundle lacks are kept as words and counted, as the spec asks.
  `index.md` and `log.md` are skipped: the graph replaces them.
- **Long concepts.** A concept over 4,000 bytes becomes a hub note and one note
  per section, keyed `<concept ID>#<anchor>` with GitHub's heading anchor, so a
  link to `/kb/architecture.md#router` reaches the section about the router.
  Sections split at their headings, then by paragraph and table row (tables
  keep their header).
- **Facts line.** A concept's note (or hub) opens with its type and id, its
  lifecycle, the trust tier `verified` gives (unverified, machine-confirmed,
  human-reviewed), `stale_after`, the producer's other plain fields (a
  decision's status and who made it, say), who wrote it, and its `resource`. A
  section opens with a shorter line: type and id, the concept it belongs to,
  lifecycle, trust, and `stale_after`. Trust also sets the note's confidence.
  Profile fields need no setup in Kioku.
- **Lifecycle.** The bundle decides: concepts with `status: deprecated` are
  legacy notes, the rest are active, and a note whose concept or section left
  the bundle (or a bundle moved since its last import) becomes legacy too,
  never deleted. The report's `okf` part counts what was read, and, for the
  lifecycle, `retired` (now deprecated), `restored` (no longer deprecated), and
  `removed` (gone from the bundle).
- **Command line only.** A bundle names no domain of its own, so only the
  command line imports one. `memory_import` refuses a path in a bundle, and a
  Markdown import that meets a bundle inside its folder lists it under
  `failed` instead of reading it.
- **Locks.** `lock` and `pinned` in a concept's frontmatter work as in any
  note, and a link to a locked concept keeps only its author's words, so the
  target's title or id never reaches a note that more providers may read.

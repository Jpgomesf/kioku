# Code map

The code map tells a small model what a source file is for before it reads it:
the file's purpose, its main definitions with line numbers, and up to five
files it imports or that import it. It also names the notes anchored to the
file.

It is a layer of its own, apart from notes: rows in PostgreSQL
(`code_map_repos`, `code_map_files`) with no vectors, so note search never
returns them. Each checkout has its own map, in the domain its folder places
local models in, so vaults and locks apply as they do to notes. Files under a
folder that another vault or area places stay out of it.

```sh
kioku codemap update --repo ~/code/app          # files changed since the last update; all of them the first time
kioku codemap update --repo ~/code/app --full   # parse every file again
kioku codemap show ~/code/app/src/billing.py    # what a model gets for one file
```

- **Parsing** is line-based, for Rust, Python, TypeScript and JavaScript, Go,
  Terraform and HCL, SQL, and shell. A definition is found by how its line
  starts, and imports are resolved to other tracked files, so packages and
  standard modules drop out. Files over 512 KB are left out.
- **Purposes.** A file's doc comment (`//!`, a module docstring, a leading
  comment block) is its purpose. For the rest, `--summarizer <program>` runs a
  program that reads `{"repo": ..., "files": [{"path", "language", "text"}]}`
  on stdin and prints `{"purposes": [{"path", "purpose"}]}`.
  - `--summarizer-arg` passes an argument to it; repeat it for several.
  - `--summarizer-provider` names whose model the program calls. Kioku sends
    it code only from vaults that let that provider read, and never a file that
    looks like it holds a credential.
  - Only one-line purposes for files it asked about are kept.
  - `--summary-limit` (default 50) caps the files per update: files that
    changed come first, then files with no purpose yet.
- **Freshness.** `update` reads files as committed at HEAD, and parses only
  those that changed since the last update. When files were added, deleted, or
  renamed, it parses every file, because other files' imports may now resolve
  differently, and saves only the entries that changed. A lookup parses a file
  again when its working tree differs from what the map describes, and keeps
  its model-written purpose.
- **Keeping it current.** Run `update` after commits, for example from a git
  `post-commit` hook. The kioku-hooks plugin for Claude Code runs it in the
  background after each commit a session makes, with Haiku writing missing
  purposes.
- **Reading it.** The `code_map` tool takes a path, absolute or relative to the
  session's folder. It is outside the core profile (`--tools core,code_map`),
  for clients of small local models, where a plugin can call it when the model
  opens a file. With `code_map` listed, the server's instructions also ask the
  model to call it before reading a source file it hasn't read in the session.
  Without a vaults file, it reads only files inside the session's folder.
- **Anchored notes.** A lookup also names up to ten notes whose `paths` match
  the file: the decisions, conventions, and gotchas that govern it, among the
  notes the caller may read.

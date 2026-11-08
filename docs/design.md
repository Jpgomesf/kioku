# Design

Kioku makes one bet: a few curated, verified notes serve an agent better than
a large store of facts a model extracted on its own. This page explains how
retrieval works, why the storage is PostgreSQL and Qdrant rather than a graph
database, and where the design stops. No decision record covers the storage
choice, so the storage section is the design rationale, with its tradeoffs.

- [How retrieval works](#how-retrieval-works)
- [Why PostgreSQL and Qdrant, not a graph database](#why-postgresql-and-qdrant-not-a-graph-database)
- [Why not let a model build the graph](#why-not-let-a-model-build-the-graph)
- [When a graph database makes sense](#when-a-graph-database-makes-sense)
- [Known limits](#known-limits)
- [Sources](#sources)

## How retrieval works

1. **Signals.** Qdrant returns cosine similarity for current vectors; BM25 runs
   over keys, titles, aliases, tags, and bodies, with accent folding and
   identifiers such as `TW-4290` kept whole. Notes the vector index hasn't
   caught up with still match by keyword. Each server process keeps an index
   of every domain it searches and, per search, checks one row to learn
   whether any process wrote to the domain since; it then reads only the
   notes written after its snapshot. The query is embedded while that check
   runs.
2. **Fusion.** Reciprocal Rank Fusion combines the rankings without calibrating
   their score scales. A note whose key, title, or alias equals the query ranks
   first.
3. **Graph expansion.** Personalized PageRank from the top matches, with a 0.5
   restart probability, fills the last result slot with a linked note, marked
   `linked_from`. It never displaces direct matches.
4. **Lifecycle.** Retention (confidence, feedback, usage, and age) breaks near
   ties. Nothing ages out on its own: maintenance, when you run it, moves stale,
   unpinned notes to a reversible `legacy` status that default search skips.

`memory_get` and context packs then fit the chosen notes into a byte budget,
evidence first ([evaluation.md](evaluation.md#context-packs)). Each step
follows a measurement; [evaluation.md](evaluation.md#what-the-measurements-changed)
says which.

## Why PostgreSQL and Qdrant, not a graph database

### PostgreSQL is the source of truth

Everything that must not be lost lives in PostgreSQL: notes, links, feedback,
usage, lifecycle, the revision history, and the code map.

- **Transactions and constraints.** A key is unique within its domain, a link
  can't point at itself or at a missing note, and a status is `active` or
  `legacy` and nothing else ([`migrations/schema.sql`](../migrations/schema.sql)).
- **History.** Every save, edit, retirement, and restore appends the note's
  content and status to `memory_note_revisions` in the same transaction, so
  overwritten text stays recoverable. Feedback and usage counts live beside
  the note.
- **Many writers, no coordinator.** Each MCP client starts its own
  `kioku serve`. Writes serialize through a PostgreSQL advisory lock, so
  several clients can save at once without a separate process.
- **Plain backups.** A PostgreSQL backup, such as `pg_dump`, is a backup of the
  whole memory.
- **A path for keyword search at scale.** Kioku scores BM25 itself today. When
  domains grow, BM25 can move into a PostgreSQL index:
  [pg_textsearch](https://github.com/timescale/pg_textsearch) (PostgreSQL
  license, generally available since v1.0) or ParadeDB's pg_search
  ([ParadeDB](https://github.com/paradedb/paradedb), AGPL-3.0 community
  edition).

### Qdrant is derived and rebuildable

Qdrant holds vectors, which follow from the notes and the embedding model, and
for keyword search in Qdrant (`MEMORY_LEXICAL=qdrant`) each note's BM25 terms,
exact labels, and lock, which follow from the notes alone. PostgreSQL decides
what a search returns.

- **Losing it loses nothing.** `kioku repair --all` rebuilds the index from
  PostgreSQL.
- **Switching models is safe.** `kioku reindex` embeds every note into a new
  collection, then points the database at it. The old collection stays for
  rollback, and the source of truth is never touched.
- **Filtered nearest-neighbour search** runs in one local container.

pgvector would also work at Kioku's scale, which is hundreds to thousands of
notes per domain. A benchmark by Tiger Data, a Postgres company, used 50
million 768-dimension vectors: pgvector with pgvectorscale led on throughput at
99% recall, and Qdrant led on tail latency and index build time
([Tiger Data, 2025](https://www.tigerdata.com/blog/pgvector-vs-qdrant)). Kioku
is far below that scale, so speed doesn't decide it. Qdrant costs one more
service to run. In exchange, model-specific data stays out of the source of
truth, and a broken or outdated index is disposable.

### The graph is small and curated

- **Links are explicit.** A `related` entry is a link a person or an agent
  wrote on purpose, stored as a row in `memory_edges`.
- **Kioku uses them in-process.** Personalized PageRank from the top matches
  fills the last result slot, and `memory_get` lists each note's links. Neither
  needs a graph engine or a query language.
- **Their measured value is small.** On Kioku's own set, stored links help
  exactly two multi-hop queries: nDCG@5 0.928 with them against 0.919 without,
  and shuffled links help none. With four multi-hop queries, the interval still
  touches zero ([evaluation.md](evaluation.md#graph-contribution)).

What this costs:

- **No graph queries.** You can't ask for "every decision within two hops of
  this service" in a query language. Kioku walks links only to rank results.
- **No bi-temporal facts.** Graphiti tracks when a fact held and when it was
  recorded, and invalidates facts automatically
  ([Graphiti](https://github.com/getzep/graphiti)). Kioku records a change as a
  new note that replaces the old one. The old text stays in the revision
  history, and the old note is retired once you confirm.

## Why not let a model build the graph

Published evaluations of model-built memory and graph retrieval give little
reason to build one for recalling curated facts:

- **Keeping the newer fact.** MemoryAgentBench's FactConsolidation task gives
  pairs of conflicting facts, the newer one last, and asks about the final
  state. On single-hop questions, plain BM25 scored 48.0, Mem0 18.0, and Zep
  7.0. No method passed 28% on the multi-hop version
  ([Hu et al., 2025](https://arxiv.org/abs/2507.05257), Table 3).
- **Fact retrieval.** GraphRAG-Bench found that "basic RAG is comparable to or
  outperforms GraphRAG in simple fact retrieval tasks". Results varied by
  dataset: GraphRAG methods led on its medical set
  ([Xiang et al., 2025](https://arxiv.org/abs/2506.05690)).
- **Questions with no answer.** On MultiHop-RAG's null queries, community
  GraphRAG in global mode scored 19.27% accuracy against plain RAG's 96.01%
  with Llama 3.1-8B, which the authors read as a higher risk of hallucination.
  Only 65.8% (HotpotQA) and 65.5% (NQ) of answer entities appeared in the
  knowledge graphs a model built
  ([Han et al., 2025](https://arxiv.org/abs/2502.11371), Table 2 and
  Section 4.2).
- **Indexing cost.** On MuSiQue's 11,656 passages, Microsoft's GraphRAG used
  115.5M input and 36.1M output tokens to build its index, LightRAG 68.5M input
  tokens, and HippoRAG 2 9.2M. Dense retrieval uses no model tokens
  ([Gutiérrez et al., 2025](https://arxiv.org/abs/2502.14802), Table 12).

These studies measure question answering over documents and conversations, not
coding work, and none of them tests Kioku. They do suggest that the hard part
of memory is keeping facts correct and current. Kioku handles that with
curation and explicit replacement, which need no extraction model.

## When a graph database makes sense

- Entities and relations come from large amounts of text that no one curates.
- Facts have validity windows that queries must respect, such as "what was
  true in March".
- Multi-hop traversal is the main workload, not a supplement to search.

Paths that keep PostgreSQL as the source of truth:

- **[Apache AGE](https://github.com/apache/age),** a PostgreSQL extension that
  adds a graph queried with openCypher, mixed with SQL (Apache-2.0, PostgreSQL
  11 to 18).
- **An embedded graph database beside it.** Kuzu was the usual choice, but its
  repository was archived on 2025-10-10
  ([kuzudb/kuzu](https://github.com/kuzudb/kuzu)), and Graphiti marks its Kuzu
  driver as deprecated.
- **One Postgres for everything.** cognee 1.0 can run its whole memory layer on
  a single Postgres instance; its Postgres graph store is released as a demo
  feature ([cognee](https://github.com/topoteretes/cognee)).

## Known limits

- **The first search in a process reads the whole domain.** Later searches in
  the same process reuse its index, but a hook that starts a server for one
  search pays for building it every time (26 ms at 1,000 notes, 182 ms at
  10,000, 1.8 s at 100,000). A process that indexed 100,000 notes peaked at
  433 MB. Saves, imports, and repair still load whole domains and refuse more
  than 10,000 notes per domain. `MEMORY_LEXICAL=qdrant` removes the
  first-search cost by scoring BM25 in Qdrant, at a few ms per warm search;
  [evaluation.md](evaluation.md#scale) has the measurements.
- **Notes are embedded whole.** Each must fit the embedding model's context
  window. OKF imports split long concepts by section
  ([notes.md](notes.md#open-knowledge-format-bundles)); other notes are
  rejected with a request to split them.
- **Scores can't detect "nothing relevant".** No similarity threshold separates
  answerable from unanswerable queries, so the server never claims that nothing
  matched from a score. The model judges relevance from the snippets
  ([evaluation.md](evaluation.md#what-the-measurements-changed)).
- **Links are untyped.** A `supersedes` link and validity dates would let
  retrieval prefer current facts explicitly
  ([evaluation.md](evaluation.md#known-gaps)).

## Sources

Checked on 2026-11-08.

- Hu, Wang, McAuley. *Evaluating Memory in LLM Agents via Incremental
  Multi-Turn Interactions* (MemoryAgentBench).
  [arXiv:2507.05257](https://arxiv.org/abs/2507.05257).
- Xiang et al. *When to use Graphs in RAG: A Comprehensive Analysis for Graph
  Retrieval-Augmented Generation* (GraphRAG-Bench).
  [arXiv:2506.05690](https://arxiv.org/abs/2506.05690).
- Han et al. *RAG vs. GraphRAG: A Systematic Evaluation and Key Insights*.
  [arXiv:2502.11371](https://arxiv.org/abs/2502.11371).
- Gutiérrez et al. *From RAG to Memory: Non-Parametric Continual Learning for
  Large Language Models* (HippoRAG 2).
  [arXiv:2502.14802](https://arxiv.org/abs/2502.14802).
- Tiger Data. *pgvector vs. Qdrant*, 2025.
  [tigerdata.com](https://www.tigerdata.com/blog/pgvector-vs-qdrant).
- Project pages: [pg_textsearch](https://github.com/timescale/pg_textsearch),
  [ParadeDB](https://github.com/paradedb/paradedb),
  [Apache AGE](https://github.com/apache/age),
  [Kuzu](https://github.com/kuzudb/kuzu),
  [Graphiti](https://github.com/getzep/graphiti),
  [cognee](https://github.com/topoteretes/cognee).

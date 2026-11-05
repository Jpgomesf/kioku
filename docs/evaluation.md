# Evaluation

No test suite can guarantee that an agent gets the best answer from memory.
What evaluation can do is catch regressions before they ship, choose between
options on evidence instead of intuition, and show where the system is still
weak. Kioku evaluates four layers, from cheap and deterministic to expensive
and stochastic.

| Layer | Question | How | When |
|---|---|---|---|
| Contract | Is the tool surface every model sees what we intend? | Snapshot of tools, schemas, descriptions, and instructions, plus a schema lint (`cargo test`) | Every commit |
| Invariants | Does the server keep its promises regardless of model? | Unit tests, PostgreSQL integration tests, and 143 end-to-end checks over stdio (`make smoke`) | Every commit; CI uses a deterministic fake embedder |
| Retrieval | Do the right memories rank first and fit the context budget? | `kioku eval` on graded queries | Weekly in CI with a real model, and before any ranking or model change |
| Behavior | Do models use the tools well? | Server traces scored by [`evals/behavior`](../evals/behavior) | When changing models, prompts, tool descriptions, or serving stacks |

The first two layers run on every pull request. Retrieval runs weekly against
`nomic-embed-text`, with floors slightly under the numbers below. Behavior
checks cost model usage, so they run on demand.

## Retrieval results

The bundled dataset ([`evals/retrieval`](../evals/retrieval)) is 24 fictional
platform-team notes with explicit links, English and Portuguese text, and one
retired runbook, plus 40 graded queries in nine categories. Each category
isolates one capability. All results are at k = 5, measured on 2026-11-02.

### Ranking variants, `nomic-embed-text`

| Variant | Recall@5 | MRR | nDCG@5 | Hit@1 | Packs with the answer |
|---|---|---|---|---|---|
| Previous release: 0.55 cosine + 0.30 PageRank + 0.15 retention | 0.773 | 0.544 | 0.541 | 0.222 | 14/32 |
| Vector only | 0.884 | 0.894 | 0.865 | 0.861 | |
| Hybrid: vector + BM25, RRF | 0.935 | 0.958 | 0.919 | 0.861 | |
| **Hybrid + graph expansion (default)** | **0.958** | **0.958** | **0.928** | **0.861** | **31/32** |

nDCG@5 by category:

| Category (queries) | Vector | Hybrid | Hybrid + graph |
|---|---|---|---|
| cross_lingual (5) | 0.400 | 0.726 | 0.726 |
| distractor (4) | 1.000 | 1.000 | 1.000 |
| exact (4) | 0.982 | 1.000 | 1.000 |
| identifier (6) | 0.866 | 0.958 | 0.958 |
| legacy (1) | 1.000 | 1.000 | 1.000 |
| multi_hop (4) | 0.753 | 0.721 | 0.804 |
| paraphrase (9) | 1.000 | 0.980 | 0.980 |
| supersession (3) | 1.000 | 1.000 | 1.000 |

Per query, the default beats vector-only on 7 queries, loses on 2, and ties
on 27.

### Embedding models, default ranking

| Model | Recall@5 | MRR | nDCG@5 | Hit@1 | Cross-lingual nDCG | Packs with the answer |
|---|---|---|---|---|---|---|
| `nomic-embed-text` (137M, 768-d) | 0.958 | 0.958 | 0.928 | 0.861 | 0.726 | 31/32 |
| `qwen3-embedding:0.6b` (596M, 1024-d) | 1.000 | 1.000 | 0.975 | 0.917 | 1.000 | 32/32 |

Switch an existing install with `kioku reindex`, which keeps the old
collection for rollback.

### What the measurements changed

1. **The previous ranking was worse than plain vector search.** It seeded
   Personalized PageRank with every note above cosine 0.2, which with
   `nomic-embed-text` is nearly every note, so the personalization was nearly
   uniform: PageRank became global PageRank, and a pinned hub note ranked
   first for almost every query (Hit@1 0.22). A Python replica reproduced the
   server's numbers exactly before any change was made.
2. **Lexical matching is not optional.** BM25 fused with Reciprocal Rank
   Fusion fixed identifiers such as `MEDIA_DLQ`, `TW-4290`, and `max_deliver`,
   and, through Portuguese aliases, most cross-lingual queries. With
   `qwen3-embedding`, vector-only identifier nDCG was 0.77, worse than nomic;
   hybrid brought it to 0.98. Both signals are needed whatever the model.
3. **Graph scores should expand results, not reorder them.** Every variant
   tried that let PageRank reorder the list (one-hop boosts, PageRank as an
   RRF list, HippoRAG-style blends) raised multi-hop recall but lost top-rank
   precision: Hit@1 fell to 0.56-0.69. Reserving the last slot for the best
   linked note kept precision and raised multi-hop recall@5 to 1.0.
4. **Priors must stay below the rank gap.** Adjacent RRF ranks differ by about
   1.6%, so a retention weight of 0.15 let pinned or high-confidence notes jump
   over more relevant ones. At 0.05 it only breaks near-ties, and Hit@1 rose
   from 0.806 to 0.861.
5. **The embedding model matters most for multilingual notes.** Portuguese
   queries against English notes, and the reverse, went from 0.73 to 1.0 by
   changing the model alone.
6. **Similarity cannot detect "nothing relevant."** With `nomic-embed-text`,
   unanswerable queries reach cosine 0.68 while some answerable ones top out
   at 0.48; with `qwen3-embedding` the figures are 0.46 and 0.34. No threshold
   separates them, so the server never claims that nothing matched from a
   score. The model judges relevance from the snippets, and the behavior
   checks test that it abstains.

The dataset is small, synthetic, and written by the same person who changed
the ranking, so these numbers can overfit. The changes were chosen to be
principled (RRF and high-restart PageRank come from Cormack et al. 2009,
HippoRAG 2, Zep/Graphiti, and Anthropic's contextual retrieval study), not
tuned to these queries, and per-query results are reported alongside the
averages. Confirm on your own notes before relying on any single number.

## Running the retrieval eval

```sh
make eval                                     # bundled dataset, nomic-embed-text
./bin/kioku eval --format json --output report.json
./bin/kioku eval --embedding-model qwen3-embedding:0.6b --embedding-dim 1024
./bin/kioku eval --dataset evals/demo/dataset.json --k 3    # read-only, your data
```

A dataset with a corpus runs in a database and collection created for the run
(`<database>_eval_<model>`), dropped and rebuilt each time; names must contain
`eval` or `test`, so live memories can't be touched. A dataset without a corpus
searches an existing domain read-only: no imports, no usage counts, no aging.
The report covers recall, MRR, nDCG, macro-averaged nDCG, Hit@1, leaks of
retired notes, latency, per-category scores, per-query rankings, paired
comparisons, context-pack sufficiency, and abstention calibration.
[`evals/README.md`](../evals/README.md) documents the format and how to build
a set from your own questions.

## Context packs

A context pack is the best notes for a query fitted to a byte budget, which is
what a model gets in one call. The eval checks whether each pack holds every
expected fact at 800, 1,500, and 3,000 bytes (`--context-budget`).

The first packer filled the budget with whole notes in rank order and cut the
first one that didn't fit. Two things made that lose facts the ranking had
found. Each note carried about 314 bytes of metadata (a UUID, an absolute
source path, `"status":"active"`), so 1,500 bytes held only two notes. And a
multi-hop question's second note usually ranks low, behind notes that merely
resemble the query.

Packs now spend their budget in three passes. Priority notes (those matched by
both meaning and words, then the notes they link to) first get the sentences
that share a term with the query, or their opening sentence. Then they grow in
order. Only then do the other notes get room. Text that was left out shows as
`…`. Metadata is down to about 180 bytes per note: no UUID (models use keys),
no status unless legacy, and sources relative to `MEMORY_NOTES_ROOT`.

| Budget | Whole notes in rank order | Evidence, depth, then breadth |
|---|---|---|
| 800 bytes | 21/32 | 27/32 |
| 1,500 bytes | 29/32 | 31/32 |
| 3,000 bytes | 30/32 | 31/32 |

No query that passed before fails now. The one left at 1,500 bytes,
`xling-05`, is a retrieval miss: the Portuguese note isn't in the top 8 with
`nomic-embed-text`. With `qwen3-embedding:0.6b` every pack holds its facts at
1,500 bytes.

## Graph contribution

Since links can only fill reserved slots, an overall nDCG gain says little
about whether the links themselves carry information. Each report adds:

- **Ablations.** The default ranking is rerun with the stored links replaced by
  degree-preserving shuffles (directed double edge swaps, 5 seeds) and with
  half of them dropped (5 seeds). If real links don't beat shuffled ones, the
  graph only adds noise.
- **Complete support.** Queries list `required` notes (all hops of a multi-hop
  question); a query counts only when every one reaches the top k.
- **Graph-slot precision.** How many linked results were relevant, against
  what the same positions held without links.
- **Hub exposure.** For each note, how often it appears in results it isn't
  relevant to, divided by the rate a uniform pick would have (k / notes). The
  v0.1.0 ranking let one pinned hub win almost every query; CI now fails above
  3×.
- **Link resolution.** Share of written `related` references that resolve.
- **Intervals.** Every mean has a 95% bootstrap interval (2,000 resamples,
  fixed seed), and comparisons are paired per query. A difference whose
  interval includes zero is reported as within noise.

On the bundled set with `nomic-embed-text` (k = 5):

| links | nDCG@5 (95% CI) | complete support | change vs stored links |
|---|---|---|---|
| stored | 0.928 [0.854, 0.977] | 4/4 | |
| none (`hybrid`) | 0.919 [0.842, 0.973] | 3/4 | −0.009 [−0.026, −0.000] |
| shuffled (5 seeds) | 0.919 [0.842, 0.973] | 75% | −0.009 [−0.026, +0.000] |
| half dropped (5 seeds) | 0.927 [0.854, 0.976] | 95% | −0.001 [−0.005, +0.000] |

Links help exactly two multi-hop queries, and shuffled links help none, so the
signal comes from the real links. With 4 multi-hop queries the interval still
touches zero. The graph slot held 2 relevant notes in 40 results, while the
same positions without links held none. All 38 references resolve. The most
exposed note, `error-codes`, appears in unrelated results at 1.9× the uniform
rate, and slightly more often without links (2.1× for vector only), so its
reach comes from content similarity, not from the graph.

## Reading small samples

- With n queries, one query moves an average by 1/n. Report counts per
  category, and don't read differences in categories with a handful of queries.
- The contract, invariant, and fixed-model retrieval layers are deterministic:
  any change in a rank is real. Gate them on thresholds with a small margin
  for embedding noise across CPUs.
- To decide between two configurations, compare per query (the report's
  better/worse/tied counts) and, for a formal test, use a paired permutation
  test over per-query scores.
- Behavior is stochastic, so run each scenario several times. Wilson 95%
  intervals: 1/1 passes is [0.21, 1.0], 5/5 is [0.57, 1.0], 45/50 is
  [0.79, 0.96]. Report pass^k (passing k times in a row) next to the pass
  rate: an agent at 90% per trial passes five in a row only 59% of the time.
- Zero failures in n trials bounds the true failure rate at about 3/n.

## Known gaps

- Long notes are embedded whole and rejected beyond the model's context
  window; heading-aware chunking would lift that limit.
- Abstention relies on the model. A local reranker (for example
  Qwen3-Reranker through llama.cpp's `--reranking`) could provide a calibrated
  relevance score; add it only if the eval shows a gain.
- Links are untyped. `supersedes` and validity dates, as in Graphiti, would let
  retrieval prefer current facts explicitly.
- Four multi-hop queries can't show a graph gain outside noise. More multi-hop
  questions with `required` sets, ideally from real sessions, are the cheapest
  way to make the graph measurements decisive.
- Search ranks over the whole domain in memory, which is fine for hundreds of
  notes. Measure latency at 1k-10k notes before relying on larger domains.
- The query set should grow with real questions, split into tuning and test
  halves, and include each model's actual search strings from behavior runs.

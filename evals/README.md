# Evaluation data

`kioku eval` scores retrieval against graded queries. See
[docs/evaluation.md](../docs/evaluation.md) for the methodology and current
results.

```sh
make eval                                   # bundled dataset, isolated storage
./bin/kioku --env-file .env eval --dataset evals/demo/dataset.json --k 3
./bin/kioku --env-file .env eval --format json --output report.json
```

## Datasets

| Path | What it is |
|---|---|
| `retrieval/` | 24 fictional platform-team notes and 40 graded queries. Each category isolates one capability: exact labels, identifiers, paraphrase, Portuguese/English, multi-hop links, supersession, legacy history, distractors, and abstention. |
| `demo/` | A read-only example over the `demo` domain created from `examples/notes`. Copy it to evaluate your own notes. |

## Model harnesses

| Path | What it is |
|---|---|
| [`behavior/`](behavior) | Scenarios scored from the server's tool-call trace. It has runners for Claude Code (`run_claude.sh`) and for any OpenAI-compatible endpoint (`run_openai.py`). |
| [`answers/`](answers) | Answer quality over the retrieval questions, with memory and without it: facts, citations, abstention, leakage, and an optional judge for groundedness. |
| `lib/` | The shared MCP stdio client and tool-calling loop. |

They run in isolated storage and write their outputs to `evals/runs/`, which is gitignored.

## Format

`dataset.json`:

```json
{
  "name": "tidewater",
  "description": "What the dataset covers",
  "domain": "tidewater",
  "corpus": "corpus",
  "queries": "queries.jsonl",
  "retire": ["imgproc-runbook"]
}
```

- With `corpus`, the harness imports those Markdown notes into a database and
  Qdrant collection it creates for the run (`<database>_eval_<model>`), then
  retires the keys in `retire`. Your memories are never touched.
- Without `corpus`, it searches the existing `domain` read-only: no imports,
  no access counts, no maintenance.

`queries.jsonl` holds one query per line:

```json
{"id": "hop-01", "category": "multi_hop", "query": "Where do thumbnail jobs end up after failing every delivery attempt?", "relevant": {"dead-letter-policy": 2, "media-queue": 1}, "answer": ["MEDIA_DLQ"]}
```

| Field | Meaning |
|---|---|
| `relevant` | Note keys and grades: 2 answers the question, 1 is useful context. Empty means nothing should answer it (abstention). |
| `answer` | Facts a context pack must contain (case-insensitive), checked at each `--context-budget`. |
| `required` | Notes an answer needs together, such as every hop of a multi-hop question. |
| `include_legacy` | Search retired notes too. |
| `forbidden` | Keys that must not appear in the top k, such as a retired runbook. |

## Evaluating your own notes

Synthetic queries flatter retrieval because they reuse the notes' wording.
The most useful set is built from questions you actually asked:

1. Copy `demo/dataset.json` into `evals/private/` (ignored by git) and set
   `domain` to your project's domain.
2. For each real question, write the query as you asked it and grade the notes
   that answer it. Add a few questions nothing should answer.
3. Run `kioku eval --dataset evals/private/dataset.json` before and after any
   change to the ranking, the embedding model, or your notes.

Look at the per-query rankings in `--output report.json`, not only the
averages: with tens of queries, one query moves an average by a few points.

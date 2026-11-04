# Answer-quality evaluation

Retrieval quality (`kioku eval`) says whether the right notes rank first, and
the [behavior checks](../behavior) say whether a model uses the tools well.
This directory asks what the user sees. Does the final answer state the
facts? Does it cite the notes it read? Do those notes back it up? Does it
abstain when nothing is stored? And how does all that compare with the same
model answering without memory?

## Running

```sh
python3 -I evals/answers/run.py --env-file .env \
  --base-url http://127.0.0.1:8080/v1 --api-key-env LOCAL_API_KEY \
  --trials 3 --judge none
```

- **Questions.** From [`../retrieval/queries.jsonl`](../retrieval/queries.jsonl):
  every query with `answer` facts, plus the abstention queries with no
  relevant notes. That makes 32 answerable questions and 4 with nothing
  stored. The `exact-*` label lookups have no facts, so they are skipped.
- **Storage.** Pass your normal `.env`. The harness writes a copy pointed at
  isolated storage to `OUT/server.env`, mode 0600. The defaults are
  `--database memory_harness_eval --collection local_memory_v1_harness_eval`.
  It recreates that storage with `kioku eval`, which imports the tidewater
  corpus and retires `imgproc-runbook`. `--no-reset` reuses it as it is.
- **`memory` mode.** The model gets Kioku's core tools over MCP, through the
  same agent loop as [`run_openai.py`](../behavior/run_openai.py)
  ([`../lib/agent.py`](../lib/agent.py)). Each answer starts a fresh
  `kioku serve` traced as `memory/<id>/<trial>`. The system prompt is one
  neutral line plus the server's instructions.
- **`baseline` mode.** The same model and the same user prompt, with no tools,
  no server, and only the neutral system line.
- **Prompt.** Both modes ask the model to cite every memory it relies on as
  `[key]`, using a key that is not in the corpus as the example. They also
  ask it to quote facts exactly as the notes state them, and to say plainly
  when nothing relevant is stored.
- **Flags.** `--questions hop-01,none-02` and `--modes memory` narrow a run.
  `--max-turns` (default 8), `--temperature`, and `--timeout` work as in the
  behavior harness.

`OUT` (default `evals/runs/answers-<time>`, gitignored) holds:

- `summary.md`, which compares memory with baseline.
- `results.json`, with config, per-mode summaries, and per-answer rows.
- `transcripts/<mode>-<id>-<trial>.json`, the full chat with tool results.
- `trace.jsonl`, the server trace.
- `answers.jsonl`.
- `retrieval-eval.md`, the reset's retrieval report.

## Deterministic metrics

Answers are compared after lowercasing, NFKC normalization, and removing `*`
and backticks. Runs of whitespace count as one space. `<think>` blocks are
dropped before scoring.

| Metric | Applies to | Passes when |
|---|---|---|
| Fact correctness | answerable | every `answer` fact string appears in the answer |
| Fact recall | answerable | (mean) share of `answer` facts that appear |
| Citation coverage | answerable | the answer cites at least one key |
| Citation validity | answers with citations | every cited key is in `result_keys` of a successful `memory_search` or `memory_get` in that trial's server trace |
| Citation support | answerable, with citations | every `answer` fact appears in at least one cited note. Note texts (title + body) are read through `memory_get` on an untraced server after all trials. |
| Abstention accuracy | no relevant notes | the answer says nothing is stored, cites nothing, and contains no digit |
| Forbidden leakage | queries with `forbidden` | a forbidden key is cited (lower is better) |

**Citation.** A citation is a square-bracket group that is not glued to a
word (`items[key]` is code) and is not a Markdown link (`[text](url)`). It
splits on commas or semicolons. Each item counts when it looks like a key:
lowercase `[a-z0-9._-]`, at least 3 characters, at least one letter.

These forms count:

- `[dead-letter-policy]`
- `[a-note, b-note]`
- `` [`a-note`] ``
- `[key: a-note]`

These do not:

- `[x]`
- `[1]`
- `[MEDIA_DLQ]`
- `[see the note]`

**Abstention.** The marker list is the one `check_trace.py` uses (`no `,
`not `, `nothing`, `don't`, ...) plus `can't`, `cannot`, `unable`, `nenhum`,
and `nada`. Any digit counts as a fabricated specific. That is crude but
predictable: "I found 0 results" fails, and so does "HPA usually targets 70%
CPU". Read the rows before trusting a low score.

**Fact strings.** These are the retrieval dataset's facts, written for
context packs. Some are in the note's language (`3, 5 e 7`, `suspensa`) or
spelled out (`five`), so an answer that translates or rewrites a fact
misses it. The prompt asks the model to quote facts exactly. The per-row
`missing_facts` field shows what was missed.

## Groundedness (judged)

`--judge` picks the judge:

- `--judge none` (the default) skips it.
- `--judge openai:<base_url>:<model>` uses any OpenAI-compatible endpoint, at
  temperature 0. Its key comes from `--judge-api-key-env`, or from
  `--api-key-env` when the base URL matches. The model name may contain
  colons; the URL path may not.
- `--judge claude:<model>` runs `claude -p --model <model> --output-format
  json --tools "" --strict-mcp-config --no-session-persistence` in an empty
  directory, with the prompt on stdin. This spends Claude usage: about one
  call per answer.

The judge sees the question, the answer, and the notes `memory_get` returned
in that trial's transcript. Search snippets do not count; baseline answers
have no notes. It splits the answer into atomic factual claims, skipping
statements about the search itself or about missing information. It labels
each claim supported or unsupported.

The reply must be one JSON object:

```json
{"claims": [{"claim": "MEDIA_DLQ is reviewed at 09:00 UTC", "supported": true, "evidence": "dead-letter-policy"}]}
```

- `supported` must be a JSON boolean. A reply that breaks the schema is
  retried once and then counted as a judge error.
- Groundedness is supported claims divided by claims.
- An answer with no claims, such as a clean abstention, has no groundedness
  and is left out of the mean.

When the judge model is the answering model, the summary marks it as a
**same-family judge**. Models grade their own output leniently, so treat
that number as an upper bound and use a different model family for decisions.

## Reading the report

- Every metric has a 95% interval: Wilson for proportions, and a percentile
  bootstrap of the mean for means (2,000 resamples, fixed seed
  `20261104`, stdlib `random`).
- A metric is computed only over rows where it applies, and `n` says how
  many. With `--trials k > 1`, trials of the same question count as
  independent draws, so the intervals are narrower than they should be.
- The efficiency rows include model calls, tool calls, invalid tool calls,
  tokens (when the API reports them), and wall time per answer.
- The baseline should score near zero on facts and citations and high on
  abstention. If it answers tidewater questions correctly, the questions
  leak their answers.
- Compare configurations on the same questions and trial counts, and read the
  "Misses" list, not only the averages.

## Tests

```sh
python3 -I evals/answers/test_metrics.py
```

These tests cover the deterministic metrics, citation parsing, judge-reply
and Claude-envelope parsing, judge specs, intervals, and the agent loop's
argument parsing. They use small fixtures, with no services and no model
calls.

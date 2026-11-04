#!/usr/bin/env python3
"""Answer-quality evaluation: with Kioku's core tools (`memory`) and without
any tools (`baseline`), does a model answer correctly, cite what it read, and
abstain when nothing is stored?

    python3 -I evals/answers/run.py --env-file .env \\
        --base-url http://127.0.0.1:8080/v1 [--model NAME] [--api-key-env VAR] \\
        [--trials 1] [--judge none | openai:<base_url>:<model> | claude:<model>]

Questions come from evals/retrieval/queries.jsonl: every query with `answer`
facts plus the abstention queries (no relevant notes). The harness writes an
env copy pointed at isolated storage to OUT/server.env (mode 0600), recreates
that storage with `kioku eval` (the tidewater corpus), runs every question in
both modes, reads the cited notes back through `memory_get`, scores, and
optionally asks a judge for groundedness. See README.md. Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "lib"))
sys.path.insert(0, str(HERE))

import agent  # noqa: E402
import metrics  # noqa: E402

PROMPT = """Question about the {domain} project: {query}

Answer briefly from the project's stored memory. Cite the key of every memory you rely on in square brackets, for example [webhook-retries]. Quote names, numbers, commands, and times exactly as the notes state them. If nothing relevant is stored, say so plainly and do not guess."""

MODES = ("memory", "baseline")


def load_questions(path: Path, wanted: list[str] | None) -> list[dict]:
    questions = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        query = json.loads(line)
        if query.get("answer") or not query.get("relevant"):
            questions.append(query)
    if wanted:
        unknown = set(wanted) - {q["id"] for q in questions}
        if unknown:
            raise agent.HarnessError(f"unknown or unscored questions: {', '.join(sorted(unknown))}")
        questions = [q for q in questions if q["id"] in wanted]
    return questions


def read_trace(path: Path) -> dict[str, list[dict]]:
    runs: dict[str, list[dict]] = defaultdict(list)
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            record = json.loads(line)
            runs[str(record.get("run"))].append(record)
    for calls in runs.values():
        calls.sort(key=lambda c: c.get("ts", ""))
    return runs


def fetch_notes(binary: Path, server_env: Path, keys: set[str], domain: str, timeout: float) -> dict[str, str]:
    """Title and text of each cited key that exists, read through memory_get
    on an untraced server after all trials."""
    notes: dict[str, str] = {}
    if not keys:
        return notes
    mcp = agent.McpClient(binary, server_env, tools="core", timeout=timeout, client_name="kioku-answers-postpass")
    try:
        mcp.initialize()

        def read(batch: list[str]) -> bool:
            text, is_error = mcp.call_tool("memory_get", {"keys": batch, "domain": domain, "max_bytes": 8000})
            if is_error:  # none of the keys exists
                return False
            try:
                truncated = bool(json.loads(text).get("truncated"))
            except (ValueError, AttributeError):
                return False
            if truncated and len(batch) > 1:
                return True
            for key, body in metrics.retrieved_notes([{"name": "memory_get", "is_error": False, "result": text}]):
                notes[key] = body
            return False

        pending = sorted(keys)
        for start in range(0, len(pending), 10):
            batch = pending[start:start + 10]
            if read(batch):
                for key in batch:
                    read([key])
    finally:
        mcp.close()
    return notes


def make_judge(spec: dict, args: argparse.Namespace, out: Path):
    """A callable prompt -> (reply text, details), or None for --judge none."""
    if spec["kind"] == "none":
        return None
    if spec["kind"] == "openai":
        same_endpoint = spec["base_url"].rstrip("/") == args.base_url.rstrip("/")
        key_env = args.judge_api_key_env or (args.api_key_env if same_endpoint else None)
        client = agent.ChatClient(spec["base_url"], spec["model"], agent.api_key_from(key_env), args.timeout)

        def call_openai(prompt: str) -> tuple[str, dict]:
            response = client.complete([{"role": "system", "content": metrics.JUDGE_SYSTEM},
                                        {"role": "user", "content": prompt}], temperature=0)
            message = response["choices"][0].get("message") or {}
            return agent.message_text(message.get("content")), {"usage": response.get("usage")}
        return call_openai
    workdir = out / "judge-workspace"  # empty, so no project instructions load
    workdir.mkdir(exist_ok=True)

    def call_claude(prompt: str) -> tuple[str, dict]:
        result = subprocess.run(metrics.claude_judge_command(spec["model"]), input=prompt, capture_output=True,
                                text=True, cwd=workdir, timeout=args.timeout)
        if result.returncode != 0 and not result.stdout.strip():
            raise metrics.JudgeError(f"claude exited with {result.returncode}")
        return metrics.parse_claude_envelope(result.stdout)
    return call_claude


def judge_answer(judge, prompt: str) -> tuple[list[dict] | None, str | None, dict]:
    """Claims from the judge, retried once when the reply is unusable."""
    error, raw = None, ""
    for _ in range(2):
        try:
            raw, details = judge(prompt)
            return metrics.parse_judge_response(raw), None, {**details, "raw": raw[:4000]}
        except (metrics.JudgeError, agent.ChatError, subprocess.TimeoutExpired, OSError) as failure:
            error = f"{type(failure).__name__}: {failure}"[:300]
    return None, error, {"raw": raw[:4000]}


def cell(entry: dict, kind: str, name: str) -> str:
    if not entry or entry.get("value") is None:
        return "n/a"
    low, high = entry["ci95"]
    if kind == "proportion":
        return f"{entry['value']:.3f} [{low:.2f}, {high:.2f}] ({entry['passed']}/{entry['n']})"
    digits = 0 if name.endswith("_tokens") else 2
    return f"{entry['value']:.{digits}f} [{low:.{digits}f}, {high:.{digits}f}] (n={entry['n']})"


def render_markdown(config: dict, summaries: dict, rows: list[dict], questions: list[dict]) -> str:
    modes = [m for m in MODES if m in summaries]
    answerable = sum(1 for q in questions if q.get("answer"))
    temperature = config["temperature"] if config["temperature"] is not None else "endpoint default"
    lines = [
        "# Answer quality: memory vs baseline", "",
        f"- Model `{config['model']}` at `{config['base_url']}`, temperature {temperature}, "
        f"max {config['max_turns']} model calls per answer.",
        f"- {len(questions)} questions ({answerable} answerable, {len(questions) - answerable} with nothing stored) "
        f"x {config['trials']} trial(s). `memory`: Kioku `{config['tools']}` tools over MCP; "
        "`baseline`: same model and prompt, no tools.",
        f"- Judge: `{config['judge']}`" + (f" -- **{config['judge_note']}**" if config.get("judge_note") else "") + ".",
        "- Intervals are 95%: Wilson for proportions, a seeded bootstrap of the mean for means. "
        "Trials of one question count as independent draws, so with k > 1 the intervals are optimistic.", "",
        "| Metric | " + " | ".join(modes) + " |",
        "|---|" + "---|" * len(modes),
    ]
    for name, kind, label in metrics.METRICS:
        lines.append(f"| {label} | " + " | ".join(cell(summaries[m].get(name), kind, name) for m in modes) + " |")
    lines.append("| Invalid tool calls (total) | " + " | ".join(str(summaries[m]["invalid_calls_total"]) for m in modes) + " |")
    lines.append("| Harness or API errors | " + " | ".join(str(summaries[m]["errors"]) for m in modes) + " |")
    if config["judge"] != "none":
        lines.append("| Judge errors | " + " | ".join(str(summaries[m]["judge_errors"]) for m in modes) + " |")

    categories = sorted({q["category"] for q in questions if q.get("answer")})
    lines += ["", "## Fact correctness by category", "",
              "| Category | " + " | ".join(modes) + " |", "|---|" + "---|" * len(modes)]
    for category in categories:
        cells = []
        for mode in modes:
            mine = [r for r in rows if r["mode"] == mode and r["category"] == category and r.get("fact_correct") is not None]
            cells.append(f"{sum(r['fact_correct'] for r in mine)}/{len(mine)}")
        lines.append(f"| {category} | " + " | ".join(cells) + " |")

    lines += ["", "## Misses", ""]
    for row in rows:
        problems = []
        if row.get("error"):
            problems.append(f"{row['stop_reason']}: {row['error'][:120]}")
        if row.get("missing_facts"):
            problems.append("missing " + ", ".join(f"`{f}`" for f in row["missing_facts"]))
        if row.get("invalid_citations"):
            problems.append("cited unretrieved " + ", ".join(f"`{k}`" for k in row["invalid_citations"]))
        if row.get("unsupported_facts"):
            problems.append("cited notes lack " + ", ".join(f"`{f}`" for f in row["unsupported_facts"]))
        if row.get("abstained") is False:
            problems.append("did not abstain cleanly")
        if row.get("forbidden_leak"):
            problems.append("cited forbidden " + ", ".join(f"`{k}`" for k in row["leaked"]))
        if row.get("groundedness") is not None and row["groundedness"] < 1:
            problems.append(f"groundedness {row['groundedness']:.2f}")
        if row.get("invalid_calls"):
            problems.append(f"{row['invalid_calls']} invalid tool call(s)")
        if problems:
            lines.append(f"- {row['mode']} `{row['question']}`#{row['trial']}: " + "; ".join(problems))
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", required=True, help="OpenAI-compatible API root, e.g. http://127.0.0.1:8080/v1")
    parser.add_argument("--model", help="model name (default: the endpoint's only model)")
    parser.add_argument("--api-key-env", help="environment variable holding the API key (default: no key)")
    parser.add_argument("--trials", type=int, default=1, help="trials per question and mode (default 1)")
    parser.add_argument("--questions", help="comma-separated query ids (default: all scored ones)")
    parser.add_argument("--modes", default="memory,baseline", help="memory, baseline, or both (default)")
    parser.add_argument("--judge", default="none", help="none, openai:<base_url>:<model>, or claude:<model>")
    parser.add_argument("--judge-api-key-env", help="API key variable for an openai judge (default: --api-key-env "
                                                     "when the judge uses the same base URL)")
    parser.add_argument("--out", type=Path, help="output directory (default evals/runs/answers-<time>)")
    parser.add_argument("--temperature", type=float, help="sampling temperature (default: the endpoint's)")
    parser.add_argument("--max-turns", type=int, default=8, help="model calls per answer (default 8)")
    parser.add_argument("--timeout", type=float, default=300.0, help="seconds per model, judge, or MCP request")
    parser.add_argument("--env-file", type=Path, required=True, help="Kioku env file to derive the isolated one from")
    parser.add_argument("--binary", type=Path, default=agent.DEFAULT_BINARY)
    parser.add_argument("--tools", default="core", help="MEMORY_TOOLS for the memory mode (default core)")
    parser.add_argument("--database", default=agent.DEFAULT_DATABASE)
    parser.add_argument("--collection", default=agent.DEFAULT_COLLECTION)
    parser.add_argument("--no-reset", action="store_true", help="reuse the isolated storage as it is")
    parser.add_argument("--dataset", type=Path, default=agent.ROOT / "evals" / "retrieval" / "dataset.json")
    args = parser.parse_args()

    try:
        if args.trials < 1 or args.max_turns < 1 or args.timeout <= 0:
            raise agent.HarnessError("--trials, --max-turns, and --timeout must be positive")
        modes = [m.strip() for m in args.modes.split(",") if m.strip()]
        if not modes or set(modes) - set(MODES):
            raise agent.HarnessError("--modes takes memory, baseline, or memory,baseline")
        judge_spec = metrics.parse_judge_spec(args.judge)
        binary = agent.check_binary(args.binary)
        env_file = args.env_file.resolve(strict=True)
        dataset = json.loads(args.dataset.read_text(encoding="utf-8"))
        domain = dataset["domain"]
        questions = load_questions(args.dataset.parent / dataset.get("queries", "queries.jsonl"),
                                   [q.strip() for q in args.questions.split(",")] if args.questions else None)
        api_key = agent.api_key_from(args.api_key_env)
        model = agent.resolve_model(args.base_url, args.model, api_key)
        out = agent.new_run_dir("answers", args.out)
        judge = make_judge(judge_spec, args, out)
        server_env = agent.derive_env(env_file, out / "server.env", args.database, args.collection)
        if not args.no_reset and "memory" in modes:
            print(f"resetting {args.database} / {args.collection} with the {domain} corpus", flush=True)
            agent.reset_storage(binary, env_file, server_env, out, database=args.database,
                                collection=args.collection, domain=domain)
    except (agent.HarnessError, agent.ChatError, OSError, ValueError, KeyError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    judge_note = None
    if judge_spec["kind"] == "openai" and judge_spec["model"] == model:
        judge_note = "same-family judge: the answering model grades its own answers, so expect leniency"
    config = {
        "base_url": args.base_url, "model": model, "trials": args.trials, "modes": modes,
        "temperature": args.temperature, "max_turns": args.max_turns, "tools": args.tools, "domain": domain,
        "database": args.database, "collection": args.collection, "judge": args.judge, "judge_note": judge_note,
        "prompt": PROMPT, "system": agent.NEUTRAL_SYSTEM, "started": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "bootstrap": {"seed": metrics.BOOTSTRAP_SEED, "resamples": metrics.BOOTSTRAP_RESAMPLES},
    }
    trace = out / "trace.jsonl"
    answers_path = out / "answers.jsonl"
    for path in (trace, answers_path):
        agent.write_private(path, "")
    transcripts = out / "transcripts"
    transcripts.mkdir(exist_ok=True)
    chat = agent.ChatClient(args.base_url, model, api_key, args.timeout)
    total = len(questions) * len(modes) * args.trials
    print(f"model {model}; {len(questions)} questions x {len(modes)} modes x {args.trials} trials -> {out}", flush=True)

    records = []
    streak = agent.ApiErrorStreak()
    for trial in range(1, args.trials + 1):
        for question in questions:
            for mode in modes:
                if streak.count >= streak.limit:
                    break
                label = f"{mode}/{question['id']}/{trial}"
                prompt = PROMPT.format(domain=domain, query=question["query"])
                record = agent.run_mcp_trial(
                    chat, binary, server_env, prompt, tools_profile=args.tools, trace_file=trace, run=label,
                    timeout=args.timeout, max_turns=args.max_turns, temperature=args.temperature,
                    use_tools=mode == "memory")
                records.append((label, mode, question, trial, record))
                (transcripts / f"{mode}-{question['id']}-{trial}.json").write_text(json.dumps(
                    {"run": label, "model": model, "prompt": prompt, **record}, indent=2, ensure_ascii=False),
                    encoding="utf-8")
                with answers_path.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps({"run": label, "answer": record["answer"]}, ensure_ascii=False) + "\n")
                note = f" [{record['stop_reason']}: {record['error'][:80]}]" if record["error"] else ""
                print(f"  [{len(records)}/{total}] {label:28s} turns {record['turns']}  calls "
                      f"{len(record['tool_calls'])}  invalid {len(record['invalid_calls'])}  {record['wall_s']:.1f}s{note}",
                      flush=True)
                if streak.tripped(record):
                    print(f"stopping: {streak.limit} answers in a row failed at the chat endpoint; "
                          "scoring what ran", file=sys.stderr)

    cited = {key for *_, record in records for key in metrics.citations(record["answer"])}
    try:
        notes = fetch_notes(binary, server_env, cited, domain, args.timeout)
    except agent.HarnessError as error:
        print(f"warning: cannot read cited notes ({error}); citation support is unscored", file=sys.stderr)
        notes = {}
    traced = read_trace(trace)

    rows = []
    for index, (label, mode, question, trial, record) in enumerate(records, 1):
        row = {"run": label, "mode": mode, "question": question["id"], "category": question["category"],
               "trial": trial, "answer": record["answer"], **agent.trial_metrics(record),
               **metrics.score_answer(question, record["answer"], metrics.seen_keys(traced.get(label, [])), notes)}
        if judge is not None and record["answer"]:
            retrieved = metrics.retrieved_notes(record["tool_calls"])
            claims, error, details = judge_answer(
                judge, metrics.judge_prompt(question["query"], record["answer"], retrieved))
            row.update(claims=claims, judge_error=error, judge_details=details,
                       groundedness=metrics.groundedness(claims) if claims is not None else None)
            shown = "error" if error else ("no claims" if row["groundedness"] is None else f"{row['groundedness']:.2f}")
            print(f"  judged [{index}/{len(records)}] {label}: {shown}", flush=True)
        rows.append(row)

    summaries = {mode: metrics.summarize([r for r in rows if r["mode"] == mode]) for mode in modes}
    (out / "results.json").write_text(json.dumps({"config": config, "summary": summaries, "rows": rows},
                                                 indent=2, ensure_ascii=False), encoding="utf-8")
    markdown = render_markdown(config, summaries, rows, questions)
    (out / "summary.md").write_text(markdown, encoding="utf-8")
    print()
    print(markdown)
    print(f"results: {out / 'results.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

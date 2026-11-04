#!/usr/bin/env python3
"""Run the behavior scenarios against any OpenAI-compatible chat endpoint,
with Kioku as a real MCP stdio server, then score the server trace.

    python3 -I evals/behavior/run_openai.py --env-file .env \\
        --base-url http://127.0.0.1:8080/v1 [--model NAME] [--api-key-env VAR] [--trials 5]

`--env-file` is your normal Kioku env file. The harness writes a copy pointed
at isolated storage (`--database`/`--collection`, default memory_harness_eval
and local_memory_v1_harness_eval) to OUT/server.env with mode 0600, recreates
that storage with `kioku eval` (the tidewater corpus), and ingests
evals/behavior/seed, as run_claude.sh does. Each trial starts a fresh
`kioku serve` with MEMORY_TRACE_RUN=<scenario>/<trial>; the server's
instructions from `initialize` are the system prompt, after one neutral line.

OUT gets trace.jsonl, answers.jsonl ({"run", "answer"} per trial, as
run_claude.sh writes), one <scenario>-<trial>.json transcript per trial,
metrics.jsonl, and check.json. Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "lib"))

import agent  # noqa: E402


def mean(values: list) -> float | None:
    values = [v for v in values if v is not None]
    return sum(values) / len(values) if values else None


def fmt(value: float | None, digits: int = 1) -> str:
    return "-" if value is None else f"{value:.{digits}f}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", required=True, help="OpenAI-compatible API root, e.g. http://127.0.0.1:8080/v1")
    parser.add_argument("--model", help="model name (default: the endpoint's only model)")
    parser.add_argument("--api-key-env", help="environment variable holding the API key (default: no key)")
    parser.add_argument("--trials", type=int, default=5, help="trials per scenario (default 5)")
    parser.add_argument("--scenarios", help="comma-separated scenario ids (default: all)")
    parser.add_argument("--out", type=Path, help="output directory (default evals/runs/behavior-openai-<time>)")
    parser.add_argument("--temperature", type=float, help="sampling temperature (default: the endpoint's)")
    parser.add_argument("--max-turns", type=int, default=15, help="model calls per trial (default 15)")
    parser.add_argument("--timeout", type=float, default=300.0, help="seconds per model or MCP request (default 300)")
    parser.add_argument("--env-file", type=Path, required=True, help="Kioku env file to derive the isolated one from")
    parser.add_argument("--binary", type=Path, default=agent.DEFAULT_BINARY)
    parser.add_argument("--tools", default="core", help="MEMORY_TOOLS for the server (default core)")
    parser.add_argument("--database", default=agent.DEFAULT_DATABASE)
    parser.add_argument("--collection", default=agent.DEFAULT_COLLECTION)
    parser.add_argument("--no-reset", action="store_true", help="reuse the isolated storage as it is")
    parser.add_argument("--scenario-file", type=Path, default=HERE / "scenarios.json")
    args = parser.parse_args()

    try:
        if args.trials < 1 or args.max_turns < 1 or args.timeout <= 0:
            raise agent.HarnessError("--trials, --max-turns, and --timeout must be positive")
        binary = agent.check_binary(args.binary)
        env_file = args.env_file.resolve(strict=True)
        spec = json.loads(args.scenario_file.read_text(encoding="utf-8"))
        scenarios = spec["scenarios"]
        if args.scenarios:
            wanted = [s.strip() for s in args.scenarios.split(",") if s.strip()]
            unknown = set(wanted) - {s["id"] for s in scenarios}
            if unknown:
                raise agent.HarnessError(f"unknown scenarios: {', '.join(sorted(unknown))}")
            scenarios = [s for s in scenarios if s["id"] in wanted]
        chosen = {s["id"] for s in scenarios}
        for scenario in scenarios:
            if scenario.get("after") and scenario["after"] not in chosen:
                print(f"warning: {scenario['id']} expects {scenario['after']} to run first in each trial", file=sys.stderr)
        api_key = agent.api_key_from(args.api_key_env)
        model = agent.resolve_model(args.base_url, args.model, api_key)
        out = agent.new_run_dir("behavior-openai", args.out)
        server_env = agent.derive_env(env_file, out / "server.env", args.database, args.collection)
        if not args.no_reset:
            print(f"resetting {args.database} / {args.collection} with the tidewater corpus and seed notes", flush=True)
            agent.reset_storage(binary, env_file, server_env, out, database=args.database,
                                collection=args.collection, domain=spec["domain"],
                                extra_paths=(agent.ROOT / "evals" / "behavior" / "seed",))
    except (agent.HarnessError, agent.ChatError, OSError, ValueError, KeyError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    trace = out / "trace.jsonl"
    answers = out / "answers.jsonl"
    metrics_path = out / "metrics.jsonl"
    for path in (trace, answers, metrics_path):
        agent.write_private(path, "")
    chat = agent.ChatClient(args.base_url, model, api_key, args.timeout)
    print(f"model {model} at {args.base_url}; {len(scenarios)} scenarios x {args.trials} trials -> {out}", flush=True)

    rows = []
    streak = agent.ApiErrorStreak()
    for trial in range(1, args.trials + 1):
        if streak.count >= streak.limit:
            break
        for scenario in scenarios:
            run = f"{scenario['id']}/{trial}"
            record = agent.run_mcp_trial(
                chat, binary, server_env, scenario["prompt"], tools_profile=args.tools, trace_file=trace,
                run=run, timeout=args.timeout, max_turns=args.max_turns, temperature=args.temperature)
            metrics = {"run": run, **agent.trial_metrics(record)}
            rows.append(metrics)
            (out / f"{scenario['id']}-{trial}.json").write_text(json.dumps(
                {"run": run, "model": model, "prompt": scenario["prompt"], "metrics": metrics, **record},
                indent=2, ensure_ascii=False), encoding="utf-8")
            with answers.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps({"run": run, "answer": record["answer"]}, ensure_ascii=False) + "\n")
            with metrics_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(metrics, ensure_ascii=False) + "\n")
            tools = ",".join(c["name"] for c in record["tool_calls"]) or "-"
            note = f" [{record['stop_reason']}: {record['error']}]" if record["error"] else ""
            print(f"  {run:16s} turns {metrics['turns']:2d}  calls {tools}  invalid {metrics['invalid_calls']}  "
                  f"{metrics['wall_s']:.1f}s{note}", flush=True)
            if streak.tripped(record):
                print(f"stopping: {streak.limit} trials in a row failed at the chat endpoint", file=sys.stderr)
                break

    print(f"\n{'scenario':14s} {'trials':>6s} {'turns':>6s} {'calls':>6s} {'invalid':>7s} "
          f"{'prompt tok':>10s} {'compl tok':>9s} {'wall s':>7s}")
    for scenario in scenarios:
        mine = [r for r in rows if r["run"].split("/")[0] == scenario["id"]]
        print(f"{scenario['id']:14s} {len(mine):>6d} {fmt(mean([r['turns'] for r in mine])):>6s} "
              f"{fmt(mean([r['tool_calls'] for r in mine])):>6s} {sum(r['invalid_calls'] for r in mine):>7d} "
              f"{fmt(mean([r['prompt_tokens'] for r in mine]), 0):>10s} "
              f"{fmt(mean([r['completion_tokens'] for r in mine]), 0):>9s} {fmt(mean([r['wall_s'] for r in mine])):>7s}")
    invalid = sum(r["invalid_calls"] for r in rows)
    attempted = invalid + sum(r["tool_calls"] for r in rows)
    failed = [r["run"] for r in rows if r["error"]]
    print(f"invalid tool calls: {invalid} of {attempted} attempted"
          + (f"; trials with harness/API errors: {', '.join(failed)}" if failed else ""))

    checker = [sys.executable, "-I", str(HERE / "check_trace.py"), str(trace), "--answers", str(answers),
               "--scenarios", str(args.scenario_file)]
    report = subprocess.run(checker + ["--json"], capture_output=True, text=True)
    (out / "check.json").write_text(report.stdout, encoding="utf-8")
    print(flush=True)
    return subprocess.run(checker).returncode


if __name__ == "__main__":
    raise SystemExit(main())

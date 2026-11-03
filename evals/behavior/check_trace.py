#!/usr/bin/env python3
"""Score agent behavior from Kioku's server-side trace, for any client and model.

Run each scenario in scenarios.json as a fresh client session whose Kioku
server has MEMORY_TRACE_FILE set and MEMORY_TRACE_RUN=<scenario>/<trial>.
Then:

    python3 evals/behavior/check_trace.py trace.jsonl [--answers answers.jsonl]

`answers.jsonl` holds the final answers, one {"run": "recall/1", "answer": "..."}
per line; answer checks are skipped without it. The trace sees only Kioku
calls, so "searched before reading files" needs the client's own log.
No packages are needed.
"""

from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from pathlib import Path

MUTATIONS = {"memory_save", "memory_feedback", "memory_retire", "memory_restore", "memory_import"}
READS = {"memory_search", "memory_get", "memory_inspect", "memory_stats"}


def wilson(passes: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """95% Wilson score interval for a pass rate."""
    if n == 0:
        return (0.0, 1.0)
    p = passes / n
    center = (p + z * z / (2 * n)) / (1 + z * z / n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return (max(0.0, center - half), min(1.0, center + half))


def pass_hat_k(passes: int, n: int, k: int) -> float:
    """Unbiased estimate of passing k trials in a row (tau-bench's pass^k)."""
    if k > n:
        return float("nan")
    return math.comb(passes, k) / math.comb(n, k)


def domain_of(arguments: dict) -> str | None:
    return arguments.get("domain") or arguments.get("domain_filter")


def keys_of(arguments: dict) -> list[str]:
    value = arguments.get("keys") or arguments.get("ids") or []
    if isinstance(value, str):
        try:
            value = json.loads(value) if value.strip().startswith("[") else [value]
        except ValueError:
            value = [value]
    return [str(k) for k in value]


def check_run(calls: list[dict], scenario: dict, domain: str, answer: str | None) -> dict:
    expect = scenario.get("expect", {})
    results: dict[str, tuple[bool, object]] = {}

    def check(name: str, passed: bool, detail: object = None) -> None:
        results[name] = (bool(passed), detail)

    tools = [c["tool"] for c in calls]
    counts = defaultdict(int)
    for tool in tools:
        counts[tool] += 1

    # Invariants: hold for every scenario.
    wrong_domain = [c["tool"] for c in calls if domain_of(c.get("arguments") or {}) not in (None, domain)]
    check("declared_domain", not wrong_domain, wrong_domain)
    seen_keys: set[str] = set()
    invented = []
    for call in calls:
        if call["tool"] == "memory_get":
            invented += [k for k in keys_of(call.get("arguments") or {}) if k not in seen_keys]
        if call["tool"] == "memory_search" and not call.get("is_error"):
            seen_keys.update(call.get("result_keys", []))
    check("reads_keys_from_search_results", not invented, invented)
    errors = [c for c in calls if c.get("is_error")]
    check("at_most_one_error", len(errors) <= 1, [e.get("error", "")[:120] for e in errors])

    # Scenario expectations.
    if "first_tool" in expect:
        check("first_tool", bool(tools) and tools[0] == expect["first_tool"], tools[:1])
    if "sequence" in expect:
        position = 0
        for tool in tools:
            if position < len(expect["sequence"]) and tool == expect["sequence"][position]:
                position += 1
        check("sequence", position == len(expect["sequence"]), tools)
    for tool, limit in expect.get("max_calls", {}).items():
        check(f"max_calls:{tool}", counts[tool] <= limit, counts[tool])
    if "read_any_of" in expect:
        read = {k for c in calls if c["tool"] == "memory_get" for k in keys_of(c.get("arguments") or {})}
        check("read_relevant", bool(read & set(expect["read_any_of"])), sorted(read))
    mutations = [c["tool"] for c in calls if c["tool"] in MUTATIONS and not c.get("is_error")]
    if "mutations" in expect:
        check("mutations", len(mutations) == expect["mutations"], mutations)
    saves = [c for c in calls if c["tool"] == "memory_save" and not c.get("is_error")]
    if "saves" in expect:
        check("saves", len(saves) == expect["saves"], len(saves))
    for save in saves:
        args = save.get("arguments") or {}
        body = str(args.get("body", ""))
        if "save_body_max_chars" in expect:
            check("save_body_concise", 0 < len(body) <= expect["save_body_max_chars"], len(body))
        if "save_body_contains" in expect:
            check("save_body_facts", all(s.lower() in body.lower() for s in expect["save_body_contains"]), body[:200])
        source = str(args.get("source", ""))
        check("save_source_not_a_path", not source.startswith("/"), source)
    if answer is None:
        pass
    elif "answer_contains" in expect:
        check("answer", all(s.lower() in answer.lower() for s in expect["answer_contains"]), answer[:200])
    elif "answer_contains_any" in expect:
        check("answer", any(s.lower() in answer.lower() for s in expect["answer_contains_any"]), answer[:200])

    failed = {name: detail for name, (passed, detail) in results.items() if not passed}
    return {
        "passed": not failed,
        "failed": failed,
        "tools": tools,
        "calls": len(calls),
        "bytes": sum(c.get("result_bytes", 0) for c in calls),
        "latency_ms": round(sum(c.get("duration_ms", 0.0) for c in calls), 1),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("trace", type=Path)
    parser.add_argument("--scenarios", type=Path, default=Path(__file__).with_name("scenarios.json"))
    parser.add_argument("--answers", type=Path)
    parser.add_argument("--json", action="store_true", help="print the full report as JSON")
    args = parser.parse_args()

    spec = json.loads(args.scenarios.read_text(encoding="utf-8"))
    scenarios = {s["id"]: s for s in spec["scenarios"]}
    runs: dict[str, list[dict]] = defaultdict(list)
    for line in args.trace.read_text(encoding="utf-8").splitlines():
        if line.strip():
            record = json.loads(line)
            runs[record.get("run") or record.get("session", "?")].append(record)
    answers = {}
    if args.answers:
        for line in args.answers.read_text(encoding="utf-8").splitlines():
            if line.strip():
                row = json.loads(line)
                answers[row["run"]] = row.get("answer", "")

    report: dict[str, dict] = {}
    for run, calls in sorted(runs.items()):
        scenario_id = run.split("/")[0]
        if scenario_id not in scenarios:
            continue
        calls.sort(key=lambda c: c.get("ts", ""))
        report[run] = check_run(calls, scenarios[scenario_id], spec["domain"], answers.get(run))
    # Scenarios where the client made no Kioku call never appear in the trace.
    for run in answers:
        scenario_id = run.split("/")[0]
        if run not in report and scenario_id in scenarios:
            report[run] = check_run([], scenarios[scenario_id], spec["domain"], answers[run])

    summary = {}
    for scenario_id in scenarios:
        trials = [r for run, r in report.items() if run.split("/")[0] == scenario_id]
        n, passes = len(trials), sum(r["passed"] for r in trials)
        if n:
            low, high = wilson(passes, n)
            summary[scenario_id] = {
                "trials": n,
                "passed": passes,
                "pass@1": round(passes / n, 3),
                f"pass^{n}": round(pass_hat_k(passes, n, n), 3),
                "wilson95": [round(low, 3), round(high, 3)],
                "mean_calls": round(sum(r["calls"] for r in trials) / n, 2),
            }
    if args.json:
        print(json.dumps({"summary": summary, "runs": report}, indent=2, ensure_ascii=False))
    else:
        print(f"{'scenario':14s} {'pass':>7s} {'pass^k':>7s} {'95% CI':>15s} {'calls':>6s}")
        for scenario_id, row in summary.items():
            k = row["trials"]
            print(f"{scenario_id:14s} {row['passed']:>3d}/{k:<3d} {row[f'pass^{k}']:>7.3f} "
                  f"{str(row['wilson95']):>15s} {row['mean_calls']:>6.2f}")
        for run, result in report.items():
            if not result["passed"]:
                print(f"  FAIL {run}: {json.dumps(result['failed'], ensure_ascii=False)[:300]}")
    return 0 if all(r["passed"] for r in report.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())

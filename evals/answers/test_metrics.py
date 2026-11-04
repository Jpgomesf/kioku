#!/usr/bin/env python3
"""Unit tests for the answer metrics and judge parsing. Stdlib only:

    python3 -I evals/answers/test_metrics.py
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "lib"))

import agent  # noqa: E402
import metrics  # noqa: E402

DLQ_NOTE = ("Dead-letter handling for media events\nMessages that exhaust their five delivery attempts move to "
            "the MEDIA_DLQ stream. The on-call engineer reviews MEDIA_DLQ every weekday at 09:00 UTC.")
ONCALL_NOTE = "On-call rotation\nThe rotation hands off on Mondays at 10:00 local time."
NOTES = {"dead-letter-policy": DLQ_NOTE, "oncall-rotation": ONCALL_NOTE, "imgproc-runbook": "Run systemctl restart imgproc."}
HOP = {"id": "hop-03", "query": "Who reviews the dead-letter queue, and on which day do they hand off?",
       "relevant": {"dead-letter-policy": 2, "oncall-rotation": 2}, "answer": ["09:00 UTC", "Mondays"]}
NONE = {"id": "none-01", "query": "What is our Kubernetes autoscaling policy?", "relevant": {}}
SUPER = {"id": "super-01", "query": "How do I restart the thumbnail worker?", "relevant": {"thumbnailer": 2},
         "answer": ["twctl restart thumbnailer"], "forbidden": ["imgproc-runbook"]}


class Citations(unittest.TestCase):
    def test_single_lists_and_adjacent_groups(self):
        text = "Reviewed at 09:00 UTC [dead-letter-policy]; hand-off on Mondays [oncall-rotation, media-queue][cdn-cache]."
        self.assertEqual(metrics.citations(text), ["dead-letter-policy", "oncall-rotation", "media-queue", "cdn-cache"])

    def test_decorations_are_stripped(self):
        self.assertEqual(metrics.citations("see [`auth-tokens`] and [key: rate-limits]"), ["auth-tokens", "rate-limits"])

    def test_non_citations_are_ignored(self):
        text = ("[x] done, footnote [1], identifier [MEDIA_DLQ], code items[idx], a [link](https://x.y), "
                "and [see the note]")
        self.assertEqual(metrics.citations(text), [])

    def test_duplicates_are_reported_once(self):
        self.assertEqual(metrics.citations("[a-b-c] then again [a-b-c]"), ["a-b-c"])


class Facts(unittest.TestCase):
    def test_case_insensitive_and_ignores_markdown(self):
        row = metrics.score_answer(HOP, "The on-call engineer checks it at **09:00 utc** and hands off on `mondays`.",
                                   set(), NOTES)
        self.assertTrue(row["fact_correct"])
        self.assertEqual(row["fact_recall"], 1.0)

    def test_partial_answer(self):
        row = metrics.score_answer(HOP, "Reviewed daily at 09:00 UTC.", set(), NOTES)
        self.assertFalse(row["fact_correct"])
        self.assertEqual(row["fact_recall"], 0.5)
        self.assertEqual(row["missing_facts"], ["Mondays"])
        self.assertFalse(row["has_citation"])
        self.assertNotIn("citation_valid", row)
        self.assertNotIn("citation_support", row)


class CitationChecks(unittest.TestCase):
    seen = {"dead-letter-policy", "oncall-rotation", "media-queue"}

    def test_valid_and_supported(self):
        answer = "At 09:00 UTC [dead-letter-policy]; hand-off on Mondays [oncall-rotation]."
        row = metrics.score_answer(HOP, answer, self.seen, NOTES)
        self.assertTrue(row["has_citation"])
        self.assertTrue(row["citation_valid"])
        self.assertTrue(row["citation_support"])

    def test_unretrieved_key_is_invalid(self):
        row = metrics.score_answer(HOP, "09:00 UTC, Mondays [dead-letter-policy] [cdn-cache]", self.seen, NOTES)
        self.assertFalse(row["citation_valid"])
        self.assertEqual(row["invalid_citations"], ["cdn-cache"])

    def test_cited_notes_must_contain_every_fact(self):
        row = metrics.score_answer(HOP, "09:00 UTC and Mondays [dead-letter-policy]", self.seen, NOTES)
        self.assertFalse(row["citation_support"])
        self.assertEqual(row["unsupported_facts"], ["Mondays"])

    def test_unknown_cited_key_supports_nothing(self):
        row = metrics.score_answer(HOP, "09:00 UTC, Mondays [made-up-note]", self.seen, NOTES)
        self.assertFalse(row["citation_support"])

    def test_seen_keys_skip_errors_and_writes(self):
        calls = [
            {"tool": "memory_search", "is_error": False, "result_keys": ["a-note", "b-note"]},
            {"tool": "memory_get", "is_error": True, "result_keys": ["c-note"]},
            {"tool": "memory_save", "is_error": False, "result_keys": ["d-note"]},
            {"tool": "memory_get", "is_error": False, "result_keys": ["b-note", "e-note"]},
        ]
        self.assertEqual(metrics.seen_keys(calls), {"a-note", "b-note", "e-note"})


class Abstention(unittest.TestCase):
    def test_clean_abstention(self):
        for answer in ("Nothing about Kubernetes autoscaling is stored in the tidewater memory.",
                       "I couldn’t find any stored memory about that.",
                       "Não há nada armazenado sobre isso."):
            self.assertTrue(metrics.score_answer(NONE, answer, set(), {})["abstained"], answer)

    def test_specifics_or_citations_fail(self):
        for answer in ("Nothing is stored, but HPA usually targets 70% CPU.",
                       "No policy is stored [rate-limits].",
                       "The policy scales pods on CPU."):
            self.assertFalse(metrics.score_answer(NONE, answer, set(), {})["abstained"], answer)

    def test_answerable_questions_have_no_abstention_metric(self):
        self.assertNotIn("abstained", metrics.score_answer(HOP, "nothing", set(), NOTES))


class Leakage(unittest.TestCase):
    def test_forbidden_key_cited(self):
        row = metrics.score_answer(SUPER, "Run twctl restart thumbnailer [thumbnailer] [imgproc-runbook]",
                                   {"thumbnailer", "imgproc-runbook"}, NOTES)
        self.assertTrue(row["forbidden_leak"])
        self.assertEqual(row["leaked"], ["imgproc-runbook"])

    def test_no_leak(self):
        row = metrics.score_answer(SUPER, "Run twctl restart thumbnailer [thumbnailer]", {"thumbnailer"}, NOTES)
        self.assertFalse(row["forbidden_leak"])

    def test_only_questions_with_forbidden_keys(self):
        self.assertNotIn("forbidden_leak", metrics.score_answer(HOP, "x [imgproc-runbook]", set(), NOTES))


class RetrievedNotes(unittest.TestCase):
    def test_reads_memory_get_results_only(self):
        get = json.dumps({"memories": [{"key": "dead-letter-policy", "title": "DLQ", "text": "five attempts"},
                                       {"key": "media-queue", "title": "Media", "text": "seven days"}],
                          "untrusted_evidence": True})
        calls = [
            {"name": "memory_search", "is_error": False, "result": json.dumps({"results": [{"key": "cdn-cache"}]})},
            {"name": "memory_get", "is_error": False, "result": get},
            {"name": "memory_get", "is_error": True, "result": "not_found: nothing"},
            {"name": "memory_get", "is_error": False, "result": "not json"},
            {"name": "memory_get", "is_error": False, "result": get},
        ]
        self.assertEqual(metrics.retrieved_notes(calls),
                         [("dead-letter-policy", "DLQ\nfive attempts"), ("media-queue", "Media\nseven days")])


class JudgeParsing(unittest.TestCase):
    good = {"claims": [{"claim": "MEDIA_DLQ is reviewed at 09:00 UTC.", "supported": True, "evidence": "dead-letter-policy"},
                       {"claim": "Hand-off happens on Fridays.", "supported": False, "evidence": None}]}

    def test_bare_json(self):
        claims = metrics.parse_judge_response(json.dumps(self.good))
        self.assertEqual([c["supported"] for c in claims], [True, False])
        self.assertEqual(metrics.groundedness(claims), 0.5)

    def test_fenced_with_thinking_and_prose(self):
        reply = "<think>let me check</think>\n```json\n" + json.dumps(self.good) + "\n```"
        self.assertEqual(len(metrics.parse_judge_response(reply)), 2)
        reply = "Here is the result:\n" + json.dumps(self.good) + "\nDone."
        self.assertEqual(len(metrics.parse_judge_response(reply)), 2)

    def test_no_claims(self):
        self.assertEqual(metrics.parse_judge_response('{"claims": []}'), [])
        self.assertIsNone(metrics.groundedness([]))

    def test_evidence_is_optional(self):
        claims = metrics.parse_judge_response('{"claims": [{"claim": "a", "supported": true}]}')
        self.assertIsNone(claims[0]["evidence"])

    def test_schema_violations(self):
        for reply in (
            "not json at all",
            "[]",
            '{"claim": "x"}',
            '{"claims": {"claim": "x"}}',
            '{"claims": ["x"]}',
            '{"claims": [{"claim": "", "supported": true}]}',
            '{"claims": [{"claim": "x", "supported": "true"}]}',
            '{"claims": [{"claim": "x"}]}',
            '{"claims": [{"claim": "x", "supported": true, "evidence": 3}]}',
        ):
            with self.assertRaises(metrics.JudgeError, msg=reply):
                metrics.parse_judge_response(reply)

    def test_claude_envelope(self):
        envelope = {"type": "result", "subtype": "success", "is_error": False, "num_turns": 1,
                    "result": json.dumps(self.good), "total_cost_usd": 0.0123, "duration_ms": 2100,
                    "session_id": "00000000-0000-0000-0000-000000000000"}
        text, details = metrics.parse_claude_envelope(json.dumps(envelope))
        self.assertEqual(len(metrics.parse_judge_response(text)), 2)
        self.assertEqual(details, {"total_cost_usd": 0.0123, "duration_ms": 2100, "num_turns": 1})

    def test_claude_envelope_errors(self):
        for stdout in ("", "oops", "[]",
                       json.dumps({"type": "result", "subtype": "error_max_turns", "is_error": True}),
                       json.dumps({"type": "result", "subtype": "success", "is_error": True, "result": "API Error"}),
                       json.dumps({"type": "result", "subtype": "success", "is_error": False})):
            with self.assertRaises(metrics.JudgeError, msg=stdout):
                metrics.parse_claude_envelope(stdout)

    def test_claude_command_has_no_tools(self):
        command = metrics.claude_judge_command("sonnet")
        self.assertEqual(command[:6], ["claude", "-p", "--model", "sonnet", "--output-format", "json"])
        self.assertEqual(command[command.index("--tools") + 1], "")
        self.assertIn("--strict-mcp-config", command)

    def test_prompt_carries_question_notes_answer_and_schema(self):
        prompt = metrics.judge_prompt("Q?", "A [k-1]", [("k-1", "note text")])
        for part in ("Q?", "A [k-1]", '<note key="k-1">', "note text", '"supported"'):
            self.assertIn(part, prompt)
        self.assertIn("(no notes were retrieved)", metrics.judge_prompt("Q?", "A", []))


class JudgeSpec(unittest.TestCase):
    def test_specs(self):
        self.assertEqual(metrics.parse_judge_spec("none"), {"kind": "none"})
        self.assertEqual(metrics.parse_judge_spec("claude:sonnet"), {"kind": "claude", "model": "sonnet"})
        self.assertEqual(metrics.parse_judge_spec("openai:http://127.0.0.1:47831/v1:Qwen3.8-Strata"),
                         {"kind": "openai", "base_url": "http://127.0.0.1:47831/v1", "model": "Qwen3.8-Strata"})
        self.assertEqual(metrics.parse_judge_spec("openai:http://localhost:11434/v1:qwen3:8b"),
                         {"kind": "openai", "base_url": "http://localhost:11434/v1", "model": "qwen3:8b"})
        self.assertEqual(metrics.parse_judge_spec("openai:https://api.example.com:gpt-x"),
                         {"kind": "openai", "base_url": "https://api.example.com", "model": "gpt-x"})

    def test_bad_specs(self):
        for spec in ("", "claude:", "openai:http://h/v1", "openai:model", "gpt"):
            with self.assertRaises(ValueError, msg=spec):
                metrics.parse_judge_spec(spec)


class Intervals(unittest.TestCase):
    def test_wilson(self):
        low, high = metrics.wilson(5, 5)
        self.assertAlmostEqual(low, 0.566, places=3)
        self.assertEqual(high, 1.0)
        self.assertEqual(metrics.wilson(0, 0), (0.0, 1.0))

    def test_bootstrap_is_seeded_and_brackets_the_mean(self):
        values = [0.0, 0.5, 1.0, 1.0, 0.25, 0.75, 1.0, 0.0]
        first = metrics.bootstrap_mean(values)
        self.assertEqual(first, metrics.bootstrap_mean(values))
        self.assertLessEqual(first[0], sum(values) / len(values))
        self.assertGreaterEqual(first[1], sum(values) / len(values))
        self.assertEqual(metrics.bootstrap_mean([0.4]), (0.4, 0.4))

    def test_summarize_skips_rows_where_a_metric_does_not_apply(self):
        rows = [{"fact_correct": True, "groundedness": 1.0, "invalid_calls": 1},
                {"fact_correct": False, "groundedness": None, "invalid_calls": 0},
                {"abstained": True, "invalid_calls": 2, "error": "api_error"}]
        summary = metrics.summarize(rows)
        self.assertEqual((summary["fact_correct"]["passed"], summary["fact_correct"]["n"]), (1, 2))
        self.assertEqual(summary["groundedness"]["n"], 1)
        self.assertEqual(summary["abstained"]["value"], 1.0)
        self.assertIsNone(summary["citation_valid"]["value"])
        self.assertEqual(summary["invalid_calls_total"], 3)
        self.assertEqual(summary["errors"], 1)


class AgentHelpers(unittest.TestCase):
    """The shared loop's parsing of model output (evals/lib/agent.py)."""

    def test_tool_arguments(self):
        self.assertEqual(agent.parse_arguments('{"query": "x"}'), ({"query": "x"}, None))
        self.assertEqual(agent.parse_arguments(""), ({}, None))
        self.assertEqual(agent.parse_arguments({"a": 1}), ({"a": 1}, None))
        for raw in ('{"query": "x"', "[1, 2]", "null", 5):
            value, problem = agent.parse_arguments(raw)
            self.assertIsNone(value)
            self.assertTrue(problem)

    def test_strip_thinking(self):
        self.assertEqual(agent.strip_thinking("<think>a\nb</think>\nAnswer"), "Answer")
        self.assertEqual(agent.strip_thinking("reasoning only</think>Answer"), "Answer")
        self.assertEqual(agent.strip_thinking("Plain"), "Plain")

    def test_disposable_names(self):
        self.assertTrue(agent.is_disposable("memory_harness_eval"))
        for name in ("memory", "Memory_eval", "memory-eval", "x" * 60 + "eval", 'eval"; drop'):
            self.assertFalse(agent.is_disposable(name), name)


if __name__ == "__main__":
    unittest.main(verbosity=1)

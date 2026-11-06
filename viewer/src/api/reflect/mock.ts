import { commandError, READ_ONLY_MESSAGE } from "../core";
import type { ReflectRun, ReflectSettings } from "./types";

const settings: ReflectSettings = {
  mode: "manual",
  harnesses: [
    {
      id: "claude-code",
      name: "Claude Code",
      provider: "Anthropic",
      vaultsReadable: ["personal", "work"],
      status: "ready",
    },
    {
      id: "codex",
      name: "Codex",
      provider: "OpenAI",
      vaultsReadable: ["work"],
      status: "needs-skill",
    },
    {
      id: "hermes",
      name: "Hermes",
      provider: "Any model you give it",
      vaultsReadable: [],
      status: "not-connected",
    },
    {
      id: "kilo",
      name: "Kilo with Qwen",
      provider: "Runs on this Mac",
      vaultsReadable: ["personal", "work"],
      status: "needs-skill",
    },
  ],
  roles: { worker: "claude-code", reviewer: "codex", report: "claude-code" },
  triggers: { afterImport: true, nightlyAt: "02:00", afterSaves: { threshold: 25, soFar: 5 } },
  permission: "report-only",
};

const runs: ReflectRun[] = [
  {
    id: "run-2026-11-05",
    domain: "personal/kioku",
    startedAt: "2026-11-05T18:02:00Z",
    finishedAt: "2026-11-05T18:09:00Z",
    harness: "claude-code",
    findings: [
      {
        id: "f1",
        state: "confirmed",
        text: "Two notes give different defaults for the legacy threshold.",
        noteKeys: ["memory-workflow", "memory-stack"],
      },
      {
        id: "f2",
        state: "confirmed",
        text: "The model tiers note says small models get no memory, but the stack note says they get a context pack.",
        noteKeys: ["memory-model-tiers"],
      },
      {
        id: "f3",
        state: "unverified",
        text: "The viewer design note links to nothing in the demo area.",
        noteKeys: ["kioku-viewer-design"],
      },
      {
        id: "f4",
        state: "unverified",
        text: "The viewer design note may predate the read-only build.",
        noteKeys: ["kioku-viewer-design"],
      },
    ],
  },
];

const clone = <T>(value: T): T => structuredClone(value);

export const listReflectRuns = (domain: string): ReflectRun[] =>
  clone(runs.filter((r) => r.domain === domain)).sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  );

export const getReflectSettings = (): ReflectSettings => clone(settings);

// The Rust backend is read-only: these return read_only, and so does the mock, so the
// browser build behaves like the desktop app.

export function startReflect(_domain: string): ReflectRun {
  throw commandError("read_only", READ_ONLY_MESSAGE);
}

export function saveReflectSettings(_next: ReflectSettings): void {
  throw commandError("read_only", READ_ONLY_MESSAGE);
}

export function dismissFinding(_run: string, _finding: string): void {
  throw commandError("read_only", READ_ONLY_MESSAGE);
}

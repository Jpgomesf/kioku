import { describe, expect, it } from "vitest";
import type { Area, NoteSummary, ReflectRun, ServiceStatus, Vault } from "../../api";
import {
  areaRows,
  draftsOnly,
  formatChecked,
  formatCount,
  formatDay,
  labelFor,
  latestRun,
  overallLabel,
  runningRun,
  STATE_LABEL,
  STATE_TONE,
  serviceCards,
  summarizeRun,
  totals,
  vaultFor,
  worstState,
} from "./derive";

const area = (domain: string, label: string, vault: string): Area => ({
  domain,
  label,
  vault,
  noteCount: 0,
  legacyCount: 0,
  source: null,
});

const vaults: Vault[] = [
  { name: "personal", domains: ["personal", "local", "demo"], providers: [] },
  { name: "work", domains: ["work", "inbox"], providers: [] },
];

const run = (
  id: string,
  startedAt: string,
  states: ("confirmed" | "unverified")[] = [],
  finishedAt: string | null = startedAt,
): ReflectRun => ({
  id,
  domain: "personal/kioku",
  startedAt,
  finishedAt,
  harness: "claude-code",
  findings: states.map((state, i) => ({ id: `${id}-${i}`, state, text: "t", noteKeys: [] })),
});

const note = (key: string, status: NoteSummary["status"]): NoteSummary => ({
  key,
  domain: "demo",
  title: key,
  kind: "note",
  status,
  origin: "agent",
  tags: [],
  linkCount: 0,
  findingCount: 0,
  source: null,
  updatedAt: "2026-11-01T00:00:00Z",
});

describe("area labels", () => {
  it("finds the vault from the vault list, or none", () => {
    expect(vaultFor("personal/kioku", vaults)).toBe("personal");
    expect(vaultFor("inbox", vaults)).toBe("work");
    expect(vaultFor("elsewhere", vaults)).toBeNull();
    expect(labelFor("personal/kioku", [], vaults)).toBe("kioku");
    expect(labelFor("local", [area("local", "Local", "personal")])).toBe("Local");
    expect(labelFor("elsewhere", [], vaults)).toBe("elsewhere");
  });

  it("builds sorted area rows without guessing a vault", () => {
    const rows = areaRows(
      [
        { domain: "work/demo-notes", active: 1203, legacy: 58 },
        { domain: "personal/kioku", active: 3, legacy: 0 },
        { domain: "local", active: 4, legacy: 2 },
        { domain: "inbox", active: 0, legacy: 0 },
        { domain: "stray", active: 0, legacy: 0 },
      ],
      [area("local", "local", "personal")],
      vaults,
    );
    expect(rows.map((r) => (r.vault ? `${r.label} in ${r.vault}` : r.label))).toEqual([
      "stray",
      "kioku in personal",
      "local in personal",
      "demo-notes in work",
      "inbox in work",
    ]);
    expect(totals(rows)).toEqual({ active: 1210, legacy: 60 });
    expect(formatCount(1203)).toBe("1,203");
  });
});

describe("services", () => {
  it("collapses to the worst state", () => {
    expect(worstState(["running", "running"])).toBe("running");
    expect(worstState(["running", "down", "degraded"])).toBe("down");
    expect(overallLabel("running")).toBe("All services running");
    expect(overallLabel("degraded")).toBe("Some services degraded");
    expect(overallLabel("down")).toBe("A service is down");
  });

  it("labels and tones each state", () => {
    expect(STATE_LABEL).toEqual({
      running: "Running",
      degraded: "Degraded",
      down: "Not reachable",
    });
    expect(STATE_TONE).toEqual({ running: "active", degraded: "finding", down: "down" });
  });

  it("puts pending vectors in the Qdrant role", () => {
    const status: ServiceStatus = {
      postgres: { state: "running", detail: "a" },
      qdrant: { state: "degraded", detail: "b" },
      ollama: { state: "running", detail: "c" },
      embeddingModel: "nomic-embed-text",
      embeddingProvider: "ollama",
      embeddingLocal: true,
      embeddingReader: "this Mac",
    };
    expect(serviceCards(status, 1)[1]?.role).toContain("1 note waiting");
    expect(serviceCards(status, 0)[1]?.role).toContain("0 notes waiting");
    expect(serviceCards(status, 1)[1]?.state).toBe("degraded");
    expect(serviceCards(status, 1)[2]?.role).toContain("nomic-embed-text");
    expect(serviceCards(status, 1)[2]?.role).toContain("on this computer");
  });

  it("says when embeddings leave this computer", () => {
    const hosted: ServiceStatus = {
      postgres: { state: "running", detail: "a" },
      qdrant: { state: "running", detail: "b" },
      ollama: { state: "running", detail: "c" },
      embeddingModel: "text-embedding-3-small",
      embeddingProvider: "openai",
      embeddingLocal: false,
      embeddingReader: "OpenAI",
    };
    const card = serviceCards(hosted, 0)[2];
    expect(card?.name).toBe("Embeddings");
    expect(card?.role).toContain("sent to OpenAI");
    expect(card?.role).not.toContain("on this computer");
  });
});

describe("reflect runs", () => {
  it("summarizes the latest finished run", () => {
    const latest = latestRun([
      run("a", "2026-11-01T00:00:00Z", ["confirmed"]),
      run("b", "2026-11-05T00:00:00Z", ["confirmed", "unverified", "unverified"]),
    ]);
    expect(latest?.id).toBe("b");
    expect(summarizeRun(latest)).toMatchObject({ confirmed: 1, unverified: 2 });
    expect(latestRun([])).toBeNull();
    expect(summarizeRun(null)).toBeNull();
  });

  it("compares parsed times across formats and offsets", () => {
    expect(
      latestRun([run("a", "2026-11-05T18:02:05Z"), run("b", "2026-11-05T18:02:05.500Z")])?.id,
    ).toBe("b");
    expect(
      latestRun([run("a", "2026-11-05T20:00:00+02:00"), run("b", "2026-11-05T19:00:00Z")])?.id,
    ).toBe("b");
    expect(latestRun([run("a", "garbage"), run("b", "2026-01-01T00:00:00Z")])?.id).toBe("b");
  });

  it("skips unfinished runs and reports them separately", () => {
    const runs = [
      run("done", "2026-11-05T10:00:00Z"),
      run("now", "2026-11-05T14:02:00Z", [], null),
    ];
    expect(latestRun(runs)?.id).toBe("done");
    const soon = Date.parse("2026-11-05T14:05:00Z");
    expect(runningRun(runs, soon)?.id).toBe("now");
    expect(runningRun([run("done", "2026-11-05T10:00:00Z")], soon)).toBeNull();
  });

  it("treats a run that never finished as stalled, not running", () => {
    const runs = [run("stuck", "2026-11-05T14:02:00Z", [], null)];
    expect(runningRun(runs, Date.parse("2026-11-05T15:00:00Z"))).toBeNull();
  });
});

describe("formatting", () => {
  it("keeps only drafts", () => {
    expect(draftsOnly([note("a", "draft"), note("b", "active")]).map((n) => n.key)).toEqual(["a"]);
  });

  it("formats days and check times", () => {
    expect(formatDay("2026-11-05T12:00:00Z")).toBe("5 Nov");
    expect(formatDay("not a date")).toBe("not a date");
    expect(formatChecked(new Date(2026, 10, 5, 14, 2))).toBe("5 Nov 14:02");
  });
});

import { describe, expect, it } from "vitest";
import type { Area, NoteSummary, SearchHit } from "../../api";
import {
  areaLabel,
  compareNotes,
  countsLine,
  filterAndSort,
  filterHits,
  filtersFromParams,
  KIND_CHIPS_SHOWN,
  kindChips,
  matchedByText,
  moveIndex,
  nextOrigin,
  nextStatus,
  paramsFromFilters,
  toggleKind,
  uniqueKeys,
} from "./logic";

function note(over: Partial<NoteSummary>): NoteSummary {
  return {
    key: "a",
    domain: "personal/kioku",
    title: "A",
    kind: "decision",
    status: "active",
    origin: "file",
    tags: [],
    linkCount: 0,
    findingCount: 0,
    source: null,
    updatedAt: "2026-11-01T10:00:00Z",
    ...over,
  };
}

describe("filtersFromParams", () => {
  it("uses defaults for empty or unknown params", () => {
    expect(filtersFromParams({ status: "bogus", origin: "x", since: "not a date" })).toEqual({
      kinds: [],
      status: "active",
      origin: "any",
      since: null,
      query: "",
    });
  });

  it("reads a comma list of kinds, keeps any valid id and drops invalid ones", () => {
    expect(
      filtersFromParams({ kind: "decision,design-review, runbook ,decision,Bad,a--b,-x,,a b" })
        .kinds,
    ).toEqual(["decision", "design-review", "runbook"]);
  });

  it("writes arbitrary kinds back to the URL", () => {
    const filters = filtersFromParams({ kind: "design-review,release-notes" });
    expect(paramsFromFilters(filters).kind).toBe("design-review,release-notes");
  });

  it("round-trips through paramsFromFilters", () => {
    const params = {
      q: "ports",
      kind: "decision",
      status: "all",
      origin: "agent",
      since: "2026-11-04",
    };
    expect(paramsFromFilters(filtersFromParams(params))).toEqual(params);
  });

  it("leaves defaults out of the URL", () => {
    expect(paramsFromFilters(filtersFromParams({}))).toEqual({});
  });
});

describe("filter helpers", () => {
  it("toggles kinds", () => {
    expect(toggleKind(["decision"], "fix")).toEqual(["decision", "fix"]);
    expect(toggleKind(["decision", "fix"], "decision")).toEqual(["fix"]);
  });

  it("cycles status and origin", () => {
    expect(nextStatus("active")).toBe("legacy");
    expect(nextStatus("all")).toBe("active");
    expect(nextOrigin("any")).toBe("file");
    expect(nextOrigin("agent")).toBe("any");
  });
});

describe("filterAndSort", () => {
  const notes = [
    note({ key: "old", updatedAt: "2026-10-01T00:00:00Z" }),
    note({ key: "b", updatedAt: "2026-11-05T00:00:00Z" }),
    note({ key: "a", updatedAt: "2026-11-05T00:00:00Z" }),
    note({ key: "legacy", status: "legacy", updatedAt: "2026-11-06T00:00:00Z" }),
    note({ key: "q", kind: "question", origin: "agent", updatedAt: "2026-11-06T00:00:00Z" }),
  ];

  it("sorts newest first, then by key", () => {
    expect([...notes].sort(compareNotes).map((n) => n.key)).toEqual([
      "legacy",
      "q",
      "a",
      "b",
      "old",
    ]);
  });

  it("shows active notes by default", () => {
    expect(filterAndSort(notes, filtersFromParams({})).map((n) => n.key)).toEqual([
      "q",
      "a",
      "b",
      "old",
    ]);
  });

  it("filters by kind, origin, status and since", () => {
    const f = filtersFromParams;
    expect(filterAndSort(notes, f({ kind: "question" })).map((n) => n.key)).toEqual(["q"]);
    expect(filterAndSort(notes, f({ origin: "file" })).map((n) => n.key)).toEqual([
      "a",
      "b",
      "old",
    ]);
    expect(filterAndSort(notes, f({ status: "legacy" })).map((n) => n.key)).toEqual(["legacy"]);
    expect(filterAndSort(notes, f({ status: "all", since: "2026-11-04T00:00:00Z" })).length).toBe(
      4,
    );
  });

  it("starts a date-only since at local midnight", () => {
    const local = (h: number) => new Date(2026, 10, 5, h).toISOString();
    const day = [
      note({ key: "late", updatedAt: new Date(2026, 10, 4, 23, 59).toISOString() }),
      note({ key: "early", updatedAt: local(1) }),
    ];
    const f = filtersFromParams({ since: "2026-11-05" });
    expect(filterAndSort(day, f).map((n) => n.key)).toEqual(["early"]);
  });

  it("rejects since values Date.parse would accept loosely", () => {
    for (const since of ["2026-02-30", "1", "12", "Nov 5"]) {
      expect(filtersFromParams({ since }).since).toBeNull();
    }
    expect(filtersFromParams({ since: "2026-02-28" }).since).toBe("2026-02-28");
  });

  it("does not mutate its input", () => {
    const copy = [...notes];
    filterAndSort(notes, filtersFromParams({}));
    expect(notes).toEqual(copy);
  });
});

describe("moveIndex", () => {
  it("clamps and starts from the ends", () => {
    expect(moveIndex(-1, 1, 3)).toBe(0);
    expect(moveIndex(-1, -1, 3)).toBe(2);
    expect(moveIndex(2, 1, 3)).toBe(2);
    expect(moveIndex(0, -1, 3)).toBe(0);
    expect(moveIndex(0, 1, 0)).toBe(-1);
  });
});

describe("matchedByText", () => {
  it("joins signals in plain words", () => {
    expect(matchedByText(["text"], null)).toBe("Matched by text");
    expect(matchedByText(["label", "text", "meaning"], null)).toBe(
      "Matched by label, text and meaning",
    );
    expect(matchedByText(["linked"], "Ports")).toBe("Linked from Ports");
  });
});

describe("since=last-visit", () => {
  it("resolves to the last visit and writes the word back", () => {
    const f = filtersFromParams({ since: "last-visit" }, "2026-11-02T08:00:00Z");
    expect(f.since).toBe("2026-11-02T08:00:00Z");
    expect(paramsFromFilters(f)).toEqual({ since: "last-visit" });
    const notes = [note({ key: "old", updatedAt: "2026-11-01T00:00:00Z" }), note({ key: "new" })];
    expect(filterAndSort(notes, f).map((n) => n.key)).toEqual([]);
    expect(filterAndSort([note({ updatedAt: "2026-11-03T00:00:00Z" })], f)).toHaveLength(1);
  });

  it("falls back to a date when there is no last visit", () => {
    expect(filtersFromParams({ since: "last-visit" }, null).since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("filterHits", () => {
  const hit = (n: NoteSummary): SearchHit => ({
    note: n,
    score: 1,
    matchedBy: ["text"],
    linkedFrom: null,
    snippet: "",
  });
  it("applies since and status like the list", () => {
    const hits = [
      hit(note({ key: "old", updatedAt: "2026-10-29T00:00:00Z" })),
      hit(note({ key: "legacy", status: "legacy" })),
      hit(note({ key: "ok" })),
    ];
    const f = filtersFromParams({ since: "2026-11-01" });
    expect(filterHits(hits, f).map((h) => h.note.key)).toEqual(["ok"]);
  });
});

describe("countsLine", () => {
  const area: Area = {
    domain: "demo",
    label: "demo",
    vault: "personal",
    noteCount: 99,
    legacyCount: 99,
    source: "notes/",
  };
  it("counts from the loaded notes, not the area", () => {
    const notes = [note({}), note({ status: "legacy" }), note({ status: "draft" })];
    expect(countsLine(notes, area)).toBe("1 active · 1 legacy · imported from notes/");
  });
  it("shows nothing until the notes are loaded", () => {
    expect(countsLine(null, area)).toBeNull();
  });
});

describe("areaLabel", () => {
  it("never invents a vault from a one-part domain", () => {
    expect(areaLabel("demo", null)).toEqual({ label: "demo", vault: null });
    expect(areaLabel("personal/kioku", null)).toEqual({ label: "kioku", vault: null });
  });
});

describe("uniqueKeys", () => {
  it("suffixes repeats", () => {
    expect(uniqueKeys(["a", "b", "a"])).toEqual(["a", "b", "a#2"]);
  });
});

describe("kindChips", () => {
  const counts = Array.from({ length: 9 }, (_, i) => ({ kind: `type-${i}`, count: 20 - i }));

  it("shows the first few, plus any selected type, and counts the rest", () => {
    const { chips, hidden } = kindChips(counts, ["type-8"], false);
    expect(chips.map((c) => c.kind)).toEqual([
      ...counts.slice(0, KIND_CHIPS_SHOWN).map((c) => c.kind),
      "type-8",
    ]);
    expect(hidden).toBe(2);
  });

  it("lists every type when expanded", () => {
    expect(kindChips(counts, [], true)).toEqual({ chips: counts, hidden: 0, overflow: 3 });
  });

  it("reports no overflow when the collapsed view would hide nothing", () => {
    expect(kindChips(counts.slice(0, 8), ["type-6", "type-7"], true).overflow).toBe(0);
  });

  it("shows only the selected types, uncounted, while notes load", () => {
    expect(kindChips(null, ["decision"], false)).toEqual({
      chips: [{ kind: "decision", count: null }],
      hidden: 0,
      overflow: 0,
    });
  });

  it("keeps a selected type the area lacks, with 0", () => {
    const { chips } = kindChips(counts.slice(0, 2), ["runbook"], false);
    expect(chips.at(-1)).toEqual({ kind: "runbook", count: 0 });
  });
});

describe("filtering by an open type", () => {
  it("filters notes and hits by any type id", () => {
    const notes = [note({ key: "r", kind: "runbook" }), note({ key: "d", kind: "design-review" })];
    const filters = filtersFromParams({ kind: "design-review" });
    expect(filterAndSort(notes, filters).map((n) => n.key)).toEqual(["d"]);
    const hits = notes.map(
      (n): SearchHit => ({ note: n, score: 1, matchedBy: ["text"], linkedFrom: null, snippet: "" }),
    );
    expect(filterHits(hits, filters).map((h) => h.note.key)).toEqual(["d"]);
  });
});

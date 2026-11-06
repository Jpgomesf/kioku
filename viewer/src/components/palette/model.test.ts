import { describe, expect, it } from "vitest";
import type { SearchHit } from "../../api";
import { moveActive } from "../../app/overlay";
import { parseHash } from "../../app/router";
import { filtersFromParams } from "../../pages/library/logic";
import { buildOptions, matchedByText, paletteKey, shortDate, sinceDate } from "./model";

const hit = (
  key: string,
  matchedBy: SearchHit["matchedBy"],
  linkedFrom: string | null = null,
): SearchHit => ({
  note: {
    key,
    domain: "personal/kioku",
    title: `Title ${key}`,
    kind: "decision",
    status: "active",
    origin: "agent",
    tags: [],
    linkCount: 0,
    findingCount: 0,
    source: null,
    updatedAt: "2026-01-01T00:00:00Z",
  },
  score: 1,
  matchedBy,
  linkedFrom,
  snippet: "",
});

const base = { recent: [], since: "2026-11-05", vault: "personal", wholeVault: false };

describe("matchedByText", () => {
  it("joins signals in plain words", () => {
    expect(matchedByText({ matchedBy: ["text", "meaning"], linkedFrom: null })).toBe(
      "matched words and meaning",
    );
    expect(matchedByText({ matchedBy: ["text"], linkedFrom: null })).toBe("matched words");
  });
  it("names the note a linked hit came from", () => {
    expect(matchedByText({ matchedBy: ["linked"], linkedFrom: "Retry policy" })).toBe(
      "linked from Retry policy",
    );
  });
});

describe("buildOptions", () => {
  it("lists every command and no notes when empty", () => {
    const options = buildOptions({ ...base, query: "", hits: [hit("a", ["text"])] });
    expect(options.every((o) => o.section === "Commands")).toBe(true);
    expect(options.map((o) => o.id)).toContain("changes");
    expect(options.map((o) => o.id)).toContain("open-vaults");
  });
  it("puts notes first, then the vault search and library commands", () => {
    const options = buildOptions({ ...base, query: "retry", hits: [hit("a", ["text"])] });
    expect(options[0]?.section).toBe("Notes");
    expect(options[0]?.meta).toBe("Decision · matched words");
    expect(options[0]?.graphHref).toBe("#/graph?domain=personal%2Fkioku&focus=a");
    expect(options[1]?.label).toBe("Search all of personal for “retry”");
    expect(options[2]?.id).toBe("library-matches");
  });
  it("filters commands by every word", () => {
    const ids = buildOptions({ ...base, query: "health check", hits: [] }).map((o) => o.id);
    expect(ids).toContain("go-health");
    expect(ids).not.toContain("go-graph");
  });
  it("drops the vault search once widened", () => {
    const ids = buildOptions({ ...base, wholeVault: true, query: "x", hits: [] }).map((o) => o.id);
    expect(ids).not.toContain("search-vault");
  });
});

describe("keyboard", () => {
  const k = (
    key: string,
    mods: Partial<{
      metaKey: boolean;
      ctrlKey: boolean;
      shiftKey: boolean;
      isComposing: boolean;
    }> = {},
  ) => ({
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  });
  const onMac = (event: ReturnType<typeof k>) => paletteKey(event, true);
  it("maps keys to actions", () => {
    expect(onMac(k("ArrowDown"))).toBe("down");
    expect(onMac(k("ArrowUp"))).toBe("up");
    expect(onMac(k("Enter"))).toBe("open");
    expect(onMac(k("Enter", { metaKey: true }))).toBe("open-graph");
    expect(onMac(k("Tab"))).toBe("tab");
    expect(onMac(k("Tab", { shiftKey: true }))).toBeNull();
    expect(onMac(k("a"))).toBeNull();
  });
  it("leaves input-method keys alone", () => {
    expect(onMac(k("Enter", { isComposing: true }))).toBeNull();
    expect(onMac(k("ArrowDown", { isComposing: true }))).toBeNull();
  });
  it("uses the command key on macOS and Ctrl elsewhere", () => {
    expect(onMac(k("Enter", { ctrlKey: true }))).toBeNull();
    expect(paletteKey(k("Enter", { ctrlKey: true }), false)).toBe("open-graph");
    expect(paletteKey(k("Enter", { metaKey: true }), false)).toBeNull();
  });
  it("wraps the active option", () => {
    expect(moveActive(0, -1, 3)).toBe(2);
    expect(moveActive(2, 1, 3)).toBe(0);
    expect(moveActive(-1, 1, 3)).toBe(0);
    expect(moveActive(-1, -1, 3)).toBe(2);
    expect(moveActive(0, 1, 0)).toBe(-1);
  });
});

describe("commands", () => {
  it("filters the Library by a real date for changes since the last visit", () => {
    const changes = buildOptions({ ...base, query: "", hits: [] }).find((o) => o.id === "changes");
    expect(changes?.label).toBe("Show notes changed since 5 Nov");
    const href = changes?.action.type === "navigate" ? changes.action.href : "";
    const route = parseHash(href);
    expect(route.name).toBe("library");
    const params = route.name === "library" ? route.params : {};
    expect(filtersFromParams(params).since).toBe("2026-11-05");
  });
  it("opens the graph without pinning an area", () => {
    const graph = buildOptions({ ...base, query: "", hits: [] }).find((o) => o.id === "go-graph");
    expect(graph?.action).toEqual({ type: "navigate", href: "#/graph" });
  });
  it("gives each command its own icon", () => {
    const options = buildOptions({ ...base, query: "", hits: [] });
    expect(options.every((o) => o.icon !== undefined && o.icon !== "forward")).toBe(true);
  });
  it("shows recent notes before commands when the query is empty", () => {
    const note = hit("r1", ["text"]).note;
    const options = buildOptions({ ...base, recent: [note], query: "", hits: [] });
    expect(options[0]?.section).toBe("Recent");
    expect(buildOptions({ ...base, recent: [note], query: "x", hits: [] })[0]?.section).not.toBe(
      "Recent",
    );
  });
  it("formats dates and falls back to seven days ago", () => {
    expect(shortDate("2026-11-05")).toBe("5 Nov");
    const now = Date.parse("2026-11-08T12:00:00Z");
    expect(sinceDate("nowhere/never", now)).toBe("2026-11-01");
  });
});

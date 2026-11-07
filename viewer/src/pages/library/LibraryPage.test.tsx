import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Note, NoteSummary, SearchHit } from "../../api";
import { noteHref } from "../../app/router";
import { foldMs } from "./typePops";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function summary(key: string, over: Partial<NoteSummary> = {}): NoteSummary {
  return {
    key,
    domain: "demo",
    title: `Title ${key}`,
    kind: "decision",
    status: "active",
    origin: "file",
    tags: [],
    linkCount: 0,
    findingCount: 0,
    source: null,
    updatedAt: "2026-11-03T10:00:00Z",
    ...over,
  };
}

const NOTES: NoteSummary[] = [
  summary("demo-a", { updatedAt: "2026-11-04T10:00:00Z" }),
  summary("demo-b", { updatedAt: "2026-10-29T10:00:00Z" }),
  summary("demo-c", { status: "legacy" }),
];

const hit = (note: NoteSummary): SearchHit => ({
  note,
  score: 1,
  matchedBy: ["text"],
  linkedFrom: null,
  snippet: "",
});

const api = vi.hoisted(() => ({
  listNotes: vi.fn(),
  listAreas: vi.fn(),
  listReflectRuns: vi.fn(),
  searchNotes: vi.fn(),
  getNote: vi.fn(),
}));

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  ...api,
}));

const area = vi.hoisted(() => ({ domain: "demo" }));
vi.mock("../../app/area", () => ({ useCurrentArea: () => area.domain }));

const { LibraryPage } = await import("./index");

async function settle(ms = 0): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }
}

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(host: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  api.listNotes.mockResolvedValue(NOTES);
  api.listAreas.mockResolvedValue([]);
  api.listReflectRuns.mockResolvedValue([]);
  api.searchNotes.mockResolvedValue([]);
  api.getNote.mockImplementation(
    async (domain: string, key: string): Promise<Note> => ({
      ...summary(key, { domain }),
      body: "<b>x</b>",
      aliases: [],
      links: [],
      revisions: [],
      revision: 1,
      sourcePath: null,
    }),
  );
  window.location.hash = "#/library";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  area.domain = "demo";
  host.remove();
  vi.clearAllMocks();
});

describe("LibraryPage", () => {
  it("asks for at most the backend's list size", async () => {
    act(() => root.render(<LibraryPage params={{}} />));
    await settle();
    expect(api.listNotes).toHaveBeenCalledWith({ domain: "demo", status: "all", limit: 10_000 });
    expect(host.textContent).toContain("2 active · 1 legacy");
  });

  it("moves the selection with the keyboard and opens a note with Enter", async () => {
    act(() => root.render(<LibraryPage params={{ status: "all" }} />));
    await settle();
    const grid = host.querySelector<HTMLTableElement>('[role="grid"]');
    expect(grid).not.toBeNull();
    act(() => {
      grid?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await settle();
    expect(host.querySelectorAll('tbody tr[aria-selected="true"]').length).toBe(1);
    expect(grid?.getAttribute("aria-activedescendant")).toBe("library-row-demo-a");
    act(() => {
      grid?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(window.location.hash).toBe(noteHref("demo", "demo-a"));
  });

  it("renders note text as literal text", async () => {
    act(() => root.render(<LibraryPage params={{}} />));
    await settle();
    const grid = host.querySelector<HTMLTableElement>('[role="grid"]');
    act(() => {
      grid?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await settle(130);
    expect(host.querySelector(".library-body")?.textContent).toBe("<b>x</b>");
    expect(host.querySelector(".library-body b")).toBeNull();
  });

  it("clears a typed search with Clear the search", async () => {
    act(() => root.render(<LibraryPage params={{}} />));
    await settle();
    const input = host.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("no search field");
    type(input, "zzzzqqq");
    await settle(210);
    expect(host.textContent).toContain("No notes match");
    act(() => button(host, "Clear the search")?.click());
    await settle();
    expect(input.value).toBe("");
    expect(host.querySelectorAll("tbody tr").length).toBe(2);
  });

  it("applies the since filter to search hits", async () => {
    api.searchNotes.mockResolvedValue(NOTES.map(hit));
    act(() => root.render(<LibraryPage params={{ since: "2026-11-01", status: "all" }} />));
    await settle();
    const input = host.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("no search field");
    type(input, "title");
    await settle(210);
    const keys = [...host.querySelectorAll("tbody tr")].map((r) => r.getAttribute("data-key"));
    expect(keys).toEqual(["demo-a", "demo-c"]);
    expect(api.searchNotes.mock.calls[0]?.[0]).toMatchObject({ limit: 20, includeLegacy: true });
  });

  it("runs a failed search again on Try again", async () => {
    api.searchNotes
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue([hit(NOTES[0] as NoteSummary)]);
    act(() => root.render(<LibraryPage params={{}} />));
    await settle();
    const input = host.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("no search field");
    type(input, "title");
    await settle(210);
    expect(host.textContent).toContain("Search failed");
    act(() => button(host, "Try again")?.click());
    await settle(210);
    expect(api.searchNotes).toHaveBeenCalledTimes(2);
    expect(api.listNotes).toHaveBeenCalledTimes(1);
    expect(host.querySelectorAll("tbody tr").length).toBe(1);
  });

  it("says when an area has no notes", async () => {
    api.listNotes.mockResolvedValue([]);
    act(() => root.render(<LibraryPage params={{}} />));
    await settle();
    expect(host.textContent).toContain("No notes in demo yet");
    expect(button(host, "Clear filters")).toBeUndefined();
  });

  it("never repeats the domain as its vault", async () => {
    act(() =>
      root.render(
        <StrictMode>
          <LibraryPage params={{}} />
        </StrictMode>,
      ),
    );
    await settle();
    expect(host.textContent).not.toContain("demo in demo");
  });

  it("builds type chips from the area's notes, most common first", async () => {
    api.listNotes.mockResolvedValue([
      summary("a", { kind: "runbook" }),
      summary("b", { kind: "runbook" }),
      summary("c", { kind: "design-review" }),
    ]);
    act(() => root.render(<LibraryPage params={{}} />));
    await settle();
    const labels = [...host.querySelectorAll(".k-chip")].map((c) => c.textContent);
    expect(labels).toContain("Runbooks 2");
    expect(labels.indexOf("Runbooks 2")).toBeLessThan(labels.indexOf("Design reviews 1"));
    expect(button(host, "More types")).toBeUndefined();
  });

  it("counts only notes in the chosen status, so a draft adds no chip", async () => {
    api.listNotes.mockResolvedValue([
      summary("a", { kind: "decision" }),
      summary("b", { kind: "question", status: "draft" }),
    ]);
    act(() => root.render(<LibraryPage params={{}} />));
    await settle();
    const labels = [...host.querySelectorAll(".k-chip")].map((c) => c.textContent);
    expect(labels).toContain("Decisions 1");
    expect(labels.some((l) => l?.startsWith("Questions"))).toBe(false);
  });

  it("shows more and fewer types, keeping a selected type visible", async () => {
    const kinds = ["a1", "b2", "c3", "d4", "e5", "f6", "g7", "h8"];
    api.listNotes.mockResolvedValue(
      kinds.flatMap((k, i) =>
        Array.from({ length: 10 - i }, (_, j) => summary(`${k}-${j}`, { kind: k })),
      ),
    );
    act(() => root.render(<LibraryPage params={{ kind: "h8" }} />));
    await settle();
    const chipText = () => [...host.querySelectorAll(".k-chip")].map((c) => c.textContent ?? "");
    expect(chipText().some((t) => t.startsWith("H8s"))).toBe(true);
    expect(chipText().some((t) => t.startsWith("G7s"))).toBe(false);
    act(() => button(host, "More types (1)")?.click());
    expect(chipText().some((t) => t.startsWith("G7s"))).toBe(true);
    vi.useFakeTimers();
    act(() => button(host, "Fewer types")?.click());
    // It pops down before the row closes; More types is offered again at once.
    expect(button(host, "More types (1)")?.getAttribute("aria-expanded")).toBe("false");
    act(() => vi.advanceTimersByTime(foldMs(1)));
    expect(chipText().some((t) => t.startsWith("G7s"))).toBe(false);
    vi.useRealTimers();
  });

  it("pops the extra types up in turn and down last first, and back up if reopened", async () => {
    const kinds = ["a1", "b2", "c3", "d4", "e5", "f6", "g7", "h8", "i9"];
    api.listNotes.mockResolvedValue(
      kinds.flatMap((k, i) =>
        Array.from({ length: 10 - i }, (_, j) => summary(`${k}-${j}`, { kind: k })),
      ),
    );
    act(() => root.render(<LibraryPage params={{}} />));
    await settle();
    const chip = (label: string) =>
      [...host.querySelectorAll<HTMLElement>(".k-chip")].find((c) =>
        c.textContent?.startsWith(label),
      );
    const delay = (label: string) => chip(label)?.style.getPropertyValue("--pop-delay");
    act(() => button(host, "More types (3)")?.click());
    // Only the extra chips pop, in order; the ones shown either way stay still.
    expect(chip("A1s")?.className).toBe("k-chip");
    expect(chip("G7s")?.classList.contains("library-chip-pop-in")).toBe(true);
    expect([delay("G7s"), delay("H8s"), delay("I9s")]).toEqual(["0ms", "30ms", "60ms"]);
    vi.useFakeTimers();
    act(() => button(host, "Fewer types")?.click());
    expect(chip("G7s")?.classList.contains("library-chip-pop-out")).toBe(true);
    expect([delay("G7s"), delay("H8s"), delay("I9s")]).toEqual(["40ms", "20ms", "0ms"]);
    // Reopened before the fold ends: the chips pop back up and stay.
    act(() => button(host, "More types (3)")?.click());
    expect(chip("G7s")?.classList.contains("library-chip-pop-in")).toBe(true);
    act(() => vi.advanceTimersByTime(foldMs(3)));
    expect(chip("G7s")).toBeDefined();
    expect(button(host, "Fewer types")).toBeDefined();
    vi.useRealTimers();
  });

  it("closes the extra types at once under reduced motion", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("reduce"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const kinds = ["a1", "b2", "c3", "d4", "e5", "f6", "g7"];
    api.listNotes.mockResolvedValue(
      kinds.flatMap((k, i) =>
        Array.from({ length: 10 - i }, (_, j) => summary(`${k}-${j}`, { kind: k })),
      ),
    );
    act(() => root.render(<LibraryPage params={{}} />));
    await settle();
    act(() => button(host, "More types (1)")?.click());
    act(() => button(host, "Fewer types")?.click());
    expect(
      [...host.querySelectorAll(".k-chip")].some((c) => c.textContent?.startsWith("G7s")),
    ).toBe(false);
    vi.unstubAllGlobals();
  });

  it("shows a selected type the area lacks with 0, so it can be cleared", async () => {
    act(() => root.render(<LibraryPage params={{ kind: "runbook" }} />));
    await settle();
    const chip = [...host.querySelectorAll<HTMLButtonElement>(".k-chip")].find(
      (c) => c.textContent === "Runbooks 0",
    );
    expect(chip?.getAttribute("aria-pressed")).toBe("true");
    act(() => chip?.focus());
    act(() => chip?.click());
    expect(window.location.hash).not.toContain("kind=");
    // The router passes the new params; the cleared chip unmounts, and focus must stay nearby.
    act(() => root.render(<LibraryPage params={{}} />));
    expect(host.textContent).not.toContain("Runbooks 0");
    expect(document.activeElement).not.toBe(document.body);
    expect(host.contains(document.activeElement)).toBe(true);
  });

  it("shows no count on a selected type while notes load", async () => {
    api.listNotes.mockReturnValue(new Promise(() => {}));
    act(() => root.render(<LibraryPage params={{ kind: "decision" }} />));
    await settle();
    const labels = [...host.querySelectorAll(".k-chip")].map((c) => c.textContent);
    expect(labels).toContain("Decisions");
    expect(labels).not.toContain("Decisions 0");
  });

  it("offers legacy notes when a selected type has only legacy notes", async () => {
    api.listNotes.mockResolvedValue([
      summary("a", { kind: "decision" }),
      summary("b", { kind: "runbook", status: "legacy" }),
    ]);
    act(() => root.render(<LibraryPage params={{ kind: "runbook" }} />));
    await settle();
    expect(button(host, "Show legacy notes")).toBeDefined();
    expect(button(host, "Clear filters")).toBeUndefined();
  });

  it("labels the previewed note's type in words", async () => {
    api.listNotes.mockResolvedValue([summary("demo-a", { kind: "design-review" })]);
    act(() => root.render(<LibraryPage params={{}} />));
    await settle();
    const grid = host.querySelector<HTMLTableElement>('[role="grid"]');
    act(() => {
      grid?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await settle(130);
    const facts = [...host.querySelectorAll(".library-note .k-fact")].map((f) => f.textContent);
    expect(facts).toContain("Design review");
  });

  it("keeps the typed search when the area is marked as reviewed", async () => {
    act(() => root.render(<LibraryPage params={{ since: "last-visit" }} />));
    await settle();
    const input = host.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("no search field");
    type(input, "foo");
    act(() => button(host, "Mark as reviewed")?.click());
    await settle();
    expect(input.value).toBe("foo");
  });

  it("keeps each area's selection when the area changes", async () => {
    api.listNotes.mockImplementation(async ({ domain }: { domain: string }) =>
      domain === "demo" ? NOTES : [summary("other-a", { domain: "other" })],
    );
    const params = {};
    act(() => root.render(<LibraryPage params={params} />));
    await settle();
    const grid = () => host.querySelector<HTMLTableElement>('[role="grid"]');
    act(() => {
      grid()?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(grid()?.getAttribute("aria-activedescendant")).toBe("library-row-demo-b");
    area.domain = "other";
    act(() => root.render(<LibraryPage params={params} />));
    await settle();
    expect(host.querySelectorAll('tbody tr[aria-selected="true"]').length).toBe(0);
    // Selecting in the second area must not overwrite the first area's row.
    act(() => {
      grid()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    });
    expect(grid()?.getAttribute("aria-activedescendant")).toBe("library-row-other-a");
    area.domain = "demo";
    act(() => root.render(<LibraryPage params={params} />));
    await settle();
    expect(grid()?.getAttribute("aria-activedescendant")).toBe("library-row-demo-b");
    area.domain = "other";
    act(() => root.render(<LibraryPage params={params} />));
    await settle();
    expect(grid()?.getAttribute("aria-activedescendant")).toBe("library-row-other-a");
  });

  it("never shows the last area's search hits as the next area's", async () => {
    api.searchNotes.mockImplementation(async ({ scope }: { scope: { domain: string } }) =>
      scope.domain === "demo" ? NOTES.map(hit) : new Promise(() => {}),
    );
    const params = { q: "title" };
    act(() => root.render(<LibraryPage params={params} />));
    await settle(210);
    expect(host.querySelector("#library-row-demo-a")).not.toBeNull();
    area.domain = "other";
    act(() => root.render(<LibraryPage params={params} />));
    await settle(210);
    expect(host.querySelector("#library-row-demo-a")).toBeNull();
    expect(host.textContent).toContain("Searching");
  });

  it("doesn't take focus later when the remembered note was filtered out", async () => {
    act(() => root.render(<LibraryPage params={{ status: "all" }} />));
    await settle();
    const grid = () => host.querySelector<HTMLTableElement>('[role="grid"]');
    act(() => {
      grid()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    });
    act(() => {
      grid()?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(grid()?.getAttribute("aria-activedescendant")).toBe("library-row-demo-c");
    act(() => root.unmount());
    root = createRoot(host);
    act(() => root.render(<LibraryPage params={{}} />));
    await settle();
    const input = host.querySelector<HTMLInputElement>("input");
    input?.focus();
    act(() => root.render(<LibraryPage params={{ status: "all" }} />));
    await settle();
    expect(document.activeElement).toBe(input);
  });
});

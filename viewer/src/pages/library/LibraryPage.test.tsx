import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Note, NoteSummary, SearchHit } from "../../api";
import { noteHref } from "../../app/router";

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

vi.mock("../../app/area", () => ({ useCurrentArea: () => "demo" }));

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
});

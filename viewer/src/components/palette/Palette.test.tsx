import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchHit, SearchQuery } from "../../api";
import { setCurrentArea } from "../../app/area";
import { closeOverlay, isMac, openOverlay } from "../../app/overlay";
import { AreaSwitcher } from "../area-switcher";
import { Palette } from "./index";
import { AREAS, activeLabel, hitFor, key, render, type, wait } from "./testkit";

type Pending = { query: SearchQuery; resolve: (hits: SearchHit[]) => void };
const pending: Pending[] = [];

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    listAreas: async () => AREAS,
    listNotes: async () => [],
    getVaultsConfig: async () => ({ vaults: [] }),
    searchNotes: (query: SearchQuery) =>
      new Promise<SearchHit[]>((resolve) => pending.push({ query, resolve })),
  };
});

let opener: HTMLButtonElement;

beforeEach(() => {
  setCurrentArea("personal/kioku");
  window.location.hash = "#/library";
  opener = document.createElement("button");
  opener.textContent = "Open";
  document.body.append(opener);
  opener.focus();
  render(
    <>
      <Palette />
      <AreaSwitcher />
    </>,
  );
});

afterEach(async () => {
  act(() => closeOverlay());
  await wait(220);
  document.body.innerHTML = "";
  pending.length = 0;
});

const input = () => document.activeElement as HTMLInputElement;
const mod = () => (isMac() ? { metaKey: true } : { ctrlKey: true });

describe("Palette", () => {
  it("hands focus to the switcher and back to the opener", async () => {
    act(() => openOverlay("palette"));
    expect(input().getAttribute("aria-label")).toBe("Search notes and commands");
    act(() => openOverlay("area-switcher"));
    await wait(250);
    expect(input().getAttribute("aria-label")).toBe("Find an area, a vault or a folder");
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    act(() => closeOverlay());
    await wait(250);
    expect(document.activeElement).toBe(opener);
  });

  it("keeps the chosen option when search results arrive", async () => {
    act(() => openOverlay("palette"));
    await wait(0);
    type(input(), "health");
    key(input(), "ArrowDown");
    const chosen = activeLabel();
    await wait(150);
    act(() => pending.at(-1)?.resolve([hitFor("a1", "Health checks")]));
    await wait(0);
    expect(activeLabel()).toBe(chosen);
    expect(document.body.textContent).toContain("Health checks");
  });

  it("never shows hits for older text", async () => {
    act(() => openOverlay("palette"));
    type(input(), "retry");
    await wait(150);
    act(() => pending.at(-1)?.resolve([hitFor("a1", "Retry policy")]));
    await wait(0);
    expect(document.body.textContent).toContain("Retry policy");
    type(input(), "retryx");
    expect(document.body.textContent).not.toContain("Retry policy");
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Searching…");
  });

  it("says when the search failed", async () => {
    act(() => openOverlay("palette"));
    type(input(), "boom");
    await wait(150);
    act(() => {
      const last = pending.at(-1);
      // Reject through the same promise shape the client would.
      last?.resolve(Promise.reject(new Error("down")) as unknown as SearchHit[]);
    });
    await wait(0);
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Search failed");
  });

  it("runs the active option with Enter and ignores keys while closing", async () => {
    act(() => openOverlay("palette"));
    await wait(0);
    type(input(), "go to graph");
    const field = input();
    for (let i = 0; i < 5 && activeLabel() !== "Go to Graph↵"; i++) key(field, "ArrowDown");
    expect(activeLabel()).toBe("Go to Graph↵");
    key(field, "Enter");
    expect(window.location.hash).toBe("#/graph");
    key(field, "ArrowDown");
    key(field, "Enter");
    expect(window.location.hash).toBe("#/graph");
  });

  it("opens a note in the graph with the command key", async () => {
    act(() => openOverlay("palette"));
    type(input(), "retry");
    await wait(150);
    act(() => pending.at(-1)?.resolve([hitFor("a1", "Retry policy")]));
    await wait(0);
    key(input(), "Enter", mod());
    expect(window.location.hash).toBe("#/graph?domain=personal%2Fkioku&focus=a1");
  });

  it("widens to the whole vault with Tab", async () => {
    act(() => openOverlay("palette"));
    await wait(0);
    type(input(), "retry");
    key(input(), "Tab");
    await wait(150);
    expect(pending.at(-1)?.query.scope).toEqual({ vault: "personal" });
    expect(document.body.textContent).toContain("all of personal");
  });

  it("opens empty after a quick reopen", async () => {
    act(() => openOverlay("palette"));
    type(input(), "old query");
    act(() => closeOverlay());
    await wait(50);
    act(() => openOverlay("palette"));
    expect(input().value).toBe("");
  });

  it("points aria-activedescendant at a rendered option", () => {
    act(() => openOverlay("palette"));
    const id = input().getAttribute("aria-activedescendant");
    expect(id && document.getElementById(id)?.getAttribute("role")).toBe("option");
  });
});

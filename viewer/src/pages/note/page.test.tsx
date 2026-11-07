import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReflectRun } from "../../api";
import { latestFindings, NotePage } from "./index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const control = vi.hoisted(() => ({ failNext: 0, kind: null as string | null }));

vi.mock("../../api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../api")>();
  return {
    ...real,
    getNote: (domain: string, key: string) => {
      if (control.failNext > 0) {
        control.failNext -= 1;
        return Promise.reject({ code: "internal", message: "Store is busy." });
      }
      return real
        .getNote(domain, key)
        .then((n) => (control.kind ? { ...n, kind: control.kind } : n));
    },
  };
});

const mounted: { root: Root; container: HTMLElement }[] = [];

async function renderPage(domain: string, noteKey: string): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(<NotePage domain={domain} noteKey={noteKey} />));
  await settle();
  return container;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => new Promise((r) => setTimeout(r, 0)));
  }
}

afterEach(() => {
  control.failNext = 0;
  control.kind = null;
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("NotePage", () => {
  it("renders a note with its links and graph link", async () => {
    const c = await renderPage("personal/kioku", "memory-stack");
    expect(c.querySelector("h1#note-title")?.textContent).toBeTruthy();
    expect(c.querySelector('a[href^="#/note/personal/kioku/"]')).not.toBeNull();
    expect(
      c.querySelector('a[href="#/graph?domain=personal%2Fkioku&focus=memory-stack"]'),
    ).not.toBeNull();
    expect(c.querySelector(".k-pill-unverified")).toBeNull();
  });

  it("labels the note's type in words", async () => {
    control.kind = "design-review";
    const c = await renderPage("personal/kioku", "memory-stack");
    expect(c.textContent).toContain("Design review");
    expect(c.textContent).not.toContain("design-review");
  });

  it("shows an empty state for an unknown key", async () => {
    const c = await renderPage("personal/kioku", "nope");
    expect(c.querySelector(".k-empty h3")?.textContent).toContain("No note nope");
    expect(c.querySelector("#note-title")).not.toBeNull();
  });

  it("loads again after Try again", async () => {
    control.failNext = 1;
    const c = await renderPage("personal/kioku", "memory-stack");
    const retry = [...c.querySelectorAll("button")].find((b) => b.textContent === "Try again");
    expect(retry).toBeDefined();
    await act(async () => retry?.click());
    await settle();
    expect(c.querySelector(".k-empty")).toBeNull();
    expect(document.activeElement?.id).toBe("note-title");
  });
});

describe("latestFindings", () => {
  const run = (id: string, at: string, keys: string[]): ReflectRun => ({
    id,
    domain: "personal/kioku",
    startedAt: at,
    finishedAt: at,
    harness: "demo",
    findings: keys.map((k, i) => ({ id: `f${i}`, state: "unverified", text: "x", noteKeys: [k] })),
  });

  it("ignores findings from older runs", () => {
    const runs = [run("old", "2026-11-01", ["a"]), run("new", "2026-11-05", [])];
    expect(latestFindings(runs, "a")).toEqual([]);
  });

  it("skips a run that has not finished", () => {
    const pending = { ...run("now", "2026-11-06", []), finishedAt: null };
    const found = latestFindings([pending, run("done", "2026-11-05", ["a"])], "a");
    expect(found.map((f) => f.runId)).toEqual(["done"]);
  });
});

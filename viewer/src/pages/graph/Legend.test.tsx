import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphData, GraphNode } from "../../api";
import { GraphView } from "./GraphView";
import { DEFAULT_FILTERS, isVisible, toggleHidden } from "./model";
import { GraphRenderer } from "./renderer";
import type { Emphasis, Scene } from "./scene";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<{ root: Root; host: HTMLElement }> = [];

afterEach(() => {
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
  vi.unstubAllGlobals();
});

const node = (key: string, kind: string): GraphNode => ({
  key,
  domain: "legend",
  title: key,
  kind,
  status: "active",
  degree: 0,
});

const KINDS = [
  "decision",
  "question",
  "runbook",
  "document",
  "design-review",
  "fix",
  "gotcha",
  "convention",
  "preference",
  "ticket",
  "topic",
];

/** Decisions most common, then one fewer of each type down the list. */
function manyTypes(): GraphData {
  const nodes = KINDS.flatMap((kind, i) =>
    Array.from({ length: KINDS.length - i }, (_, j) => node(`${kind}-${j}`, kind)),
  );
  return {
    nodes,
    edges: [{ source: "decision-0", target: "runbook-0", relation: "related", suggested: false }],
  };
}

// jsdom has no 2D context, so these read what the page hands the renderer.
function lastScene(): Scene {
  const calls = vi.mocked(GraphRenderer.prototype.setScene).mock.calls;
  const scene = calls.at(-1)?.[0];
  if (!scene) throw new Error("no scene");
  return scene;
}
function lastEmphasis(): Emphasis | undefined {
  return vi.mocked(GraphRenderer.prototype.setEmphasis).mock.calls.at(-1)?.[0];
}
const litCount = () => lastEmphasis()?.lit?.size ?? 0;

function render(data: GraphData = manyTypes()) {
  vi.spyOn(GraphRenderer.prototype, "setScene");
  vi.spyOn(GraphRenderer.prototype, "setEmphasis");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push({ root, host });
  act(() =>
    root.render(
      <GraphView
        domain="legend"
        areaLabel="legend"
        data={data}
        initialFocus={undefined}
        areaButton={null}
      />,
    ),
  );
  return host;
}

const rows = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>(".k-type-row")];
const selects = (host: HTMLElement) => [
  ...host.querySelectorAll<HTMLSelectElement>(".k-legend-select"),
];

function pick(select: HTMLSelectElement | undefined, value: string) {
  if (!select) throw new Error("no select");
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("hidden types", () => {
  it("shows every type by default and hides a toggled one", () => {
    const d = node("a", "runbook");
    expect(isVisible(d, DEFAULT_FILTERS)).toBe(true);
    const off = toggleHidden(DEFAULT_FILTERS, "runbook");
    expect(isVisible(d, off)).toBe(false);
    expect(isVisible(d, toggleHidden(off, "runbook"))).toBe(true);
    expect(DEFAULT_FILTERS.hidden.size).toBe(0);
  });
});

describe("Legend", () => {
  it("labels three colour selects with every non-topic type and its count", () => {
    const host = render();
    const s = selects(host);
    expect(s).toHaveLength(3);
    const labels = [...host.querySelectorAll(".k-legend-colour-name")].map((l) => l.textContent);
    expect(labels).toEqual(["Blue", "Orange", "Green"]);
    expect(s[0]?.value).toBe("decision");
    expect(s[1]?.value).toBe("question");
    expect(s[2]?.value).toBe("");
    const options = [...(s[2]?.options ?? [])].map((o) => o.textContent);
    expect(options[0]).toBe("No colour");
    expect(options).toContain("Design reviews (7)");
    expect(options.some((o) => o?.startsWith("Topics"))).toBe(false);
  });

  it("moves a type between colours and recolours its dots", () => {
    const host = render();
    pick(selects(host)[2], "decision");
    expect(selects(host).map((s) => s.value)).toEqual(["", "question", "decision"]);
    const tones = new Set(
      lastScene()
        .nodes.filter((n) => n.key.startsWith("decision-"))
        .map((n) => n.tone),
    );
    expect([...tones]).toEqual(["slot3"]);
    expect(lastScene().nodes.find((n) => n.key === "runbook-0")?.tone).toBe("other");
    expect(lastScene().nodes.find((n) => n.key === "topic-0")?.tone).toBe("topic");
  });

  it("shows the first 8 types, then all of them on request", () => {
    const host = render();
    expect(rows(host)).toHaveLength(8);
    const more = host.querySelector<HTMLButtonElement>(".k-legend-more");
    expect(more?.textContent).toBe("Show all 11 types");
    act(() => more?.click());
    expect(rows(host)).toHaveLength(11);
    expect(more?.textContent).toBe("Show fewer");
  });

  it("keeps a hidden type listed and turns its notes off", () => {
    const host = render();
    const before = lastScene().nodes.length;
    const runbooks = rows(host).find((r) => r.textContent?.startsWith("Runbooks"));
    act(() => runbooks?.click());
    expect(runbooks?.getAttribute("aria-pressed")).toBe("false");
    expect(rows(host)).toContain(runbooks);
    expect(lastScene().nodes.length).toBe(before - 9);
    expect(lastScene().nodes.some((n) => n.key.startsWith("runbook-"))).toBe(false);
    // The one link touched a runbook, so it is left out too.
    expect(lastScene().edges).toHaveLength(0);
  });

  it("highlights a type on hover and on keyboard focus", () => {
    const host = render();
    const runbooks = rows(host).find((r) => r.textContent?.startsWith("Runbooks"));
    if (!runbooks) throw new Error("no row");
    act(() => {
      runbooks.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    // Only the 9 runbooks stay lit; the renderer dims the rest.
    expect(litCount()).toBe(9);
    expect([...(lastEmphasis()?.lit ?? [])].every((k) => k.startsWith("runbook-"))).toBe(true);
    act(() => {
      runbooks.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    expect(lastEmphasis()?.lit).toBeNull();
    act(() => runbooks.focus());
    expect(litCount()).toBe(9);
    act(() => runbooks.blur());
    expect(lastEmphasis()?.lit).toBeNull();
  });

  it("ignores the highlight once its type is hidden", () => {
    const host = render();
    const runbooks = rows(host).find((r) => r.textContent?.startsWith("Runbooks"));
    if (!runbooks) throw new Error("no row");
    act(() => runbooks.focus());
    expect(litCount()).toBeGreaterThan(0);
    act(() => runbooks.click());
    expect(lastEmphasis()?.lit).toBeNull();
  });

  it("keeps a hidden type listed after collapsing the list", () => {
    const host = render();
    const more = host.querySelector<HTMLButtonElement>(".k-legend-more");
    act(() => more?.click());
    const prefs = rows(host).find((r) => r.textContent?.startsWith("Preferences"));
    act(() => prefs?.click());
    act(() => more?.click());
    expect(rows(host)).toHaveLength(9);
    expect(rows(host).some((r) => r.textContent?.startsWith("Preferences"))).toBe(true);
    expect(more?.textContent).toBe("Show all 11 types");
  });
});

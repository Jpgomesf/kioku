import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphData, GraphNode } from "../../api";
import { getGraph } from "../../api/graph/mock";
import { graphHref } from "../../app/router";
import { type Camera, STEPS, toScreen } from "./camera";
import { GraphView } from "./GraphView";
import { clearLayoutCache } from "./layout";
import { paletteColour } from "./palette";
import { GraphRenderer } from "./renderer";
import type { DisplayOptions, Emphasis, Scene } from "./scene";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<{ root: Root; host: HTMLElement }> = [];

afterEach(() => {
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "#/");
  // Settings and the panel's open state are saved per browser; every test starts afresh.
  try {
    window.localStorage?.clear();
  } catch {
    // No storage in this environment: nothing was saved.
  }
  clearLayoutCache();
});

/** The page's renderer, caught as it receives its first scene. */
let renderer: GraphRenderer | null = null;
/** What the page last handed the renderer: jsdom has no 2D context to read back. */
let scene: Scene = { nodes: [], edges: [] };
let positions: { xs: Float64Array; ys: Float64Array } | null = null;

function render(focus: string | undefined, data: GraphData = getGraph({ domain: "demo" })) {
  renderer = null;
  positions = null;
  const realScene = GraphRenderer.prototype.setScene;
  vi.spyOn(GraphRenderer.prototype, "setScene").mockImplementation(function (
    this: GraphRenderer,
    next,
  ) {
    renderer = this;
    scene = next;
    realScene.call(this, next);
  });
  const realPositions = GraphRenderer.prototype.setPositions;
  vi.spyOn(GraphRenderer.prototype, "setPositions").mockImplementation(function (
    this: GraphRenderer,
    xs,
    ys,
  ) {
    positions = { xs: Float64Array.from(xs), ys: Float64Array.from(ys) };
    realPositions.call(this, xs, ys);
  });
  vi.spyOn(GraphRenderer.prototype, "setEmphasis");
  vi.spyOn(GraphRenderer.prototype, "setDisplay");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push({ root, host });
  act(() =>
    root.render(
      <GraphView
        domain="demo"
        areaLabel="demo"
        data={data}
        initialFocus={focus}
        areaButton={null}
      />,
    ),
  );
  return host;
}

const frames = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });

const stageOf = (host: HTMLElement) => host.querySelector<HTMLElement>(".graph-stage");
const caption = (host: HTMLElement) => host.querySelector(".k-count")?.textContent ?? "";

function key(target: Element | null, k: string) {
  act(() => {
    target?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
}

const VIEW = { width: 1000, height: 640 };

/** Where the renderer's camera draws a note's dot, from the positions the page handed it. */
function dotAt(noteKey: string) {
  const i = scene.nodes.findIndex((n) => n.key === noteKey);
  const x = positions?.xs[i];
  const y = positions?.ys[i];
  if (i < 0 || x === undefined || y === undefined || !renderer) throw new Error("no position");
  return toScreen(renderer.camera, { x, y });
}

const lastEmphasis = (): Emphasis | undefined =>
  vi.mocked(GraphRenderer.prototype.setEmphasis).mock.calls.at(-1)?.[0];
const lastDisplay = (): DisplayOptions | undefined =>
  vi.mocked(GraphRenderer.prototype.setDisplay).mock.calls.at(-1)?.[0];

const settingsButton = (host: HTMLElement) =>
  host.querySelector<HTMLButtonElement>('button[aria-label="Graph settings"]');
const panelOf = (host: HTMLElement) => host.querySelector<HTMLElement>(".gs-panel");

function openSettings(host: HTMLElement): HTMLElement {
  const button = settingsButton(host);
  button?.focus();
  act(() => button?.click());
  const panel = panelOf(host);
  if (!panel) throw new Error("no settings panel");
  return panel;
}

/** A settings switch, found by the text of the label it is named by. */
function switchNamed(host: HTMLElement, name: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="switch"]')).find(
    (b) => document.getElementById(b.getAttribute("aria-labelledby") ?? "")?.textContent === name,
  );
  if (!found) throw new Error(`no switch named ${name}`);
  return found;
}

/** Sets an input's value the way React's onChange sees it. */
function typeInto(input: HTMLInputElement | null, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setValue?.call(input, value);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pointer(host: HTMLElement, type: string, x: number, y: number, buttons = 1) {
  act(() => {
    stageOf(host)?.dispatchEvent(
      new MouseEvent(type, { bubbles: true, button: 0, buttons, clientX: x, clientY: y }),
    );
  });
}

/** Clicks the stage at a note's dot, as the whole-area camera draws it. */
function clickDot(host: HTMLElement, noteKey: string) {
  const s = dotAt(noteKey);
  pointer(host, "pointerdown", s.x, s.y);
  pointer(host, "pointerup", s.x, s.y);
}

const cameraOf = (): Camera => {
  if (!renderer) throw new Error("no renderer");
  return renderer.camera;
};

const node = (key: string, kind: GraphNode["kind"] = "decision"): GraphNode => ({
  key,
  domain: "demo",
  title: `Title ${key}`,
  kind,
  status: "active",
  degree: 1,
});

describe("GraphView", () => {
  it("opens on the whole area without a focus", () => {
    const host = render(undefined);
    expect(caption(host)).toContain("Whole area:");
    expect(host.querySelector(".graph-card-focus")).toBeNull();
  });

  it("opens zoomed on the focus note, with its cards and inspector", () => {
    const host = render("jobs-worker");
    expect(caption(host)).toContain("Around jobs-worker");
    expect(host.querySelector(".graph-card-focus")?.getAttribute("href")).toContain("jobs-worker");
    expect(host.querySelectorAll(".graph-card:not(.graph-card-focus)").length).toBeGreaterThan(0);
    expect(host.querySelector("#graph-inspector-title")).not.toBeNull();
  });

  it("formats counts with thousands separators", () => {
    const nodes = Array.from({ length: 1200 }, (_, i) => node(`n${i}`));
    const host = render(undefined, { nodes, edges: [] });
    expect(caption(host)).toContain("1,200 notes");
  });

  it("zooms out one step on Escape", () => {
    const host = render("jobs-worker");
    key(stageOf(host), "Escape");
    expect(caption(host)).toContain("Neighbourhood: jobs-worker");
  });

  it("zooms out on Escape from the step buttons too", () => {
    const host = render("jobs-worker");
    key(host.querySelector('button[aria-label="Zoom in"]'), "Escape");
    expect(caption(host)).toContain("Neighbourhood: jobs-worker");
  });

  it("selects a note when its dot is clicked, and grows its cards out of the dots", async () => {
    const host = render(undefined);
    clickDot(host, "jobs-worker");
    expect(caption(host)).toContain("jobs-worker");
    const card = host.querySelector<HTMLElement>(".graph-card:not(.graph-card-focus)");
    expect(card).not.toBeNull();
    expect(card?.style.opacity).toBe("0");
    expect(card?.hasAttribute("inert")).toBe(true);
    await frames();
    const after = host.querySelector<HTMLElement>(".graph-card:not(.graph-card-focus)");
    expect(after?.style.opacity).toBe("1");
    expect(after?.hasAttribute("inert")).toBe(false);
  });

  it("draws on one hidden canvas, not SVG elements per note", () => {
    const host = render(undefined);
    const canvas = stageOf(host)?.querySelectorAll("canvas");
    expect(canvas).toHaveLength(1);
    expect(canvas?.[0]?.getAttribute("aria-hidden")).toBe("true");
    expect(stageOf(host)?.querySelectorAll("circle")).toHaveLength(0);
    expect(stageOf(host)?.getAttribute("role")).toBe("application");
    expect(renderer?.pick(dotAt("jobs-worker").x, dotAt("jobs-worker").y)).toBe("jobs-worker");
  });

  it("animates step moves", () => {
    const animate = vi.spyOn(GraphRenderer.prototype, "animateTo");
    const host = render(undefined);
    clickDot(host, "jobs-worker");
    expect(animate).toHaveBeenCalled();
    expect(animate.mock.calls.at(-1)?.[1]).toBeGreaterThan(0);
  });

  it("makes moves instant under reduced motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("reduce"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const host = render(undefined);
    const fitS = cameraOf().s;
    clickDot(host, "jobs-worker");
    // The renderer is already at the neighbourhood step, with no frames in between.
    expect(cameraOf().s).toBeCloseTo(fitS * STEPS[2]);
    const card = host.querySelector<HTMLElement>(".graph-card:not(.graph-card-focus)");
    expect(card?.style.opacity).toBe("1");
  });

  it("zooms with ctrl and the wheel", async () => {
    const host = render(undefined);
    act(() => {
      for (let i = 0; i < 4; i += 1) {
        stageOf(host)?.dispatchEvent(
          new WheelEvent("wheel", { deltaY: -200, ctrlKey: true, cancelable: true }),
        );
      }
    });
    // The renderer moves at once; React hears about it once the wheel goes quiet.
    expect(cameraOf().s).toBeGreaterThan(1);
    expect(caption(host)).toContain("Whole area:");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(caption(host)).not.toContain("Whole area:");
  });

  it("drags the camera on the renderer, and a drag is not a click", () => {
    const host = render(undefined);
    const before = cameraOf();
    pointer(host, "pointerdown", 500, 300);
    pointer(host, "pointermove", 560, 330);
    pointer(host, "pointermove", 620, 360);
    expect(cameraOf().x).toBeCloseTo(before.x + 120);
    expect(stageOf(host)?.classList.contains("graph-live")).toBe(true);
    pointer(host, "pointerup", 620, 360, 0);
    expect(stageOf(host)?.classList.contains("graph-live")).toBe(false);
    expect(caption(host)).toContain("Whole area:");
    // A drag is not a click: nothing got focused.
    expect(host.querySelector("#graph-inspector-title")).toBeNull();
  });

  it("moves the dot grid and the overlay with the renderer's camera", () => {
    const host = render("jobs-worker");
    const card = host.querySelector<HTMLElement>(".graph-card-focus");
    const before = card?.style.transform;
    const gridBefore = stageOf(host)?.style.getPropertyValue("--dot-x");
    act(() => renderer?.setCamera({ ...cameraOf(), x: cameraOf().x + 40 }));
    expect(card?.style.transform).not.toBe(before);
    expect(stageOf(host)?.style.getPropertyValue("--dot-x")).not.toBe(gridBefore);
  });

  it("points over notes on hover", async () => {
    const host = render(undefined);
    const s = dotAt("jobs-worker");
    pointer(host, "pointermove", s.x, s.y, 0);
    await frames();
    expect(stageOf(host)?.style.cursor).toBe("pointer");
    pointer(host, "pointermove", 2, 2, 0);
    await frames();
    expect(stageOf(host)?.style.cursor).toBe("");
  });

  it("opens the note nearest the centre on Enter", () => {
    const host = render(undefined);
    const expected = renderer?.nearest(VIEW.width / 2, VIEW.height / 2);
    expect(expected).toBeTruthy();
    key(stageOf(host), "Enter");
    expect(caption(host)).toContain(`Neighbourhood: ${expected}`);
  });

  it("zooms with plus and minus, animated", () => {
    const animate = vi.spyOn(GraphRenderer.prototype, "animateTo");
    const host = render(undefined);
    for (let i = 0; i < 3; i += 1) key(stageOf(host), "+");
    expect(caption(host)).not.toContain("Whole area:");
    expect(animate).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i += 1) key(stageOf(host), "-");
    expect(caption(host)).toContain("Whole area:");
  });

  it("keeps the URL on the selection", () => {
    const host = render(undefined);
    clickDot(host, "jobs-worker");
    expect(window.location.hash).toBe(graphHref("demo", "jobs-worker"));
  });

  it("keeps keyboard focus on the stage after a card click, so Esc still works", async () => {
    const host = render("jobs-worker");
    await frames();
    const card = host.querySelector<HTMLButtonElement>("button.graph-card");
    card?.focus();
    act(() => card?.click());
    expect(stageOf(host)?.contains(document.activeElement)).toBe(true);
    const before = caption(host);
    key(document.activeElement, "Escape");
    expect(caption(host)).not.toBe(before);
  });

  it("follows a link back to the original focus after moving", async () => {
    const host = render("jobs-worker");
    await frames();
    const card = host.querySelector<HTMLButtonElement>("button.graph-card");
    act(() => card?.click());
    expect(host.querySelector(".graph-card-focus")?.getAttribute("href")).not.toContain(
      "jobs-worker",
    );
    act(() => {
      window.location.hash = graphHref("demo", "jobs-worker");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(host.querySelector(".graph-card-focus")?.getAttribute("href")).toContain("jobs-worker");
  });

  it("opens a folded group into its notes", async () => {
    const nodes = [node("f"), ...Array.from({ length: 6 }, (_, i) => node(`d${i}`))];
    const edges = nodes
      .slice(1)
      .map((n) => ({ source: "f", target: n.key, relation: "narrows", suggested: false }));
    const host = render("f", { nodes, edges });
    await frames();
    const group = host.querySelector<HTMLButtonElement>(".graph-card-group");
    expect(group).not.toBeNull();
    act(() => group?.click());
    expect(host.querySelector(".graph-card-group")).toBeNull();
    expect(host.querySelectorAll("button.graph-card")).toHaveLength(6);
  });

  it("draws legacy links as neutral dashes, not reflect findings", () => {
    const nodes = [node("f"), { ...node("old"), status: "legacy" as const }];
    const edges = [{ source: "f", target: "old", relation: "supersedes", suggested: false }];
    const host = render("f", { nodes, edges });
    expect(host.querySelector(".graph-focus-edges .graph-edge-legacy")).not.toBeNull();
    expect(host.querySelector(".graph-focus-edges .graph-edge-suggested")).toBeNull();
  });

  it("drops the focus and inspector when the selected note is filtered out", () => {
    const nodes = [node("f"), { ...node("old"), status: "legacy" as const }];
    const edges = [{ source: "f", target: "old", relation: "supersedes", suggested: false }];
    const host = render("old", { nodes, edges });
    expect(host.querySelector("#graph-inspector-title")).not.toBeNull();
    openSettings(host);
    act(() => switchNamed(host, "Legacy notes").click());
    expect(host.querySelector("#graph-inspector-title")).toBeNull();
    expect(host.querySelector(".graph-card-focus")?.getAttribute("href") ?? "").not.toContain(
      "old",
    );
  });

  it("does not add a history entry for a later Esc after re-picking the same note", () => {
    const host = render("jobs-worker");
    typeInto(host.querySelector<HTMLInputElement>(".graph-find input"), "jobs-worker");
    const match = Array.from(host.querySelectorAll<HTMLButtonElement>(".graph-match")).find((b) =>
      b.textContent?.includes("jobs-worker"),
    );
    expect(match).toBeDefined();
    act(() => match?.click());
    const push = vi.spyOn(window.history, "pushState");
    for (let i = 0; i < 4; i += 1) key(stageOf(host), "Escape");
    expect(window.location.hash).toBe(graphHref("demo"));
    expect(push).not.toHaveBeenCalled();
    push.mockRestore();
  });

  it("says when an area has no notes", () => {
    const host = render(undefined, { nodes: [], edges: [] });
    expect(host.textContent).toContain("No notes in this area yet");
  });

  it("says when a focus isn't in the area", () => {
    const host = render("not-a-note");
    expect(host.textContent).toContain("isn't in demo");
    expect(caption(host)).toContain("Whole area:");
  });

  it("gives the canvas the full width, with find-a-note in the header", () => {
    const host = render(undefined);
    expect(host.querySelector("aside")).toBeNull();
    expect(host.querySelector(".graph-head .graph-find input")).not.toBeNull();
    expect(panelOf(host)).toBeNull();
  });

  it("floats the inspector over the canvas, with a close button", () => {
    const host = render("jobs-worker");
    const float = host.querySelector(".graph-float-inspector");
    expect(float?.querySelector("#graph-inspector-title")).not.toBeNull();
    act(() =>
      float?.querySelector<HTMLButtonElement>('button[aria-label="Clear the selection"]')?.click(),
    );
    expect(host.querySelector(".graph-float-inspector")).toBeNull();
  });

  it("colours every note type with its own group colour", () => {
    render(undefined);
    const byKind = new Map<string, Set<string>>();
    const data = getGraph({ domain: "demo" });
    const kindOf = new Map(data.nodes.map((n) => [n.key, n.kind]));
    for (const n of scene.nodes) {
      const kind = kindOf.get(n.key) ?? "";
      byKind.set(kind, (byKind.get(kind) ?? new Set()).add(n.color));
    }
    // One colour per type, a different one for each, and none of them the grey for no group.
    for (const colours of byKind.values()) expect(colours.size).toBe(1);
    const all = [...byKind.values()].map((c) => [...c][0]);
    expect(new Set(all).size).toBe(byKind.size);
    expect(all).toContain(paletteColour(0));
    expect(all).not.toContain("#8a8b93");
  });

  it("opens the settings behind the gear and closes them on Escape, focus back on the gear", () => {
    const host = render(undefined);
    const panel = openSettings(host);
    expect(settingsButton(host)?.getAttribute("aria-expanded")).toBe("true");
    expect(panel.textContent).toContain("Filters");
    expect(panel.textContent).toContain("Forces");
    const before = caption(host);
    key(panel.querySelector("input"), "Escape");
    expect(panelOf(host)).toBeNull();
    expect(document.activeElement).toBe(settingsButton(host));
    // Escape in the panel only closes it: the graph did not zoom out.
    expect(caption(host)).toBe(before);
  });

  it("closes the settings on Escape while focus is still on the gear", () => {
    const host = render(undefined);
    openSettings(host);
    const before = caption(host);
    settingsButton(host)?.focus();
    key(settingsButton(host), "Escape");
    expect(panelOf(host)).toBeNull();
    expect(document.activeElement).toBe(settingsButton(host));
    expect(caption(host)).toBe(before);
  });

  it("filters notes by the search query and drops orphans when asked", () => {
    const nodes = [node("a"), node("b"), node("lonely"), { ...node("q"), kind: "question" }];
    const edges = [
      { source: "a", target: "b", relation: "related", suggested: false },
      { source: "a", target: "q", relation: "related", suggested: false },
    ];
    const host = render(undefined, { nodes, edges });
    expect(scene.nodes.map((n) => n.key).sort()).toEqual(["a", "b", "lonely", "q"]);
    const panel = openSettings(host);
    typeInto(
      panel.querySelector<HTMLInputElement>('[aria-label="Search notes"]'),
      "-type:question",
    );
    expect(scene.nodes.map((n) => n.key).sort()).toEqual(["a", "b", "lonely"]);
    act(() => switchNamed(host, "Orphans").click());
    expect(scene.nodes.map((n) => n.key).sort()).toEqual(["a", "b"]);
  });

  it("hides suggested links when that filter is off", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const edges = [
      { source: "a", target: "b", relation: "related", suggested: false },
      { source: "a", target: "c", relation: "related", suggested: true },
    ];
    const host = render(undefined, { nodes, edges });
    expect(scene.edges).toHaveLength(2);
    openSettings(host);
    act(() => switchNamed(host, "Links Reflect suggests").click());
    expect(scene.edges).toHaveLength(1);
    expect(scene.edges[0]?.suggested).toBe(false);
  });

  it("lights the notes a group matches while its row has focus", () => {
    const nodes = [node("a"), node("b"), { ...node("q"), kind: "question" }];
    const host = render(undefined, { nodes, edges: [] });
    const panel = openSettings(host);
    const rows = panel.querySelectorAll<HTMLInputElement>(".gs-group .gs-input");
    // Decisions are the most common type, so the first group is type:decision.
    act(() => rows[0]?.focus());
    expect([...(lastEmphasis()?.lit ?? [])].sort()).toEqual(["a", "b"]);
    act(() => rows[0]?.blur());
    expect(lastEmphasis()?.lit ?? null).toBeNull();
  });

  it("hands the display settings to the renderer", () => {
    const host = render(undefined);
    expect(lastDisplay()).toEqual({ nodeSize: 1, linkThickness: 1, arrows: false, textFade: 0 });
    openSettings(host);
    act(() => switchNamed(host, "Arrows").click());
    expect(lastDisplay()?.arrows).toBe(true);
  });

  it("hides the topic labels when that display setting is off", () => {
    const nodes = [node("a"), { ...node("t"), kind: "topic", title: "A topic" }];
    const edges = [{ source: "a", target: "t", relation: "in topic", suggested: false }];
    const host = render(undefined, { nodes, edges });
    expect(host.querySelector(".graph-topic-label")?.textContent).toBe("A topic");
    openSettings(host);
    act(() => switchNamed(host, "Topic labels").click());
    expect(host.querySelector(".graph-topic-label")).toBeNull();
  });

  it("keeps the camera when the forces change after the viewer moved it", () => {
    const host = render(undefined);
    pointer(host, "pointerdown", 500, 300);
    pointer(host, "pointermove", 600, 350);
    pointer(host, "pointerup", 600, 350, 0);
    const moved = cameraOf();
    const panel = openSettings(host);
    const repel = Array.from(panel.querySelectorAll<HTMLInputElement>('input[type="range"]')).find(
      (r) => panel.querySelector(`label[for="${r.id}"]`)?.textContent === "Repel force",
    );
    typeInto(repel ?? null, "18");
    expect(cameraOf()).toEqual(moved);
  });
});

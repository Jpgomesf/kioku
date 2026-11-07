import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphData, GraphNode } from "../../api";
import { getGraph } from "../../api/graph/mock";
import { graphHref } from "../../app/router";
import { type Camera, toScreen } from "./camera";
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
const caption = (host: HTMLElement) => host.querySelector("#graph-caption")?.textContent ?? "";

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
  tags: [],
  updatedAt: "2026-11-01T10:00:00Z",
});

describe("GraphView", () => {
  it("opens on the whole area without a focus, with no header", () => {
    const host = render(undefined);
    expect(caption(host)).toContain("notes and");
    expect(caption(host)).not.toContain("Selected");
    expect(host.querySelector("header")).toBeNull();
    expect(host.querySelector(".graph-card")).toBeNull();
  });

  it("opens with the focus note selected and inspected, but no cards", () => {
    const host = render("jobs-worker");
    expect(caption(host)).toContain("Selected jobs-worker");
    expect(host.querySelector("#graph-inspector-title")).not.toBeNull();
    expect(host.querySelector(".graph-card")).toBeNull();
    expect(lastEmphasis()?.focusKey).toBe("jobs-worker");
  });

  it("formats counts with thousands separators", () => {
    const nodes = Array.from({ length: 1200 }, (_, i) => node(`n${i}`));
    const host = render(undefined, { nodes, edges: [] });
    expect(caption(host)).toContain("1,200 notes");
  });

  it("clears the selection on Escape", () => {
    const host = render("jobs-worker");
    key(stageOf(host), "Escape");
    expect(host.querySelector("#graph-inspector-title")).toBeNull();
    expect(caption(host)).not.toContain("Selected");
  });

  it("selects a clicked note without moving the camera", () => {
    const animate = vi.spyOn(GraphRenderer.prototype, "animateTo");
    const host = render(undefined);
    const before = cameraOf();
    clickDot(host, "jobs-worker");
    expect(caption(host)).toContain("Selected jobs-worker");
    expect(host.querySelector("#graph-inspector-title")).not.toBeNull();
    expect(cameraOf()).toEqual(before);
    expect(animate).not.toHaveBeenCalled();
    expect(host.querySelector(".graph-card")).toBeNull();
  });

  it("clears the selection on a click on empty canvas", () => {
    const host = render("jobs-worker");
    pointer(host, "pointerdown", 1, 1);
    pointer(host, "pointerup", 1, 1, 0);
    expect(host.querySelector("#graph-inspector-title")).toBeNull();
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

  it("makes key moves instant under reduced motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("reduce"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const host = render(undefined);
    const fitS = cameraOf().s;
    key(stageOf(host), "+");
    expect(cameraOf().s).toBeCloseTo(fitS * 1.25);
  });

  it("zooms freely with the wheel, never into the card levels", async () => {
    const host = render(undefined);
    clickDot(host, "jobs-worker");
    act(() => {
      for (let i = 0; i < 12; i += 1) {
        stageOf(host)?.dispatchEvent(
          new WheelEvent("wheel", { deltaY: -200, ctrlKey: true, cancelable: true }),
        );
      }
    });
    expect(cameraOf().s).toBeGreaterThan(2);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(host.querySelector(".graph-card")).toBeNull();
  });

  it("drags the camera on the renderer, and a drag is not a click", () => {
    const host = render("jobs-worker");
    const before = cameraOf();
    pointer(host, "pointerdown", 500, 300);
    pointer(host, "pointermove", 560, 330);
    pointer(host, "pointermove", 620, 360);
    expect(cameraOf().x).toBeCloseTo(before.x + 120);
    expect(stageOf(host)?.classList.contains("graph-live")).toBe(true);
    pointer(host, "pointerup", 620, 360, 0);
    expect(stageOf(host)?.classList.contains("graph-live")).toBe(false);
    // A drag is not a click: the selection stays.
    expect(host.querySelector("#graph-inspector-title")).not.toBeNull();
  });

  it("moves the dot grid and the overlay with the renderer's camera", () => {
    const host = render(undefined);
    const label = host.querySelector<HTMLElement>(".graph-topic-label");
    expect(label).not.toBeNull();
    const before = label?.style.transform;
    const gridBefore = stageOf(host)?.style.getPropertyValue("--dot-x");
    act(() => renderer?.setCamera({ ...cameraOf(), x: cameraOf().x + 40 }));
    expect(label?.style.transform).not.toBe(before);
    expect(stageOf(host)?.style.getPropertyValue("--dot-x")).not.toBe(gridBefore);
  });

  it("lights the hovered note and its neighbours", async () => {
    const nodes = [node("a"), node("b"), node("c")];
    const edges = [{ source: "a", target: "b", relation: "related", suggested: false }];
    const host = render(undefined, { nodes, edges });
    const s = dotAt("a");
    pointer(host, "pointermove", s.x, s.y, 0);
    await frames();
    expect(stageOf(host)?.style.cursor).toBe("pointer");
    expect(lastEmphasis()?.hoverKey).toBe("a");
    expect([...(lastEmphasis()?.lit ?? [])].sort()).toEqual(["a", "b"]);
    pointer(host, "pointermove", 1, 1, 0);
    await frames();
    expect(stageOf(host)?.style.cursor).toBe("");
    expect(lastEmphasis()?.lit ?? null).toBeNull();
  });

  it("selects the note nearest the centre on Enter", () => {
    const host = render(undefined);
    const expected = renderer?.nearest(VIEW.width / 2, VIEW.height / 2);
    expect(expected).toBeTruthy();
    key(stageOf(host), "Enter");
    expect(caption(host)).toContain(`Selected ${expected}`);
  });

  it("zooms with plus and minus, animated, and fits with 0", () => {
    const animate = vi.spyOn(GraphRenderer.prototype, "animateTo");
    const host = render(undefined);
    const fitS = cameraOf().s;
    for (let i = 0; i < 3; i += 1) key(stageOf(host), "+");
    expect(animate).toHaveBeenCalledTimes(3);
    expect(animate.mock.calls.at(-1)?.[0].s).toBeGreaterThan(fitS);
    key(stageOf(host), "0");
    expect(animate.mock.calls.at(-1)?.[0].s).toBeCloseTo(fitS);
  });

  it("keeps the URL on the selection", () => {
    const host = render(undefined);
    clickDot(host, "jobs-worker");
    expect(window.location.hash).toBe(graphHref("demo", "jobs-worker"));
  });

  it("selects a note a link names", () => {
    const host = render(undefined);
    act(() => {
      window.location.hash = graphHref("demo", "jobs-worker");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(caption(host)).toContain("Selected jobs-worker");
  });

  it("drops the selection and inspector when the selected note is filtered out", () => {
    const nodes = [node("f"), { ...node("old"), status: "legacy" as const }];
    const edges = [{ source: "f", target: "old", relation: "supersedes", suggested: false }];
    const host = render("old", { nodes, edges });
    expect(host.querySelector("#graph-inspector-title")).not.toBeNull();
    openSettings(host);
    act(() => switchNamed(host, "Legacy notes").click());
    expect(host.querySelector("#graph-inspector-title")).toBeNull();
    // Cleared, not hidden: showing legacy notes again does not bring the selection back.
    act(() => switchNamed(host, "Legacy notes").click());
    expect(host.querySelector("#graph-inspector-title")).toBeNull();
  });

  it("does not add a history entry for a later Esc after re-picking the same note", () => {
    const host = render("jobs-worker");
    clickDot(host, "jobs-worker");
    const push = vi.spyOn(window.history, "pushState");
    for (let i = 0; i < 4; i += 1) key(stageOf(host), "Escape");
    expect(window.location.hash).toBe(graphHref("demo"));
    expect(push).not.toHaveBeenCalled();
    push.mockRestore();
  });

  it("adds a node per tag, linked to its notes, when Tags is on", () => {
    const nodes = [
      { ...node("a"), tags: ["search"] },
      { ...node("b"), tags: ["#Search", "ops"] },
      node("c"),
    ];
    const host = render(undefined, { nodes, edges: [] });
    expect(scene.nodes.some((n) => n.tag)).toBe(false);
    openSettings(host);
    act(() => switchNamed(host, "Tags").click());
    const tags = scene.nodes.filter((n) => n.tag);
    expect(tags.map((n) => [n.key, n.label])).toEqual([
      ["tag:ops", "#ops"],
      ["tag:search", "#search"],
    ]);
    expect(scene.edges).toHaveLength(3);
    expect(tags[0]?.color).toBe("#9a8f7a");
    expect(caption(host)).toContain("2 tags");
  });

  it("replays the area's growth on Animate, and a click stops it", () => {
    const nodes = [
      { ...node("a"), updatedAt: "2026-01-01T00:00:00Z" },
      { ...node("b"), updatedAt: "2026-02-01T00:00:00Z" },
    ];
    const edges = [{ source: "a", target: "b", relation: "related", suggested: false }];
    const host = render(undefined, { nodes, edges });
    const panel = openSettings(host);
    const button = Array.from(panel.querySelectorAll("button")).find(
      (b) => b.textContent === "Animate",
    );
    act(() => button?.click());
    expect(scene.nodes.length).toBeLessThan(2);
    pointer(host, "pointerdown", 1, 1);
    expect(scene.nodes.map((n) => n.key).sort()).toEqual(["a", "b"]);
    expect(scene.edges).toHaveLength(1);
  });

  it("shows the end state at once on Animate under reduced motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("reduce"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const nodes = [node("a"), node("b")];
    const edges = [{ source: "a", target: "b", relation: "related", suggested: false }];
    const host = render(undefined, { nodes, edges });
    const panel = openSettings(host);
    const button = Array.from(panel.querySelectorAll("button")).find(
      (b) => b.textContent === "Animate",
    );
    act(() => button?.click());
    expect(scene.nodes).toHaveLength(2);
  });

  it("says when an area has no notes", () => {
    const host = render(undefined, { nodes: [], edges: [] });
    expect(host.textContent).toContain("No notes in this area yet");
  });

  it("says when a focus isn't in the area", () => {
    const host = render("not-a-note");
    expect(host.textContent).toContain("isn't in demo");
    expect(caption(host)).not.toContain("Selected");
  });

  it("floats the area button over the canvas, with no find-a-note", () => {
    renderer = null;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push({ root, host });
    act(() =>
      root.render(
        <GraphView
          domain="demo"
          areaLabel="demo"
          data={getGraph({ domain: "demo" })}
          initialFocus={undefined}
          areaButton={<button type="button">Area</button>}
        />,
      ),
    );
    expect(host.querySelector(".graph-float-area button")?.textContent).toBe("Area");
    expect(host.querySelector('input[type="search"], .graph-find')).toBeNull();
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
    expect(lastDisplay()).toEqual({
      nodeSize: 1,
      linkThickness: 1,
      arrows: false,
      textFade: 0,
      topicLabels: true,
    });
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
    expect(lastDisplay()?.topicLabels).toBe(false);
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

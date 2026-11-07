import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphData, GraphNode } from "../../api";
import { getGraph } from "../../api/graph/mock";
import { graphHref } from "../../app/router";
import { type Camera, fitCamera, STEPS, toScreen } from "./camera";
import { GraphView } from "./GraphView";
import { layoutFor } from "./layout";
import { GraphRenderer } from "./renderer";

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
});

/** The page's renderer, caught as it receives its first scene. */
let renderer: GraphRenderer | null = null;

function render(focus: string | undefined, data: GraphData = getGraph({ domain: "demo" })) {
  renderer = null;
  const real = GraphRenderer.prototype.setScene;
  vi.spyOn(GraphRenderer.prototype, "setScene").mockImplementation(function (
    this: GraphRenderer,
    scene,
  ) {
    renderer = this;
    real.call(this, scene);
  });
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

/** Where the whole-area camera draws a note's dot. */
function dotAt(noteKey: string, data = getGraph({ domain: "demo" })) {
  const layout = layoutFor("demo", data);
  const p = layout.positions.get(noteKey);
  if (!p) throw new Error("no position");
  return toScreen(fitCamera(layout.bounds, VIEW), p);
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
    const legacy = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="switch"]')).find(
      (b) => b.textContent?.includes("Legacy notes"),
    );
    act(() => legacy?.click());
    expect(host.querySelector("#graph-inspector-title")).toBeNull();
    expect(host.querySelector(".graph-card-focus")?.getAttribute("href") ?? "").not.toContain(
      "old",
    );
  });

  it("does not add a history entry for a later Esc after re-picking the same note", () => {
    const host = render("jobs-worker");
    const input = host.querySelector<HTMLInputElement>(".graph-find input");
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setValue?.call(input, "jobs-worker");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
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
});

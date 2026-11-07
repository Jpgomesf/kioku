import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphData, GraphNode } from "../../api";
import { getGraph } from "../../api/graph/mock";
import { graphHref } from "../../app/router";
import { type Camera, toScreen } from "./camera";
import { GraphView } from "./GraphView";
import { HINT_KEY, resetFirstVisitHint } from "./hint";
import { clearLayoutCache, useLiveLayout, type WorkerReply, type WorkerRequest } from "./layout";
import { paletteColour } from "./palette";
import { GraphRenderer } from "./renderer";
import type { DisplayOptions, Emphasis, Scene, SceneRegions } from "./scene";

// The real layout, wrapped so a test can read the clustering the page hands it.
vi.mock("./layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./layout")>();
  return { ...actual, useLiveLayout: vi.fn(actual.useLiveLayout) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<{ root: Root; host: HTMLElement }> = [];

afterEach(() => {
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
  vi.unstubAllGlobals();
  FakeWorker.last = null;
  vi.mocked(useLiveLayout).mockClear();
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
  vi.spyOn(GraphRenderer.prototype, "setRegions");
  vi.spyOn(GraphRenderer.prototype, "setDragging");
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
const lastRegions = (): SceneRegions | null | undefined =>
  vi.mocked(GraphRenderer.prototype.setRegions).mock.calls.at(-1)?.[0];

/** The emphasis's depths as a plain object, so a test can compare them at a glance. */
function depthsOf(emphasis: Emphasis | undefined): Record<string, number> | null {
  const depths = emphasis?.depths;
  return depths ? Object.fromEntries([...depths].sort(([a], [b]) => a.localeCompare(b))) : null;
}

/** The name the canvas shows for a note's region, from the regions last handed over. */
function regionName(noteKey: string): string | undefined {
  const regions = lastRegions();
  const i = scene.nodes.findIndex((n) => n.key === noteKey);
  const r = regions?.assign[i];
  return regions && r !== undefined && r >= 0 ? regions.names[r] : undefined;
}

const settingsButton = (host: HTMLElement) =>
  host.querySelector<HTMLButtonElement>('button[aria-label="Graph settings"]');
const panelOf = (host: HTMLElement) => host.querySelector<HTMLElement>(".gs-panel");

/** The settings box with every section expanded. It opens with the page and only Forces
 * starts expanded; the gear toggles it, so it is clicked only when the box is closed. */
function openSettings(host: HTMLElement): HTMLElement {
  if (!panelOf(host)) act(() => settingsButton(host)?.click());
  const panel = panelOf(host);
  if (!panel) throw new Error("no settings panel");
  for (const head of panel.querySelectorAll<HTMLButtonElement>(".gs-section-head")) {
    if (head.getAttribute("aria-expanded") === "false") act(() => head.click());
  }
  return panel;
}

/** A settings slider, found by its label. */
function sliderNamed(panel: HTMLElement, name: string): HTMLInputElement {
  const found = Array.from(panel.querySelectorAll<HTMLInputElement>('input[type="range"]')).find(
    (r) => panel.querySelector(`label[for="${r.id}"]`)?.textContent === name,
  );
  if (!found) throw new Error(`no slider named ${name}`);
  return found;
}

/** One answer of a settings choice, such as Separate by: Colour groups. */
function choice(panel: HTMLElement, label: string, option: string): HTMLButtonElement {
  const field = Array.from(panel.querySelectorAll(".k-seg-field")).find(
    (f) => f.querySelector(".k-seg-label")?.textContent === label,
  );
  const found = Array.from(field?.querySelectorAll("button") ?? []).find(
    (b) => b.textContent === option,
  );
  if (!found) throw new Error(`no ${option} in ${label}`);
  return found;
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

const link = (source: string, target: string) => ({
  source,
  target,
  relation: "related",
  suggested: false,
});

/** Notes linked in a line, a - b - c - ..., one link per step. */
function chain(...keys: string[]): GraphData {
  return {
    nodes: keys.map((k) => node(k)),
    edges: keys.slice(1).map((k, i) => link(keys[i] as string, k)),
  };
}

/** Every pair of the notes linked. */
function clique(keys: readonly string[]) {
  return keys.flatMap((a, i) => keys.slice(i + 1).map((b) => link(a, b)));
}

/** A layout worker the test drives, so positions can stream in as they do in the app: it keeps
 * what the page sends and posts the positions it is given, in layout order (sorted keys). */
class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((event: { data: WorkerReply }) => void) | null = null;
  onerror: (() => void) | null = null;
  messages: WorkerRequest[] = [];
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(message: WorkerRequest) {
    this.messages.push(message);
  }
  terminate() {}
  /** Posts positions for the run in progress, under the settings it last heard of. */
  post(xs: readonly number[], ys: readonly number[], settled: boolean) {
    let id = 0;
    let rev = 0;
    for (const m of this.messages) {
      if (m.type === "start") {
        id = m.id;
        rev = 0;
      } else if ((m.type === "forces" || m.type === "clusters") && m.id === id) rev = m.rev;
    }
    const data: WorkerReply = {
      type: "positions",
      id,
      rev,
      xs: Float64Array.from(xs),
      ys: Float64Array.from(ys),
      settled,
    };
    act(() => this.onmessage?.({ data }));
  }
}

/** The page's layout worker, once it has started one. */
function workerOf(): FakeWorker {
  const worker = FakeWorker.last;
  if (!worker) throw new Error("no layout worker");
  return worker;
}

/** One wheel step about a stage point; a positive deltaY zooms out. */
function wheel(host: HTMLElement, deltaY: number, x = VIEW.width / 2, y = VIEW.height / 2) {
  stageOf(host)?.dispatchEvent(
    new WheelEvent("wheel", { deltaY, clientX: x, clientY: y, cancelable: true }),
  );
}

/** Three separate parts: five decisions tagged billing, five questions, and four questions
 * around a hub, so each naming rule names one of them. */
function threeRegions(): GraphData {
  const billing = ["a0", "a1", "a2", "a3", "a4"];
  const questions = ["b0", "b1", "b2", "b3", "b4"];
  const hubbed = ["c0", "c1", "c2", "c3"];
  return {
    nodes: [
      ...billing.map((k) => ({ ...node(k), tags: ["Billing"] })),
      ...questions.map((k) => node(k, "question")),
      ...hubbed.map((k) => node(k, "question")),
    ],
    edges: [
      ...clique(billing),
      ...clique(questions),
      link("c0", "c1"),
      link("c0", "c2"),
      link("c0", "c3"),
      link("c1", "c2"),
    ],
  };
}

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

  it("drags the camera on the renderer from empty canvas, and a drag is not a click", () => {
    const host = render("jobs-worker");
    const before = cameraOf();
    // The corner is inside the fit's margin, so no note is under the press.
    pointer(host, "pointerdown", 5, 5);
    pointer(host, "pointermove", 65, 35);
    pointer(host, "pointermove", 125, 65);
    expect(cameraOf().x).toBeCloseTo(before.x + 120);
    expect(stageOf(host)?.classList.contains("graph-live")).toBe(true);
    expect(stageOf(host)?.style.cursor).toBe("grabbing");
    pointer(host, "pointerup", 125, 65, 0);
    expect(stageOf(host)?.classList.contains("graph-live")).toBe(false);
    expect(stageOf(host)?.style.cursor).toBe("");
    // A drag is not a click: the selection stays.
    expect(host.querySelector("#graph-inspector-title")).not.toBeNull();
  });

  it("moves the dot grid with the renderer's camera", () => {
    const host = render(undefined);
    const gridBefore = stageOf(host)?.style.getPropertyValue("--dot-x");
    act(() => renderer?.setCamera({ ...cameraOf(), x: cameraOf().x + 40 }));
    expect(stageOf(host)?.style.getPropertyValue("--dot-x")).not.toBe(gridBefore);
  });

  it("lights only the hovered note's own links by default, with a grab cursor", async () => {
    const host = render(undefined, chain("a", "b", "c"));
    const s = dotAt("a");
    pointer(host, "pointermove", s.x, s.y, 0);
    await frames();
    expect(stageOf(host)?.style.cursor).toBe("grab");
    expect(lastEmphasis()?.hoverKey).toBe("a");
    // b is one link away; c is two, beyond the default depth, so it fades with the rest.
    expect(depthsOf(lastEmphasis())).toEqual({ a: 0, b: 1 });
    expect(lastEmphasis()?.lit ?? null).toBeNull();
    pointer(host, "pointermove", 1, 1, 0);
    await frames();
    expect(stageOf(host)?.style.cursor).toBe("");
    expect(lastEmphasis()?.depths ?? null).toBeNull();
  });

  it("lights notes as many links away as the highlight depth", async () => {
    const host = render(undefined, chain("a", "b", "c", "d"));
    typeInto(sliderNamed(openSettings(host), "Highlight depth"), "2");
    const s = dotAt("a");
    pointer(host, "pointermove", s.x, s.y, 0);
    await frames();
    expect(depthsOf(lastEmphasis())).toEqual({ a: 0, b: 1, c: 2 });
  });

  it("lights the selected note's links while nothing is hovered, and a hover wins", async () => {
    const host = render("a", chain("a", "b", "c"));
    expect(lastEmphasis()?.focusKey).toBe("a");
    expect(depthsOf(lastEmphasis())).toEqual({ a: 0, b: 1 });
    const s = dotAt("c");
    pointer(host, "pointermove", s.x, s.y, 0);
    await frames();
    expect(lastEmphasis()?.hoverKey).toBe("c");
    expect(depthsOf(lastEmphasis())).toEqual({ b: 1, c: 0 });
    // The selection keeps its ring while another note's links are lit.
    expect(lastEmphasis()?.focusKey).toBe("a");
    pointer(host, "pointermove", 1, 1, 0);
    await frames();
    expect(depthsOf(lastEmphasis())).toEqual({ a: 0, b: 1 });
  });

  it("lists the notes further out in the inspector when the depth reaches them", () => {
    const host = render("a", chain("a", "b", "c", "d"));
    const inspector = () => host.querySelector(".graph-float-inspector")?.textContent ?? "";
    expect(inspector()).toContain("1 direct link");
    expect(inspector()).not.toContain("links away");
    typeInto(sliderNamed(openSettings(host), "Highlight depth"), "3");
    expect(inspector()).toContain("1 note 2 links away");
    expect(inspector()).toContain("1 note 3 links away");
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

  it("plays Animate from the wand under the gear while the box is closed", () => {
    const nodes = [
      { ...node("a"), updatedAt: "2026-01-01T00:00:00Z" },
      { ...node("b"), updatedAt: "2026-02-01T00:00:00Z" },
    ];
    const edges = [{ source: "a", target: "b", relation: "related", suggested: false }];
    const host = render(undefined, { nodes, edges });
    const wand = () =>
      host.querySelector<HTMLButtonElement>('.graph-tools button[aria-label="Animate"]');
    // The open box has its own wand, so the one under the gear shows only once it closes.
    expect(wand()).toBeNull();
    act(() => settingsButton(host)?.click());
    expect(panelOf(host)).toBeNull();
    expect(wand()?.getAttribute("title")).toBe("Animate");
    act(() => wand()?.click());
    expect(scene.nodes.length).toBeLessThan(2);
  });

  it("shows the how-to hint the first time the graph is seen", () => {
    resetFirstVisitHint();
    const host = render(undefined);
    expect(host.querySelector("#graph-stage-hint")?.hasAttribute("data-gone")).toBe(false);
  });

  it("fades the how-to hint once the graph has been seen, keeping it for screen readers", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === HINT_KEY ? "1" : null),
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
    });
    const host = render(undefined);
    const hint = host.querySelector<HTMLElement>("#graph-stage-hint");
    expect(hint?.getAttribute("data-gone")).toBe("true");
    expect(hint?.textContent).toContain("Scroll to zoom");
    expect(
      host.querySelector(".graph-stage")?.getAttribute("aria-describedby")?.split(" "),
    ).toContain("graph-stage-hint");
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
    expect(host.querySelector(".graph-find")).toBeNull();
    // The only search field is the settings box's own filter, which opens with the page.
    expect(panelOf(host)).not.toBeNull();
    const searches = host.querySelectorAll('input[type="search"]');
    expect([...searches].every((input) => input.closest(".gs-panel") !== null)).toBe(true);
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

  it("opens with the settings box open, and Escape closes it with focus on the gear", () => {
    const host = render(undefined);
    const panel = panelOf(host);
    if (!panel) throw new Error("the box should open with the page");
    expect(settingsButton(host)?.getAttribute("aria-expanded")).toBe("true");
    expect(panel.textContent).toContain("Filters");
    expect(panel.textContent).toContain("Forces");
    const before = caption(host);
    key(panel.querySelector("input"), "Escape");
    expect(panelOf(host)).toBeNull();
    expect(settingsButton(host)?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(settingsButton(host));
    // Escape in the panel only closes it: the graph did not zoom out.
    expect(caption(host)).toBe(before);
  });

  it("toggles the box with the gear, named Graph settings in its tooltip", () => {
    const host = render(undefined);
    const gear = settingsButton(host);
    expect(gear?.getAttribute("title")).toBe("Graph settings");
    act(() => gear?.click());
    expect(panelOf(host)).toBeNull();
    expect(gear?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(gear);
    act(() => gear?.click());
    expect(panelOf(host)).not.toBeNull();
    expect(gear?.getAttribute("aria-expanded")).toBe("true");
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

  it("lights the notes a group matches while its row has focus, over the selection", () => {
    const nodes = [node("a"), node("b"), { ...node("q"), kind: "question" }];
    const host = render("q", { nodes, edges: [link("a", "q")] });
    expect(depthsOf(lastEmphasis())).toEqual({ a: 1, q: 0 });
    const panel = openSettings(host);
    const rows = panel.querySelectorAll<HTMLInputElement>(".gs-group .gs-input");
    // Decisions are the most common type, so the first group is type:decision. The group
    // shows through lit, so the selection's depths step aside while the row has focus.
    act(() => rows[0]?.focus());
    expect([...(lastEmphasis()?.lit ?? [])].sort()).toEqual(["a", "b"]);
    expect(lastEmphasis()?.depths ?? null).toBeNull();
    act(() => rows[0]?.blur());
    expect(lastEmphasis()?.lit ?? null).toBeNull();
    expect(depthsOf(lastEmphasis())).toEqual({ a: 1, q: 0 });
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
    // Region names never push the topic labels aside: they share the canvas's placement.
    act(() => switchNamed(host, "Region labels").click());
    expect(lastDisplay()?.topicLabels).toBe(true);
  });

  it("leaves Topic labels in control at the whole-area zoom while regions are named", () => {
    const host = render(undefined);
    // The demo's regions are named at the opening zoom, and the canvas names the topics too,
    // placed so they never sit on a region's name; the page draws no labels of its own.
    expect(lastRegions()?.names.some((name) => name !== "")).toBe(true);
    expect(lastDisplay()?.topicLabels).toBe(true);
    expect(host.querySelector(".graph-topic-label")).toBeNull();
    openSettings(host);
    act(() => switchNamed(host, "Topic labels").click());
    expect(lastDisplay()?.topicLabels).toBe(false);
    act(() => switchNamed(host, "Topic labels").click());
    expect(lastDisplay()?.topicLabels).toBe(true);
  });

  it("keeps the camera when the forces change after the viewer moved it", () => {
    const host = render(undefined);
    pointer(host, "pointerdown", 5, 5);
    pointer(host, "pointermove", 105, 55);
    pointer(host, "pointerup", 105, 55, 0);
    const moved = cameraOf();
    typeInto(sliderNamed(openSettings(host), "Repel force"), "18");
    expect(cameraOf()).toEqual(moved);
  });

  it("keeps the camera still when forces, filters or clusters change, so the notes are seen to move", () => {
    const animate = vi.spyOn(GraphRenderer.prototype, "animateTo");
    const host = render(undefined);
    const opened = cameraOf();
    const panel = openSettings(host);
    const before = positions?.xs.slice();
    typeInto(sliderNamed(panel, "Repel force"), "18");
    // The notes moved, and the camera did not follow them.
    expect(positions?.xs).not.toEqual(before);
    expect(cameraOf()).toEqual(opened);
    act(() => choice(panel, "Separate by", "None").click());
    act(() => switchNamed(host, "Orphans").click());
    expect(cameraOf()).toEqual(opened);
    expect(animate).not.toHaveBeenCalled();
  });

  it("fits the whole area again from the Fit button", () => {
    const animate = vi.spyOn(GraphRenderer.prototype, "animateTo");
    const host = render(undefined);
    const opened = cameraOf();
    pointer(host, "pointerdown", 5, 5);
    pointer(host, "pointermove", 205, 105);
    pointer(host, "pointerup", 205, 105, 0);
    expect(cameraOf()).not.toEqual(opened);
    act(() =>
      host.querySelector<HTMLButtonElement>('button[aria-label="Fit the whole area"]')?.click(),
    );
    const target = animate.mock.calls.at(-1)?.[0];
    expect(target?.x).toBeCloseTo(opened.x);
    expect(target?.y).toBeCloseTo(opened.y);
    expect(target?.s).toBeCloseTo(opened.s);
  });

  it("drags a note: it stays under the pointer, the camera stays and nothing is selected", () => {
    const host = render(undefined, chain("a", "b", "c"));
    const setDragging = vi.mocked(GraphRenderer.prototype.setDragging);
    const before = cameraOf();
    const s = dotAt("a");
    const b = dotAt("b");
    // Off the dot's centre, so the grab offset shows: the note must not jump to the pointer.
    pointer(host, "pointerdown", s.x + 2, s.y + 1);
    pointer(host, "pointermove", s.x + 32, s.y + 21);
    expect(setDragging).toHaveBeenLastCalledWith("a");
    expect(stageOf(host)?.style.cursor).toBe("grabbing");
    pointer(host, "pointermove", s.x + 62, s.y + 41);
    const moved = dotAt("a");
    expect(moved.x).toBeCloseTo(s.x + 60);
    expect(moved.y).toBeCloseTo(s.y + 40);
    // With no worker here, only the dragged note moves; the camera never does.
    expect(dotAt("b")).toEqual(b);
    expect(cameraOf()).toEqual(before);
    pointer(host, "pointerup", s.x + 62, s.y + 41, 0);
    expect(setDragging).toHaveBeenLastCalledWith(null);
    // A drag is not a click.
    expect(host.querySelector("#graph-inspector-title")).toBeNull();
    expect(stageOf(host)?.classList.contains("graph-live")).toBe(false);
  });

  it("lets a dragged note go when another pointer presses, so the graph can settle", () => {
    const host = render(undefined, chain("a", "b"));
    const setDragging = vi.mocked(GraphRenderer.prototype.setDragging);
    const press = (type: string, pointerId: number, x: number, y: number) =>
      act(() => {
        stageOf(host)?.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            button: 0,
            buttons: 1,
            pointerId,
            clientX: x,
            clientY: y,
          }),
        );
      });
    const s = dotAt("a");
    press("pointerdown", 1, s.x, s.y);
    press("pointermove", 1, s.x + 40, s.y);
    expect(setDragging).toHaveBeenLastCalledWith("a");
    // A second finger, while the first still holds the note.
    press("pointerdown", 2, 5, 5);
    expect(setDragging).toHaveBeenLastCalledWith(null);
    // The first finger's later moves no longer drag it.
    const at = dotAt("a");
    press("pointermove", 1, s.x + 90, s.y);
    expect(dotAt("a")).toEqual(at);
  });

  it("selects a note pressed without moving past the slop", () => {
    const host = render(undefined, chain("a", "b"));
    const s = dotAt("a");
    pointer(host, "pointerdown", s.x, s.y);
    pointer(host, "pointermove", s.x + 2, s.y + 1);
    pointer(host, "pointerup", s.x + 2, s.y + 1, 0);
    expect(vi.mocked(GraphRenderer.prototype.setDragging)).not.toHaveBeenCalled();
    expect(caption(host)).toContain("Selected a");
  });

  it("still drags a note under reduced motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("reduce"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const host = render(undefined, chain("a", "b"));
    const s = dotAt("a");
    pointer(host, "pointerdown", s.x, s.y);
    pointer(host, "pointermove", s.x + 50, s.y);
    expect(dotAt("a").x).toBeCloseTo(s.x + 50);
    pointer(host, "pointerup", s.x + 50, s.y, 0);
  });

  it("hands the layout the clustering Separate by asks for", () => {
    const nodes = [node("a"), node("b"), node("q", "question"), node("t", "topic")];
    const host = render(undefined, { nodes, edges: [] });
    const clustering = () => vi.mocked(useLiveLayout).mock.calls.at(-1)?.[3];
    // Brain regions by default, which the layout finds itself.
    expect(clustering()).toEqual({ mode: "regions", groups: null });
    const panel = openSettings(host);
    act(() => choice(panel, "Separate by", "Colour groups").click());
    // Each note's first matching colour group, in the data's order: one group per type, the
    // most common type first.
    expect(clustering()?.mode).toBe("groups");
    expect([...(clustering()?.groups ?? [])]).toEqual([0, 0, 1, 2]);
    act(() => choice(panel, "Separate by", "None").click());
    expect(clustering()).toEqual({ mode: "none", groups: null });
  });

  it("colours each note by its brain region when asked, and notes in none grey", () => {
    const groupA = ["a0", "a1", "a2", "a3"];
    const groupB = ["b0", "b1", "b2", "b3"];
    const data = {
      nodes: [...groupA, ...groupB, "lonely"].map((k) => node(k)),
      edges: [...clique(groupA), ...clique(groupB)],
    };
    const host = render(undefined, data);
    const colour = (k: string) => scene.nodes.find((n) => n.key === k)?.color;
    // By group (type) first: every decision shares one colour.
    expect(new Set([...groupA, ...groupB].map(colour)).size).toBe(1);
    const panel = openSettings(host);
    act(() => choice(panel, "Colour by", "Brain regions").click());
    expect(new Set(groupA.map(colour)).size).toBe(1);
    expect(new Set(groupB.map(colour)).size).toBe(1);
    expect(colour("a0")).not.toBe(colour("b0"));
    expect([paletteColour(0), paletteColour(1)]).toContain(colour("a0"));
    expect([paletteColour(0), paletteColour(1)]).toContain(colour("b0"));
    // A note with no links belongs to no region.
    expect(colour("lonely")).toBe("#8a8b93");
  });

  it("names each region by tag, else type, else best-linked note, with its size", () => {
    const host = render(undefined, threeRegions());
    expect(regionName("a0")).toBe("billing · 5");
    expect(regionName("b0")).toBe("Questions · 5");
    // Its type is taken by a larger region, so its hub names it.
    expect(regionName("c0")).toBe("Title c0 · 4");
    // Every note of a region carries its name.
    expect(regionName("c3")).toBe("Title c0 · 4");
    openSettings(host);
    act(() => switchNamed(host, "Region labels").click());
    expect(lastRegions()).toBeNull();
  });

  it("frames a region when its name is clicked, keeping the selection", () => {
    const animate = vi.spyOn(GraphRenderer.prototype, "animateTo");
    const host = render("b0", threeRegions());
    const opened = cameraOf();
    const region = lastRegions()?.assign[scene.nodes.findIndex((n) => n.key === "a0")];
    if (region === undefined || region < 0) throw new Error("no region for a0");
    // jsdom draws nothing, so the name under the pointer is given.
    vi.spyOn(GraphRenderer.prototype, "pickRegion").mockImplementation((x, y) =>
      x === 10 && y === 10 ? region : null,
    );
    pointer(host, "pointerdown", 10, 10);
    pointer(host, "pointerup", 10, 10, 0);
    const target = animate.mock.calls.at(-1)?.[0];
    if (!target) throw new Error("the camera did not move");
    expect(target.s).toBeGreaterThan(opened.s);
    for (const k of ["a0", "a1", "a2", "a3", "a4"]) {
      const i = scene.nodes.findIndex((n) => n.key === k);
      const p = toScreen(target, { x: positions?.xs[i] ?? 0, y: positions?.ys[i] ?? 0 });
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(VIEW.width);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(VIEW.height);
    }
    // A click on a name is not a click on empty canvas.
    expect(caption(host)).toContain("Selected b0");
  });

  it("lets a note under a region's name be hovered and selected; the rest of the name frames it", async () => {
    const animate = vi.spyOn(GraphRenderer.prototype, "animateTo");
    const host = render(undefined, threeRegions());
    const region = lastRegions()?.assign[scene.nodes.findIndex((n) => n.key === "c0")];
    if (region === undefined || region < 0) throw new Error("no region for c0");
    // jsdom draws nothing, so the region's name is given as covering the whole stage, its hub
    // at the centroid included.
    vi.spyOn(GraphRenderer.prototype, "pickRegion").mockReturnValue(region);
    const hub = dotAt("c0");
    pointer(host, "pointermove", hub.x, hub.y, 0);
    await frames();
    expect(lastEmphasis()?.hoverKey).toBe("c0");
    expect(stageOf(host)?.style.cursor).toBe("grab");
    pointer(host, "pointerdown", hub.x, hub.y);
    pointer(host, "pointerup", hub.x, hub.y, 0);
    expect(caption(host)).toContain("Selected c0");
    expect(animate).not.toHaveBeenCalled();
    // Away from every dot, the name takes the hover and the click.
    pointer(host, "pointermove", 1, 1, 0);
    await frames();
    expect(lastEmphasis()?.hoverKey ?? null).toBeNull();
    expect(stageOf(host)?.style.cursor).toBe("pointer");
    pointer(host, "pointerdown", 1, 1);
    pointer(host, "pointerup", 1, 1, 0);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(caption(host)).toContain("Selected c0");
  });

  it("names the colour groups while the graph is separated by them, not the regions", () => {
    const host = render(undefined, threeRegions());
    expect(regionName("a0")).toBe("billing · 5");
    const panel = openSettings(host);
    act(() => choice(panel, "Separate by", "Colour groups").click());
    // One group per type, the most common first: the clusters on screen are named for them.
    expect(regionName("b0")).toBe("Questions · 9");
    expect(regionName("c3")).toBe("Questions · 9");
    expect(regionName("a0")).toBe("Decisions · 5");
    expect(panel.textContent).toContain("Names each colour group while the graph is separated");
    act(() => choice(panel, "Separate by", "None").click());
    expect(regionName("a0")).toBe("billing · 5");
  });

  it("lists the named regions in the settings box, where each one frames its region", () => {
    const animate = vi.spyOn(GraphRenderer.prototype, "animateTo");
    const host = render(undefined, threeRegions());
    const panel = openSettings(host);
    const parts = [...panel.querySelectorAll<HTMLButtonElement>(".gs-part")];
    expect(parts.map((b) => b.textContent)).toEqual([
      "billing · 5",
      "Questions · 5",
      "Title c0 · 4",
    ]);
    expect(parts[0]?.getAttribute("aria-label")).toBe("Zoom to billing · 5");
    // Coloured by group, a region's notes share no one colour, so there is no swatch.
    expect(panel.querySelector(".gs-part-swatch")).toBeNull();
    // The canvas is hidden from screen readers: the caption and the hint point to the names.
    expect(caption(host)).toContain("3 named brain regions, listed in graph settings");
    expect(host.querySelector(".graph-hint")?.textContent).toContain(
      "Click a region's name to zoom to it.",
    );
    act(() => parts[0]?.click());
    const target = animate.mock.calls.at(-1)?.[0];
    if (!target) throw new Error("the camera did not move");
    for (const k of ["a0", "a1", "a2", "a3", "a4"]) {
      const i = scene.nodes.findIndex((n) => n.key === k);
      const p = toScreen(target, { x: positions?.xs[i] ?? 0, y: positions?.ys[i] ?? 0 });
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(VIEW.width);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(VIEW.height);
    }
    // Coloured by region, each listed region shows the colour its notes are drawn in: the
    // first is billing's, a0's. The style is read back the way jsdom writes it.
    act(() => choice(panel, "Colour by", "Brain regions").click());
    const swatch = panel.querySelector<HTMLElement>(".gs-part-swatch");
    const a0 = scene.nodes.find((n) => n.key === "a0")?.color ?? "";
    expect(a0).toBe(paletteColour(0));
    const expected = document.createElement("i");
    expected.style.background = a0;
    expect(swatch?.style.background).toBe(expected.style.background);
  });

  it("colours only named regions, no more than the palette keeps apart, and the rest grey", () => {
    // Fourteen separate triangles, all named, and a linked pair too small to be named.
    const triangles = Array.from({ length: 14 }, (_, r) => [`r${r}a`, `r${r}b`, `r${r}c`]);
    const data = {
      nodes: [...triangles.flat(), "p1", "p2"].map((k) => node(k)),
      edges: [...triangles.flatMap((t) => clique(t)), link("p1", "p2")],
    };
    const host = render(undefined, data);
    const panel = openSettings(host);
    act(() => choice(panel, "Colour by", "Brain regions").click());
    const colour = (k: string) => scene.nodes.find((n) => n.key === k)?.color;
    for (const t of triangles) expect(new Set(t.map(colour)).size).toBe(1);
    const coloured = triangles.map((t) => colour(t[0] as string)).filter((c) => c !== "#8a8b93");
    // Twelve regions, twelve colours, each standing for one region; the other two are grey.
    expect(coloured).toHaveLength(12);
    expect(new Set(coloured).size).toBe(12);
    expect(colour("p1")).toBe("#8a8b93");
  });

  it("zooms out with minus after the viewer took the camera while the area opened", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const animate = vi.spyOn(GraphRenderer.prototype, "animateTo");
    const keys = ["a", "b", "c", "d", "e", "f"];
    const host = render(undefined, chain(...keys));
    // The first positions are a tight spiral, then the notes spread far past it.
    const tight = keys.map((_, i) => i);
    workerOf().post(tight, tight, false);
    const wide = keys.map((_, i) => i * 400);
    workerOf().post(wide, wide, false);
    // A single wheel step before the layout settles: the camera is the viewer's from here.
    act(() => wheel(host, 1));
    workerOf().post(wide, wide, true);
    const before = cameraOf().s;
    key(stageOf(host), "-");
    const target = animate.mock.calls.at(-1)?.[0];
    expect(target?.s).toBeCloseTo(before * 0.8);
  });

  it("zooms out far enough to see the whole graph after the forces spread it", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const keys = ["a", "b", "c", "d", "e", "f"];
    const host = render(undefined, chain(...keys));
    const xs = keys.map((_, i) => (i - 2.5) * 200);
    const ys = keys.map((_, i) => (i % 2 === 0 ? -300 : 300));
    workerOf().post(xs, ys, true);
    const opened = cameraOf();
    // A stronger repel spreads the notes to four times the size; the camera stays put.
    typeInto(sliderNamed(openSettings(host), "Repel force"), "18");
    workerOf().post(
      xs.map((x) => x * 4),
      ys.map((y) => y * 4),
      true,
    );
    expect(cameraOf()).toEqual(opened);
    act(() => {
      for (let i = 0; i < 20; i += 1) wheel(host, 200);
    });
    for (const k of keys) {
      const p = dotAt(k);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(VIEW.width);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(VIEW.height);
    }
  });

  it("stops dragging once no button is down, though the stage never heard the release", () => {
    const host = render(undefined, chain("a", "b", "c"));
    const setDragging = vi.mocked(GraphRenderer.prototype.setDragging);
    const s = dotAt("a");
    pointer(host, "pointerdown", s.x, s.y);
    pointer(host, "pointermove", s.x + 32, s.y);
    expect(setDragging).toHaveBeenLastCalledWith("a");
    // A plain move: the button came up over a context menu or another window.
    pointer(host, "pointermove", s.x + 200, s.y + 150, 0);
    expect(setDragging).toHaveBeenLastCalledWith(null);
    expect(stageOf(host)?.classList.contains("graph-live")).toBe(false);
    expect(dotAt("a").x).toBeCloseTo(s.x + 32);
    pointer(host, "pointermove", s.x + 250, s.y, 0);
    expect(dotAt("a").x).toBeCloseTo(s.x + 32);
  });

  it("lets a dragged note go when the stage loses the pointer", () => {
    const host = render(undefined, chain("a", "b"));
    const setDragging = vi.mocked(GraphRenderer.prototype.setDragging);
    const s = dotAt("a");
    pointer(host, "pointerdown", s.x, s.y);
    pointer(host, "pointermove", s.x + 40, s.y);
    expect(setDragging).toHaveBeenLastCalledWith("a");
    pointer(host, "lostpointercapture", s.x + 40, s.y, 0);
    expect(setDragging).toHaveBeenLastCalledWith(null);
    expect(stageOf(host)?.classList.contains("graph-live")).toBe(false);
  });
});

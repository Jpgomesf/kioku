import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphRenderer } from "./renderer";
import {
  cameraEase,
  cubicBezier,
  DIM_ALPHA,
  dimmedEdgeAlpha,
  edgeAlpha,
  LEGACY_ALPHA,
  labelAlpha,
  labelOpacity,
  labelThreshold,
  SpatialGrid,
  TAG_SCALE,
} from "./renderer-math";
import type { Scene, SceneNode } from "./scene";

function node(key: string, x: number, y: number, extra: Partial<SceneNode> = {}): SceneNode {
  return {
    key,
    x,
    y,
    size: 1,
    color: "#2a78d6",
    topic: false,
    tag: false,
    legacy: false,
    label: key,
    ...extra,
  };
}

/** A fake 2D context that counts calls by name. */
function recordingContext() {
  const calls: Record<string, number> = {};
  const count = (name: string) => () => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  const ctx = {
    calls,
    arcs: [] as [number, number][],
    radii: [] as number[],
    texts: [] as string[],
    textAlphas: [] as number[],
    strokeAlphas: [] as number[],
    lineWidths: [] as number[],
    setTransform: count("setTransform"),
    clearRect: count("clearRect"),
    beginPath: count("beginPath"),
    moveTo: count("moveTo"),
    lineTo: count("lineTo"),
    arc(x: number, y: number, r: number) {
      ctx.arcs.push([x, y]);
      ctx.radii.push(r);
    },
    fill: count("fill"),
    stroke() {
      calls.stroke = (calls.stroke ?? 0) + 1;
      ctx.lineWidths.push(ctx.lineWidth);
      ctx.strokeAlphas.push(ctx.globalAlpha);
    },
    fillText(text: string) {
      ctx.texts.push(text);
      ctx.textAlphas.push(ctx.globalAlpha);
    },
    strokeText: count("strokeText"),
    font: "",
    textAlign: "",
    textBaseline: "",
    lineJoin: "",
    setLineDash: count("setLineDash"),
    globalAlpha: 1,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
  };
  return ctx;
}

function canvasWith(ctx: unknown): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.getContext = (() => ctx) as unknown as HTMLCanvasElement["getContext"];
  return canvas;
}

let frames: FrameRequestCallback[] = [];
function flushFrames() {
  const pending = frames;
  frames = [];
  for (const f of pending) f(performance.now());
}

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    frames = [];
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const noMotion = { reducedMotion: () => true };
const motion = { reducedMotion: () => false };

describe("cubicBezier", () => {
  it("hits the endpoints and never goes back", () => {
    expect(cameraEase(0)).toBe(0);
    expect(cameraEase(1)).toBe(1);
    let prev = 0;
    for (let i = 1; i <= 100; i += 1) {
      const v = cameraEase(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
  });
  it("is the identity for a linear curve", () => {
    const linear = cubicBezier(1 / 3, 1 / 3, 2 / 3, 2 / 3);
    expect(linear(0.37)).toBeCloseTo(0.37, 4);
  });
});

describe("SpatialGrid", () => {
  it("finds the nearest note", () => {
    const nodes = Array.from({ length: 100 }, (_, i) =>
      node(`n${i}`, (i % 10) * 10, Math.floor(i / 10) * 10),
    );
    const grid = new SpatialGrid(nodes);
    expect(grid.nearest(31, 42, () => true)).toBe(43);
    expect(new SpatialGrid([]).nearest(0, 0, () => true)).toBe(-1);
  });
});

describe("GraphRenderer", () => {
  const scene: Scene = {
    nodes: [node("a", 0, 0), node("b", 100, 0), node("c", 5000, 5000)],
    edges: [{ a: 0, b: 1, suggested: false }],
  };

  it("works without a 2D context", () => {
    const r = new GraphRenderer(canvasWith(null), noMotion);
    r.resize(200, 100);
    r.setScene(scene);
    r.setCamera({ x: 10, y: 10, s: 1 });
    flushFrames();
    expect(r.pick(10, 10)).toBe("a");
    expect(r.nearest(105, 12)).toBe("b");
  });

  it("picks within radius plus slop, and nothing on an empty scene", () => {
    const r = new GraphRenderer(canvasWith(null), noMotion);
    r.resize(200, 100);
    expect(r.pick(0, 0)).toBeNull();
    expect(r.nearest(0, 0)).toBeNull();
    r.setScene(scene);
    r.setCamera({ x: 10, y: 10, s: 1 });
    expect(r.pick(10 + 30, 10)).toBeNull();
    expect(r.pick(10 + 1, 10, 0)).toBe("a");
    // Dots are at most 12 px across the radius, so 14 px away needs the slop.
    expect(r.pick(10 + 14, 10, 0)).toBeNull();
    expect(r.pick(10 + 14, 10, 14)).toBe("a");
  });

  it("scales the backing store by devicePixelRatio and keeps the camera", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const canvas = canvasWith(null);
    const r = new GraphRenderer(canvas, noMotion);
    r.setCamera({ x: 3, y: 4, s: 2 });
    r.resize(300, 150);
    expect(canvas.width).toBe(600);
    expect(canvas.height).toBe(300);
    expect(r.camera).toEqual({ x: 3, y: 4, s: 2 });
  });

  it("leaves the backing store alone on a same-size resize", () => {
    const canvas = canvasWith(null);
    const r = new GraphRenderer(canvas, noMotion);
    r.resize(300, 150);
    let writes = 0;
    const width = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "width");
    Object.defineProperty(canvas, "width", {
      get: () => width?.get?.call(canvas),
      set: (v: number) => {
        writes += 1;
        width?.set?.call(canvas, v);
      },
    });
    r.resize(300, 150);
    expect(writes).toBe(0);
    r.resize(301, 150);
    expect(writes).toBe(1);
  });

  it("reports a running animation until it is cancelled", () => {
    const r = new GraphRenderer(canvasWith(null), motion);
    expect(r.animating).toBe(false);
    void r.animateTo({ x: 100, y: 0, s: 1 }, 300);
    expect(r.animating).toBe(true);
    r.setCamera({ x: 0, y: 0, s: 1 });
    expect(r.animating).toBe(false);
  });

  it("moves at once under reduced motion and notifies once", async () => {
    const r = new GraphRenderer(canvasWith(null), noMotion);
    const seen = vi.fn();
    r.subscribe(seen);
    await r.animateTo({ x: 5, y: 6, s: 3 }, 300);
    expect(r.camera).toEqual({ x: 5, y: 6, s: 3 });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("resolves a cancelled animation and lets the newer move win", async () => {
    const r = new GraphRenderer(canvasWith(null), motion);
    const first = r.animateTo({ x: 100, y: 0, s: 1 }, 300);
    r.setCamera({ x: 7, y: 7, s: 1 });
    await expect(first).resolves.toBeUndefined();
    flushFrames();
    expect(r.camera).toEqual({ x: 7, y: 7, s: 1 });
  });

  it("finishes an animation on the target", async () => {
    let t = 0;
    vi.spyOn(performance, "now").mockImplementation(() => t);
    const r = new GraphRenderer(canvasWith(null), motion);
    const done = r.animateTo({ x: 100, y: 50, s: 2 }, 100);
    t = 50;
    flushFrames();
    expect(r.camera.x).toBeGreaterThan(0);
    t = 100;
    flushFrames();
    await done;
    expect(r.camera).toEqual({ x: 100, y: 50, s: 2 });
    expect(frames).toHaveLength(0);
  });

  it("schedules one frame per batch of changes and stops on destroy", () => {
    const r = new GraphRenderer(canvasWith(null), noMotion);
    r.setScene(scene);
    r.setEmphasis({ focusKey: "a", hoverKey: null, lit: null });
    expect(frames).toHaveLength(1);
    r.destroy();
    expect(frames).toHaveLength(0);
  });

  it("batches nodes of one colour and skips culled ones", () => {
    const draw = (count: number) => {
      const ctx = recordingContext();
      const r = new GraphRenderer(canvasWith(ctx), noMotion);
      r.resize(400, 400);
      const nodes = Array.from({ length: count }, (_, i) => node(`n${i}`, i % 300, (i * 7) % 300));
      nodes.push(node("far", 99999, 99999));
      const edges = nodes.slice(1, -1).map((_, i) => ({ a: 0, b: i + 1, suggested: false }));
      r.setScene({ nodes, edges });
      r.setCamera({ x: 0, y: 0, s: 1 });
      flushFrames();
      return ctx;
    };
    const small = draw(10);
    const big = draw(500);
    expect(big.calls.fill).toBe(small.calls.fill);
    expect(big.calls.stroke).toBe(small.calls.stroke);
    expect(big.calls.beginPath).toBe(small.calls.beginPath);
    expect(big.arcs).toHaveLength(500);
    expect(big.arcs.some(([x]) => x > 1000)).toBe(false);
  });

  it("rings both the hovered and the focused note, whatever their order", () => {
    const ctx = recordingContext();
    const r = new GraphRenderer(canvasWith(ctx), noMotion);
    r.resize(400, 400);
    r.setScene({ nodes: [node("b", 10, 10), node("a", 50, 50)], edges: [] });
    r.setCamera({ x: 0, y: 0, s: 1 });
    r.setEmphasis({ focusKey: "a", hoverKey: "b", lit: null });
    flushFrames();
    // Two dots plus two rings.
    expect(ctx.arcs).toHaveLength(4);
  });

  it("redraws at once on resize and leaves the element size to CSS", () => {
    const ctx = recordingContext();
    const canvas = canvasWith(ctx);
    const r = new GraphRenderer(canvas, noMotion);
    r.setScene(scene);
    r.resize(300, 150);
    expect(ctx.calls.clearRect).toBe(1);
    expect(frames).toHaveLength(0);
    expect(canvas.style.width).toBe("");
  });

  it("sizes dots from the page's fit scale when given, not the scene's bounds", () => {
    const radiusAt = (nodes: SceneNode[]) => {
      const ctx = recordingContext();
      const radii: number[] = [];
      ctx.arc = ((x: number, y: number, rad: number) => {
        ctx.arcs.push([x, y]);
        radii.push(rad);
      }) as typeof ctx.arc;
      const r = new GraphRenderer(canvasWith(ctx), { ...noMotion, fitScale: () => 0.5 });
      r.resize(400, 400);
      r.setScene({ nodes, edges: [] });
      r.setCamera({ x: 0, y: 0, s: 2 });
      flushFrames();
      return radii[0];
    };
    const wide = radiusAt([node("a", 10, 10), node("z", 5000, 5000)]);
    const narrow = radiusAt([node("a", 10, 10), node("z", 20, 20)]);
    expect(wide).toBe(narrow);
  });

  function drawn(
    nodes: SceneNode[],
    camera = { x: 0, y: 0, s: 1 },
    display?: Partial<Parameters<GraphRenderer["setDisplay"]>[0]>,
    edges: Scene["edges"] = [],
  ) {
    const ctx = recordingContext();
    const r = new GraphRenderer(canvasWith(ctx), { ...noMotion, fitScale: () => 1 });
    r.resize(400, 400);
    r.setScene({ nodes, edges });
    if (display)
      r.setDisplay({ nodeSize: 1, linkThickness: 1, arrows: false, textFade: 0, ...display });
    r.setCamera(camera);
    flushFrames();
    return { ctx, r };
  }

  it("moves notes in place, draws once per frame and picks the moved note", () => {
    const { ctx, r } = drawn([node("a", 10, 10), node("b", 50, 50)]);
    const before = ctx.calls.clearRect;
    for (let k = 0; k < 5; k += 1) {
      r.setPositions(new Float64Array([300, 50]), new Float64Array([300, 50]));
    }
    expect(frames).toHaveLength(1);
    flushFrames();
    expect(ctx.calls.clearRect).toBe((before ?? 0) + 1);
    expect(ctx.arcs.slice(-2)).toEqual([
      [300, 300],
      [50, 50],
    ]);
    expect(r.pick(300, 300)).toBe("a");
    expect(r.pick(10, 10)).toBeNull();
    expect(r.nearest(290, 290)).toBe("a");
  });

  it("leaves the page's scene objects untouched when positions move", () => {
    const nodes = [node("a", 10, 10)];
    const { r } = drawn(nodes);
    r.setPositions(new Float64Array([99]), new Float64Array([99]));
    expect(nodes[0]?.x).toBe(10);
  });

  it("grows fills with the number of colours, not notes", () => {
    const fills = (count: number, colours: number) => {
      const nodes = Array.from({ length: count }, (_, i) =>
        node(`n${i}`, i % 300, (i * 7) % 300, { color: `#00000${i % colours}` }),
      );
      return drawn(nodes).ctx.calls.fill ?? 0;
    };
    expect(fills(500, 3)).toBe(fills(9, 3));
    expect(fills(500, 3)).toBe(3);
    expect(fills(500, 6)).toBe(6);
  });

  it("draws topics as rings in their own colour", () => {
    const { ctx } = drawn([node("t", 10, 10, { topic: true, color: "#123456" })]);
    expect(ctx.calls.fill).toBeUndefined();
    expect(ctx.calls.stroke).toBe(1);
    expect(ctx.strokeStyle).toBe("#123456");
  });

  it("hides labels below the zoom threshold and draws them above it", () => {
    const nodes = [node("a", 10, 10), node("b", 50, 50), node("t", 80, 80, { topic: true })];
    expect(drawn(nodes, { x: 0, y: 0, s: 1 }).ctx.texts).toEqual([]);
    expect(drawn(nodes, { x: 0, y: 0, s: 4 }).ctx.texts.sort()).toEqual(["a", "b"]);
    // A higher text fade shows them sooner; a lower one later.
    expect(drawn(nodes, { x: 0, y: 0, s: 1 }, { textFade: 3 }).ctx.texts).toHaveLength(2);
    expect(drawn(nodes, { x: 0, y: 0, s: 4 }, { textFade: -3 }).ctx.texts).toEqual([]);
  });

  it("fades labels in over a short zoom range", () => {
    const t = labelThreshold(0);
    expect(labelAlpha(t, 0)).toBe(0);
    expect(labelAlpha(t * 1.25, 0)).toBeCloseTo(0.5);
    expect(labelAlpha(t * 2, 0)).toBe(1);
    expect(labelThreshold(3)).toBeLessThan(labelThreshold(0));
    expect(labelThreshold(-3)).toBeGreaterThan(labelThreshold(0));
  });

  it("caps labels per frame, biggest notes first", () => {
    const nodes = Array.from({ length: 500 }, (_, i) =>
      node(`n${i}`, (i % 25) * 4, Math.floor(i / 25) * 4, { size: i === 499 ? 50 : 1 }),
    );
    const { ctx } = drawn(nodes, { x: 0, y: 0, s: 4 });
    expect(ctx.texts).toHaveLength(300);
    expect(ctx.texts[0]).toBe("n499");
  });

  it("draws arrowheads only on links long enough on screen", () => {
    const nodes = [node("a", 0, 0), node("b", 200, 0), node("c", 0, 10)];
    const edges = [
      { a: 0, b: 1, suggested: false },
      { a: 0, b: 2, suggested: false },
    ];
    const off = drawn(nodes, { x: 50, y: 50, s: 1 }, { arrows: false }, edges).ctx;
    const on = drawn(nodes, { x: 50, y: 50, s: 1 }, { arrows: true }, edges).ctx;
    // One extra fill for the one long link's head: a tip plus three lineTo calls.
    expect((on.calls.fill ?? 0) - (off.calls.fill ?? 0)).toBe(1);
    expect((on.calls.lineTo ?? 0) - (off.calls.lineTo ?? 0)).toBe(3);
  });

  it("scales dots and links by the display multipliers", () => {
    const nodes = [node("a", 10, 10), node("b", 100, 100)];
    const edges = [{ a: 0, b: 1, suggested: false }];
    const plain = drawn(nodes, undefined, {}, edges);
    const big = drawn(nodes, undefined, { nodeSize: 2, linkThickness: 3 }, edges);
    expect(big.ctx.radii[0]).toBeCloseTo((plain.ctx.radii[0] as number) * 2);
    expect(big.ctx.lineWidths[0]).toBe(3);
    // Picking follows the bigger dots.
    const r0 = plain.ctx.radii[0] as number;
    expect(plain.r.pick(10 + r0 * 1.5, 10, 0)).toBeNull();
    expect(big.r.pick(10 + r0 * 1.5, 10, 0)).toBe("a");
  });

  it("picks near the rim of a big topic ring at the largest node size", () => {
    const nodes = [node("t", 0, 0, { size: 1e6, topic: true }), node("far", 1e5, 0)];
    const { ctx, r } = drawn(nodes, { x: 0, y: 0, s: 1000 }, { nodeSize: 5 });
    const radius = Math.max(...ctx.radii);
    expect(radius).toBeGreaterThan(62);
    expect(r.pick(radius - 0.5, 0, 0)).toBe("t");
  });

  it("draws long titles shortened with an ellipsis", () => {
    const long = "A very long note title that goes on and on well past the limit";
    const nodes = [node("a", 0, 0, { label: long }), node("b", 50, 0)];
    const texts = drawn(nodes, { x: 0, y: 0, s: 4 }).ctx.texts;
    const shown = texts.find((t) => t.startsWith("A very"));
    expect(shown?.endsWith("\u2026")).toBe(true);
    expect(shown?.length).toBeLessThanOrEqual(28);
  });

  function emphasised(
    nodes: SceneNode[],
    emphasis: Parameters<GraphRenderer["setEmphasis"]>[0],
    camera = { x: 0, y: 0, s: 1 },
    edges: Scene["edges"] = [],
  ) {
    const ctx = recordingContext();
    const r = new GraphRenderer(canvasWith(ctx), { ...noMotion, fitScale: () => 1 });
    r.resize(400, 400);
    r.setScene({ nodes, edges });
    r.setCamera(camera);
    r.setEmphasis(emphasis);
    flushFrames();
    return ctx;
  }

  it("always labels the hovered and focused notes at full strength, even zoomed out", () => {
    const nodes = [node("a", 10, 10), node("b", 50, 50), node("c", 90, 90)];
    const ctx = emphasised(nodes, { focusKey: "a", hoverKey: "b", lit: null });
    expect(ctx.texts.sort()).toEqual(["a", "b"]);
    expect(ctx.textAlphas).toEqual([1, 1]);
  });

  it("labels lit notes while hovering and fades the rest with their dots", () => {
    const nodes = [node("a", 10, 10), node("b", 50, 50), node("c", 90, 90)];
    const lit = new Set(["a", "b"]);
    const out = emphasised(nodes, { focusKey: null, hoverKey: "a", lit });
    expect(out.texts.sort()).toEqual(["a", "b"]);
    // Zoomed in, the unlit label still shows but dimmed.
    const zoomed = emphasised(nodes, { focusKey: null, hoverKey: "a", lit }, { x: 0, y: 0, s: 4 });
    const alphaOf = (t: string) => zoomed.textAlphas[zoomed.texts.indexOf(t)];
    expect(alphaOf("b")).toBe(1);
    expect(alphaOf("c")).toBeCloseTo(DIM_ALPHA);
  });

  it("names a hovered topic on the canvas only when the page's topic labels are off", () => {
    const nodes = [node("t", 10, 10, { topic: true, label: "A topic" })];
    const hovered = (topicLabels: boolean) => {
      const { ctx, r } = drawn(nodes, undefined, { topicLabels });
      r.setEmphasis({ focusKey: null, hoverKey: "t", lit: null });
      flushFrames();
      return ctx.texts;
    };
    expect(hovered(true)).toEqual([]);
    expect(hovered(false)).toContain("A topic");
  });

  it("keeps dimmed links visible on large areas", () => {
    expect(dimmedEdgeAlpha(edgeAlpha(5000))).toBeGreaterThanOrEqual(0.04);
    expect(dimmedEdgeAlpha(0.2)).toBeCloseTo(0.08);
  });

  it("computes label opacity from zoom, emphasis and legacy", () => {
    expect(labelOpacity(0, true, false, true)).toBe(1);
    expect(labelOpacity(0, false, true, false)).toBe(1);
    expect(labelOpacity(1, false, false, false)).toBe(DIM_ALPHA);
    expect(labelOpacity(0.5, false, null, true)).toBeCloseTo(0.5 * LEGACY_ALPHA);
    expect(labelOpacity(0, false, null, false)).toBe(0);
  });

  it("keeps hover and focus labels inside the cap", () => {
    const nodes = Array.from({ length: 400 }, (_, i) =>
      node(`n${i}`, (i % 20) * 5, Math.floor(i / 20) * 5, { size: i === 0 ? 1 : 10 }),
    );
    const ctx = emphasised(
      nodes,
      { focusKey: null, hoverKey: "n0", lit: null },
      { x: 0, y: 0, s: 4 },
    );
    expect(ctx.texts).toHaveLength(300);
    expect(ctx.texts[0]).toBe("n0");
  });

  it("draws the hovered note's links in the accent and dims unlit links", () => {
    const nodes = [node("a", 10, 10), node("b", 100, 10), node("c", 10, 200), node("d", 200, 200)];
    const edges = [
      { a: 0, b: 1, suggested: false },
      { a: 2, b: 3, suggested: false },
    ];
    const ctx = emphasised(
      nodes,
      { focusKey: null, hoverKey: "a", lit: new Set(["a", "b"]) },
      undefined,
      edges,
    );
    // The first stroke is the dimmed batch: fainter than rest, but still visible.
    const rest = edgeAlpha(2);
    expect(ctx.strokeAlphas[0]).toBeCloseTo(dimmedEdgeAlpha(rest));
    expect(ctx.strokeAlphas[0]).toBeGreaterThan(0);
    expect(ctx.strokeAlphas[0]).toBeLessThan(rest);
    expect(ctx.strokeAlphas).toContain(0.75);
  });

  it("draws tag nodes as smaller dots labelled #name", () => {
    const nodes = [
      node("n", 10, 10, { size: 4 }),
      node("t", 100, 100, { size: 4, tag: true, label: "ideas" }),
    ];
    const { ctx } = drawn(nodes, { x: 0, y: 0, s: 4 });
    expect(ctx.radii[1]).toBeCloseTo((ctx.radii[0] as number) * TAG_SCALE);
    expect(ctx.texts).toContain("#ideas");
    expect(
      drawn([node("t", 0, 0, { tag: true, label: "#x" })], { x: 0, y: 0, s: 4 }).ctx.texts,
    ).toEqual(["#x"]);
  });
});

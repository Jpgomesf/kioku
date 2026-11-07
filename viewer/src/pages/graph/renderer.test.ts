import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphRenderer } from "./renderer";
import { cameraEase, cubicBezier, SpatialGrid } from "./renderer-math";
import type { Scene, SceneNode } from "./scene";

function node(key: string, x: number, y: number, extra: Partial<SceneNode> = {}): SceneNode {
  return { key, x, y, size: 1, tone: "slot1", legacy: false, ...extra };
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
    setTransform: count("setTransform"),
    clearRect: count("clearRect"),
    beginPath: count("beginPath"),
    moveTo: count("moveTo"),
    lineTo: count("lineTo"),
    arc(x: number, y: number) {
      ctx.arcs.push([x, y]);
    },
    fill: count("fill"),
    stroke: count("stroke"),
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

  it("batches nodes of one tone and skips culled ones", () => {
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
});

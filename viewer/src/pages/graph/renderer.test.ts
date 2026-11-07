import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphRenderer } from "./renderer";
import {
  CALM,
  cameraEase,
  cubicBezier,
  DEPTH_ALPHAS,
  DIM_ALPHA,
  dimmedEdgeAlpha,
  FADED,
  fadedLinkAlpha,
  LabelBoxes,
  LEGACY_ALPHA,
  labelAlpha,
  labelOpacity,
  labelSortIndex,
  labelSortKey,
  labelThreshold,
  linkAlphas,
  linkDensity,
  NEAR_MAX,
  NEAR_MIN,
  RANK_NEAR,
  RANK_REST,
  RANK_SOURCE,
  REGION_FADE_FROM,
  REGION_FADE_TO,
  REST_LINK_MAX,
  REST_LINK_MIN,
  regionLabelAlpha,
  restLinkAlpha,
  SpatialGrid,
  screenRadius,
  TAG_SCALE,
} from "./renderer-math";
import type { DisplayOptions, Emphasis, Scene, SceneNode, SceneRegions } from "./scene";

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

/** The renderer's colours in jsdom, where no stylesheet sets the custom properties. */
const EDGE = "#6f7078";
const ACCENT = "#2944b8";

type Op = ["m" | "l", number, number] | ["a", number, number, number];

/** One fill or stroke: its paint state and the path it traced. */
interface Paint {
  style: string;
  alpha: number;
  width: number;
  dashed: boolean;
  ops: Op[];
}

/** A fake 2D context that counts calls by name and records each fill, stroke and text. */
function recordingContext() {
  const calls: Record<string, number> = {};
  const count = (name: string) => () => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  let ops: Op[] = [];
  let dashed = false;
  const ctx = {
    calls,
    arcs: [] as [number, number][],
    radii: [] as number[],
    texts: [] as string[],
    textAlphas: [] as number[],
    textAt: [] as { text: string; x: number; y: number; alpha: number; font: string }[],
    strokeAlphas: [] as number[],
    lineWidths: [] as number[],
    strokes: [] as Paint[],
    fills: [] as Paint[],
    /** Where each frame's records start: every draw begins with clearRect. */
    frames: [] as { texts: number; strokes: number; fills: number }[],
    setTransform: count("setTransform"),
    clearRect() {
      calls.clearRect = (calls.clearRect ?? 0) + 1;
      ctx.frames.push({
        texts: ctx.textAt.length,
        strokes: ctx.strokes.length,
        fills: ctx.fills.length,
      });
    },
    beginPath() {
      calls.beginPath = (calls.beginPath ?? 0) + 1;
      ops = [];
    },
    moveTo(x: number, y: number) {
      calls.moveTo = (calls.moveTo ?? 0) + 1;
      ops.push(["m", x, y]);
    },
    lineTo(x: number, y: number) {
      calls.lineTo = (calls.lineTo ?? 0) + 1;
      ops.push(["l", x, y]);
    },
    arc(x: number, y: number, r: number) {
      ctx.arcs.push([x, y]);
      ctx.radii.push(r);
      ops.push(["a", x, y, r]);
    },
    fill() {
      calls.fill = (calls.fill ?? 0) + 1;
      ctx.fills.push(paint(ctx.fillStyle));
    },
    stroke() {
      calls.stroke = (calls.stroke ?? 0) + 1;
      ctx.lineWidths.push(ctx.lineWidth);
      ctx.strokeAlphas.push(ctx.globalAlpha);
      ctx.strokes.push(paint(ctx.strokeStyle));
    },
    fillText(text: string, x: number, y: number) {
      ctx.texts.push(text);
      ctx.textAlphas.push(ctx.globalAlpha);
      ctx.textAt.push({ text, x, y, alpha: ctx.globalAlpha, font: ctx.font });
    },
    strokeText: count("strokeText"),
    // About 6 px a character, like 12 px text.
    measureText: (text: string) => ({ width: text.length * 6 }),
    setLineDash(dash: number[]) {
      calls.setLineDash = (calls.setLineDash ?? 0) + 1;
      dashed = dash.length > 0;
    },
    font: "",
    textAlign: "",
    textBaseline: "",
    lineJoin: "",
    globalAlpha: 1,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
  };
  function paint(style: string): Paint {
    return { style, alpha: ctx.globalAlpha, width: ctx.lineWidth, dashed, ops };
  }
  return ctx;
}
type Recording = ReturnType<typeof recordingContext>;

/** What the last frame drew. */
function lastFrame(ctx: Recording) {
  const start = ctx.frames.at(-1) ?? { texts: 0, strokes: 0, fills: 0 };
  return {
    texts: ctx.textAt.slice(start.texts),
    strokes: ctx.strokes.slice(start.strokes),
    fills: ctx.fills.slice(start.fills),
  };
}

/** The straight segments a stroke traced, as [x1, y1, x2, y2]. */
function segments(p: Paint): number[][] {
  const out: number[][] = [];
  for (let i = 0; i + 1 < p.ops.length; i += 1) {
    const a = p.ops[i];
    const b = p.ops[i + 1];
    if (a?.[0] === "m" && b?.[0] === "l") out.push([a[1], a[2], b[1], b[2]]);
  }
  return out;
}

/** The stroke that drew the link between two screen points, either way round. */
function strokeOf(ctx: Recording, p: [number, number], q: [number, number]): Paint | undefined {
  const same = (s: number[], a: [number, number], b: [number, number]) =>
    s[0] === a[0] && s[1] === a[1] && s[2] === b[0] && s[3] === b[1];
  return ctx.strokes.find((s) => segments(s).some((seg) => same(seg, p, q) || same(seg, q, p)));
}

/** The fill that drew a dot centred on a screen point. */
function fillOf(ctx: Recording, at: [number, number]): Paint | undefined {
  return ctx.fills.find((f) =>
    f.ops.some((op) => op[0] === "a" && op[1] === at[0] && op[2] === at[1]),
  );
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
const DISPLAY: DisplayOptions = { nodeSize: 1, linkThickness: 1, arrows: false, textFade: 0 };
const NO_EMPHASIS: Emphasis = { focusKey: null, hoverKey: null, lit: null, depths: null };

interface RenderInput {
  nodes: SceneNode[];
  edges?: Scene["edges"];
  camera?: { x: number; y: number; s: number };
  display?: Partial<DisplayOptions>;
  emphasis?: Partial<Emphasis>;
  view?: { width: number; height: number };
  regions?: SceneRegions;
}

/** One frame of a scene, at a whole-area scale of 1 so the camera scale is the zoom ratio. */
function render(input: RenderInput) {
  const ctx = recordingContext();
  const r = new GraphRenderer(canvasWith(ctx), { ...noMotion, fitScale: () => 1 });
  r.resize(input.view?.width ?? 400, input.view?.height ?? 400);
  r.setScene({ nodes: input.nodes, edges: input.edges ?? [] });
  if (input.regions) r.setRegions(input.regions);
  if (input.display) r.setDisplay({ ...DISPLAY, ...input.display });
  r.setCamera(input.camera ?? { x: 0, y: 0, s: 1 });
  if (input.emphasis) r.setEmphasis({ ...NO_EMPHASIS, ...input.emphasis });
  flushFrames();
  return { ctx, r };
}

const depthsOf = (entries: Record<string, number>) => new Map(Object.entries(entries));

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

describe("link strength", () => {
  it("rests links fainter as more of the screen fills with them", () => {
    expect(restLinkAlpha(0)).toBe(REST_LINK_MAX);
    let prev = REST_LINK_MAX;
    for (const density of [0.01, 0.05, 0.2, 1, 3]) {
      const a = restLinkAlpha(density);
      expect(a).toBeLessThanOrEqual(prev);
      prev = a;
    }
    expect(restLinkAlpha(0.2)).toBeLessThan(restLinkAlpha(0.01));
    expect(restLinkAlpha(1e6)).toBe(REST_LINK_MIN);
  });

  it("keeps the web of a dense area faint but visible, and the faded links nearly invisible", () => {
    // How far a link at this alpha moves the background, in grey levels: --graph-edge over
    // --bg in the light and the dark theme. One stroke paints overlapping links once, so a
    // dense area darkens by this much and no more.
    const levels = (alpha: number) => [(0xf6 - 0x6f) * alpha, (0x9a - 0x11) * alpha];
    // 16,000 links averaging 178 px across a 1400 x 900 screen, as on a large area seen whole.
    const dense = restLinkAlpha(linkDensity(16_000 * 178, 1400, 900));
    for (const shift of levels(dense)) {
      expect(shift).toBeGreaterThanOrEqual(4);
      expect(shift).toBeLessThanOrEqual(7);
    }
    // Around a hovered note, every other link drops to about one level.
    for (const shift of levels(fadedLinkAlpha(dense))) expect(shift).toBeLessThan(1.5);
  });

  it("keeps the highlighted path clear of the rest at any density", () => {
    for (const all of [0.001, 0.1, 1.3, 10]) {
      const a = linkAlphas("depth", { all, near: all / 50, path: all / 5, suggested: 0 });
      // Everything outside the path is nearly invisible, the path at least 2.5 times rest.
      expect(a.dim).toBeLessThan(a.rest * 0.5);
      expect(a.path).toBeGreaterThanOrEqual(a.rest * 2.5 - 1e-9);
      expect(a.near).toBeGreaterThanOrEqual(NEAR_MIN);
    }
    // A note with a few links gets the full accent; a hub's fan softens, down to a floor.
    expect(linkAlphas("depth", { all: 0.5, near: 0.001, path: 0, suggested: 0 }).near).toBe(
      NEAR_MAX,
    );
    const hub = linkAlphas("depth", { all: 1.3, near: 0.3, path: 0, suggested: 0 }).near;
    expect(hub).toBeLessThan(NEAR_MAX);
    expect(hub).toBeGreaterThanOrEqual(NEAR_MIN);
  });

  it("dims links outside a legend highlight but keeps them visible on large areas", () => {
    const rest = restLinkAlpha(5);
    expect(dimmedEdgeAlpha(rest)).toBeGreaterThan(0);
    expect(dimmedEdgeAlpha(rest)).toBeLessThanOrEqual(rest);
    expect(dimmedEdgeAlpha(0.2)).toBeCloseTo(0.08);
    // Around a hovered note they fade further, to nearly nothing.
    expect(fadedLinkAlpha(rest)).toBeLessThan(dimmedEdgeAlpha(rest));
    expect(linkAlphas("lit", { all: 5, near: 0, path: 0, suggested: 0 }).dim).toBe(
      dimmedEdgeAlpha(rest),
    );
  });
});

describe("note and label strength", () => {
  it("computes label opacity from zoom, emphasis and legacy", () => {
    expect(labelOpacity(0, true, FADED, true)).toBe(1);
    // Direct neighbours (and legend-lit notes) are named whatever the zoom.
    expect(labelOpacity(0, false, 1, false)).toBe(1);
    expect(labelOpacity(0, false, 1, true)).toBe(LEGACY_ALPHA);
    expect(labelOpacity(1, false, FADED, false)).toBe(DIM_ALPHA);
    expect(labelOpacity(0.5, false, CALM, true)).toBeCloseTo(0.5 * LEGACY_ALPHA);
    expect(labelOpacity(0, false, CALM, false)).toBe(0);
    // Deeper notes follow the zoom, a little softer.
    expect(labelOpacity(0, false, 2, false)).toBe(0);
    expect(labelOpacity(1, false, 2, false)).toBe(DEPTH_ALPHAS[2]);
    expect(labelOpacity(1, false, 3, false)).toBe(DEPTH_ALPHAS[3]);
  });

  it("draws most notes small and hubs larger", () => {
    // Sizes are 1 + links: a lone note, a typical one in a dense area, a hub.
    expect(screenRadius(1, false, 1)).toBeLessThanOrEqual(2);
    expect(screenRadius(19, false, 1)).toBeLessThan(4);
    expect(screenRadius(500, false, 1)).toBeGreaterThan(screenRadius(19, false, 1) + 1);
    expect(screenRadius(1e6, false, 1)).toBeLessThanOrEqual(5);
  });

  it("orders labels by rank, then size, then scene order", () => {
    const keys = Float64Array.from([
      labelSortKey(RANK_REST, 50, 0),
      labelSortKey(RANK_NEAR, 1, 1),
      labelSortKey(RANK_SOURCE, 1, 2),
      labelSortKey(RANK_REST, 50, 3),
      labelSortKey(RANK_REST, 99, 4),
    ]).sort();
    expect(Array.from(keys, (k) => labelSortIndex(k))).toEqual([2, 1, 4, 0, 3]);
  });

  it("places boxes only where they overlap none placed before", () => {
    const boxes = new LabelBoxes();
    expect(boxes.place(0, 0, 10, 10)).toBe(true);
    expect(boxes.place(5, 5, 15, 15)).toBe(false);
    // Touching edges is not overlapping.
    expect(boxes.place(10, 0, 20, 10)).toBe(true);
    // Grows past its first buffer.
    for (let i = 0; i < 300; i += 1)
      expect(boxes.place(100 + i * 20, 0, 110 + i * 20, 10)).toBe(true);
    expect(boxes.size).toBe(302);
    boxes.reset();
    expect(boxes.place(5, 5, 15, 15)).toBe(true);
  });

  it("fades region names out between the whole area and closer zooms", () => {
    expect(regionLabelAlpha(0.6)).toBe(1);
    expect(regionLabelAlpha(REGION_FADE_FROM)).toBe(1);
    expect(regionLabelAlpha((REGION_FADE_FROM + REGION_FADE_TO) / 2)).toBeCloseTo(0.5);
    expect(regionLabelAlpha(REGION_FADE_TO)).toBe(0);
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
    expect(r.pickRegion(10, 10)).toBeNull();
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
    r.setEmphasis({ ...NO_EMPHASIS, focusKey: "a" });
    r.setDragging("a");
    r.setRegions({ assign: Int32Array.from([0, 0, 0]), names: ["Region"] });
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
    const { ctx } = render({
      nodes: [node("b", 10, 10), node("a", 50, 50)],
      emphasis: { focusKey: "a", hoverKey: "b" },
    });
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
    display?: Partial<DisplayOptions>,
    edges: Scene["edges"] = [],
  ) {
    return render({ nodes, edges, camera, display });
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
    expect(ctx.strokes[0]?.style).toBe("#123456");
  });

  it("hides note labels below the zoom threshold and draws them above it", () => {
    const nodes = [node("a", 10, 10), node("b", 50, 50), node("t", 80, 80, { topic: true })];
    // Topics are named at any zoom while topic labels are on; notes wait for the threshold.
    expect(drawn(nodes, { x: 0, y: 0, s: 1 }).ctx.texts).toEqual(["t"]);
    expect(drawn(nodes, { x: 0, y: 0, s: 4 }).ctx.texts.sort()).toEqual(["a", "b", "t"]);
    // A higher text fade shows them sooner; a lower one later.
    expect(drawn(nodes, { x: 0, y: 0, s: 1 }, { textFade: 3 }).ctx.texts).toHaveLength(3);
    expect(drawn(nodes, { x: 0, y: 0, s: 4 }, { textFade: -3 }).ctx.texts).toEqual(["t"]);
  });

  it("fades labels in over a short zoom range", () => {
    const t = labelThreshold(0);
    expect(labelAlpha(t, 0)).toBe(0);
    expect(labelAlpha(t * 1.25, 0)).toBeCloseTo(0.5);
    expect(labelAlpha(t * 2, 0)).toBe(1);
    expect(labelThreshold(3)).toBeLessThan(labelThreshold(0));
    expect(labelThreshold(-3)).toBeGreaterThan(labelThreshold(0));
  });

  /** Notes spaced so far apart on screen at 4x that no two labels can overlap. */
  const spaced = (count: number, columns: number, size: (i: number) => number) =>
    Array.from({ length: count }, (_, i) =>
      node(`n${i}`, (i % columns) * 10 + 5, Math.floor(i / columns) * 5 + 2, { size: size(i) }),
    );

  it("caps labels per frame, biggest notes first", () => {
    const nodes = spaced(500, 25, (i) => (i === 499 ? 50 : 1));
    const { ctx } = render({
      nodes,
      camera: { x: 0, y: 0, s: 4 },
      view: { width: 1100, height: 450 },
    });
    expect(ctx.texts).toHaveLength(300);
    expect(ctx.texts[0]).toBe("n499");
  });

  it("keeps hover and focus labels inside the cap", () => {
    const nodes = spaced(400, 20, (i) => (i === 0 ? 1 : 10));
    const { ctx } = render({
      nodes,
      camera: { x: 0, y: 0, s: 4 },
      view: { width: 900, height: 450 },
      emphasis: { hoverKey: "n0" },
    });
    expect(ctx.texts).toHaveLength(300);
    expect(ctx.texts[0]).toBe("n0");
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
    expect(shown?.endsWith("…")).toBe(true);
    expect(shown?.length).toBeLessThanOrEqual(28);
  });

  function emphasised(
    nodes: SceneNode[],
    emphasis: Partial<Emphasis>,
    camera = { x: 0, y: 0, s: 1 },
    edges: Scene["edges"] = [],
  ) {
    return render({ nodes, edges, camera, emphasis }).ctx;
  }

  it("always labels the hovered and focused notes at full strength, even zoomed out", () => {
    const nodes = [node("a", 10, 10), node("b", 50, 50), node("c", 90, 90)];
    const ctx = emphasised(nodes, { focusKey: "a", hoverKey: "b" });
    expect(ctx.texts.sort()).toEqual(["a", "b"]);
    expect(ctx.textAlphas).toEqual([1, 1]);
  });

  it("labels lit notes while hovering and fades the rest with their dots", () => {
    const nodes = [node("a", 10, 10), node("b", 50, 50), node("c", 90, 90)];
    const lit = new Set(["a", "b"]);
    const out = emphasised(nodes, { hoverKey: "a", lit });
    expect(out.texts.sort()).toEqual(["a", "b"]);
    // Zoomed in, the unlit label still shows but dimmed.
    const zoomed = emphasised(nodes, { hoverKey: "a", lit }, { x: 0, y: 0, s: 4 });
    const alphaOf = (t: string) => zoomed.textAlphas[zoomed.texts.indexOf(t)];
    expect(alphaOf("b")).toBe(1);
    expect(alphaOf("c")).toBeCloseTo(DIM_ALPHA);
  });

  it("names every topic with topic labels on, and only a hovered one with them off", () => {
    const nodes = [
      node("t", 10, 10, { topic: true, label: "A topic" }),
      node("u", 200, 200, { topic: true, label: "Another topic" }),
    ];
    const named = (topicLabels: boolean, hoverKey: string | null) =>
      render({ nodes, display: { topicLabels }, emphasis: { hoverKey } }).ctx.texts.sort();
    expect(named(true, null)).toEqual(["A topic", "Another topic"]);
    expect(named(false, null)).toEqual([]);
    expect(named(false, "t")).toEqual(["A topic"]);
  });

  it("fades a topic's label with its ring outside a hovered note's depths", () => {
    const nodes = [node("t", 10, 10, { topic: true, label: "A topic" }), node("a", 200, 200)];
    const { ctx } = render({ nodes, emphasis: { hoverKey: "a", depths: depthsOf({ a: 0 }) } });
    expect(ctx.textAt.find((l) => l.text === "A topic")?.alpha).toBeCloseTo(DIM_ALPHA);
    expect(ctx.textAt.find((l) => l.text === "a")?.alpha).toBe(1);
  });

  it("gives topic labels way to region names, but not to plain notes", () => {
    // A topic at the centroid of a named region, and another beside a much bigger note.
    const nodes = [
      node("p", 90, 100, { label: "" }),
      node("q", 110, 100, { label: "" }),
      node("hub", 100, 100, { topic: true, label: "Hub topic" }),
      node("t", 300, 300, { topic: true, label: "Lone topic" }),
      node("big", 301, 300, { size: 99, label: "Big note" }),
    ];
    const { ctx } = render({
      nodes,
      camera: { x: 0, y: 0, s: 1 },
      display: { textFade: 3 },
      regions: { assign: Int32Array.from([0, 0, 0, -1, -1]), names: ["Region"] },
    });
    // The hub's label would cross its region's name and the big note's would cross the lone
    // topic's: the name and the topic win.
    expect(ctx.texts).toEqual(["Region", "Lone topic"]);
  });

  it("rests links fainter when more of the screen fills with them", () => {
    const restOf = (count: number) => {
      const nodes = Array.from({ length: count + 1 }, (_, i) =>
        node(`n${i}`, (i * 37) % 400, (i * 91) % 400, { label: "" }),
      );
      const edges = Array.from({ length: count }, (_, i) => ({ a: i, b: i + 1, suggested: false }));
      // With nothing emphasised every link is in the one rest stroke.
      return render({ nodes, edges }).ctx.strokes[0]?.alpha as number;
    };
    expect(restOf(3)).toBe(REST_LINK_MAX);
    expect(restOf(300)).toBeLessThan(REST_LINK_MAX);
    expect(restOf(3000)).toBeLessThan(restOf(300));
    expect(restOf(3000)).toBeGreaterThanOrEqual(REST_LINK_MIN);
  });

  it("draws the hovered note's links in the accent and dims unlit links under a legend highlight", () => {
    const nodes = [node("a", 10, 10), node("b", 100, 10), node("c", 10, 200), node("d", 200, 200)];
    const edges = [
      { a: 0, b: 1, suggested: false },
      { a: 2, b: 3, suggested: false },
    ];
    const ctx = emphasised(nodes, { hoverKey: "a", lit: new Set(["a", "b"]) }, undefined, edges);
    // The first stroke is the dimmed batch: fainter than rest, but still visible.
    expect(ctx.strokes[0]).toBe(strokeOf(ctx, [10, 200], [200, 200]));
    expect(ctx.strokeAlphas[0]).toBeCloseTo(dimmedEdgeAlpha(REST_LINK_MAX));
    expect(ctx.strokeAlphas[0]).toBeGreaterThan(0);
    expect(ctx.strokeAlphas[0]).toBeLessThan(REST_LINK_MAX);
    const accent = strokeOf(ctx, [10, 10], [100, 10]);
    expect(accent?.style).toBe(ACCENT);
    expect(accent?.alpha).toBe(NEAR_MAX);
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

  describe("depth emphasis", () => {
    // s links to a1 and a2; a1 to a2 (the same depth), and on outwards a1, b1, c1; x off to c1.
    const nodes = [
      node("s", 200, 200),
      node("a1", 100, 200),
      node("a2", 300, 200),
      node("b1", 100, 100),
      node("c1", 100, 20),
      node("x", 350, 350),
    ];
    const edges = [
      { a: 0, b: 1, suggested: false },
      { a: 0, b: 2, suggested: false },
      { a: 1, b: 2, suggested: false },
      { a: 1, b: 3, suggested: false },
      { a: 3, b: 4, suggested: false },
      { a: 5, b: 4, suggested: false },
    ];
    const at = (key: string): [number, number] => {
      const n = nodes.find((m) => m.key === key) as SceneNode;
      return [n.x, n.y];
    };
    const link = (ctx: Recording, p: string, q: string) => strokeOf(ctx, at(p), at(q));
    const depth1 = depthsOf({ s: 0, a1: 1, a2: 1 });
    const depth2 = depthsOf({ s: 0, a1: 1, a2: 1, b1: 2 });
    /** A link's alpha with nothing emphasised. */
    const restAlpha = () => link(render({ nodes, edges }).ctx, "a1", "b1")?.alpha as number;

    it("draws only the source's own links, in the accent, at depth 1", () => {
      const rest = restAlpha();
      const ctx = render({ nodes, edges, emphasis: { hoverKey: "s", depths: depth1 } }).ctx;
      for (const [p, q] of [
        ["s", "a1"],
        ["s", "a2"],
      ] as const) {
        const own = link(ctx, p, q);
        expect(own?.style).toBe(ACCENT);
        expect(own?.dashed).toBe(false);
        expect(own?.width).toBe(1.5);
        expect(own?.alpha).toBeGreaterThanOrEqual(NEAR_MIN);
      }
      // Links among neighbours, further out, or elsewhere fade to nearly nothing.
      for (const [p, q] of [
        ["a1", "a2"],
        ["a1", "b1"],
        ["b1", "c1"],
        ["x", "c1"],
      ] as const) {
        const faded = link(ctx, p, q);
        expect(faded?.style).toBe(EDGE);
        expect(faded?.alpha).toBeLessThan(rest * 0.5);
      }
      expect(rest).toBe(REST_LINK_MAX);
    });

    it("adds the next step as a stronger neutral at depth 2, and nothing past it", () => {
      const rest = restAlpha();
      const ctx = render({ nodes, edges, emphasis: { hoverKey: "s", depths: depth2 } }).ctx;
      expect(link(ctx, "s", "a1")?.style).toBe(ACCENT);
      const step = link(ctx, "a1", "b1");
      expect(step?.style).toBe(EDGE);
      expect(step?.alpha).toBeGreaterThan(rest);
      const faded = link(ctx, "a1", "a2")?.alpha as number;
      expect(faded).toBeLessThan(rest * 0.5);
      // One step past the depth, or between notes at the same depth, stays faded.
      expect(link(ctx, "b1", "c1")?.alpha).toBe(faded);
      expect(link(ctx, "x", "c1")?.alpha).toBe(faded);
    });

    it("keeps the accent for the source's own suggested links, and a deeper one neutral", () => {
      // As above, but Reflect suggests s-a2 (the source's own) and a1-b1 (a step further out).
      const suggests = (e: Scene["edges"][number]) =>
        (e.a === 0 && e.b === 2) || (e.a === 1 && e.b === 3);
      const show = (links: Scene["edges"]) =>
        render({
          nodes,
          edges: links,
          display: { arrows: true },
          emphasis: { hoverKey: "s", depths: depth2 },
        }).ctx;
      const plain = show(edges);
      const ctx = show(edges.map((e) => ({ ...e, suggested: suggests(e) })));
      expect(link(ctx, "s", "a2")).toMatchObject({ style: ACCENT, dashed: true });
      const deeper = link(ctx, "a1", "b1");
      expect(deeper).toMatchObject({ style: EDGE, dashed: true });
      // As strong as the plain step would be, and below the source's own links.
      expect(deeper?.alpha).toBe(link(plain, "a1", "b1")?.alpha);
      expect(deeper?.alpha).toBeLessThan(link(ctx, "s", "a1")?.alpha as number);
      // Its arrowhead, whose tip sits on b1's rim facing a1 (straight below), is neutral too.
      const [bx, by] = at("b1");
      const tipY = by + screenRadius(1, false, 1);
      const head = ctx.fills.find((f) =>
        f.ops.some((op) => op[0] === "m" && op[1] === bx && op[2] === tipY),
      );
      expect(head?.style).toBe(EDGE);
    });

    it("draws depth 2 a little softer, fades notes outside and keeps the selection", () => {
      const one = render({ nodes, edges, emphasis: { hoverKey: "s", depths: depth1 } }).ctx;
      const two = render({
        nodes,
        edges,
        emphasis: { hoverKey: "s", focusKey: "x", depths: depth2 },
      }).ctx;
      expect(fillOf(one, at("s"))?.alpha).toBe(1);
      expect(fillOf(one, at("a1"))?.alpha).toBe(1);
      expect(fillOf(one, at("b1"))?.alpha).toBe(DIM_ALPHA);
      expect(fillOf(two, at("b1"))?.alpha).toBe(DEPTH_ALPHAS[2]);
      expect(fillOf(two, at("c1"))?.alpha).toBe(DIM_ALPHA);
      // The selected note stays at full strength while another note's depths are shown.
      expect(fillOf(two, at("x"))?.alpha).toBe(1);
      // Faded notes are drawn first, so emphasised ones sit on top.
      expect(two.fills[0]?.alpha).toBe(DIM_ALPHA);
      expect(two.fills.at(-1)?.alpha).toBe(1);
    });

    it("names the source and its direct neighbours zoomed out, and deeper notes zoomed in", () => {
      const out = render({ nodes, edges, emphasis: { hoverKey: "s", depths: depth2 } }).ctx;
      expect(out.texts.sort()).toEqual(["a1", "a2", "s"]);
      const zoomed = render({
        nodes,
        edges,
        camera: { x: 0, y: 0, s: 3 },
        emphasis: { hoverKey: "s", depths: depth2 },
      }).ctx;
      const alphaOf = (t: string) => zoomed.textAt.find((l) => l.text === t)?.alpha;
      expect(alphaOf("b1")).toBeCloseTo(DEPTH_ALPHAS[2]);
      expect(alphaOf("c1")).toBeCloseTo(DIM_ALPHA);
    });
  });

  describe("label placement", () => {
    // Three pairs whose labels overlap on screen at 4x, each a small note beside a big one.
    const pairs = [
      node("src", 25, 10),
      node("huge", 26, 10, { size: 99 }),
      node("sel", 25, 40),
      node("d1a", 26, 40, { size: 99 }),
      node("d1b", 25, 70),
      node("rest", 26, 70, { size: 99 }),
    ];
    const zoomed = { x: 0, y: 0, s: 4 };

    it("skips a label that would overlap a bigger note's when nothing is emphasised", () => {
      expect(render({ nodes: pairs, camera: zoomed }).ctx.texts).toEqual(["huge", "d1a", "rest"]);
    });

    it("places the source, then the selection, then direct neighbours, then the rest", () => {
      const { ctx } = render({
        nodes: pairs,
        camera: zoomed,
        emphasis: {
          hoverKey: "src",
          focusKey: "sel",
          depths: depthsOf({ src: 0, d1a: 1, d1b: 1 }),
        },
      });
      expect(ctx.texts).toEqual(["src", "sel", "d1b"]);
    });

    it("never lets two drawn labels overlap", () => {
      let seed = 7;
      const random = () => {
        seed = (seed * 16807) % 2147483647;
        return seed / 2147483647;
      };
      const nodes = Array.from({ length: 400 }, (_, i) =>
        node(`note ${i}`, random() * 100, random() * 100, { size: 1 + Math.floor(random() * 40) }),
      );
      const { ctx } = render({ nodes, camera: zoomed });
      expect(ctx.texts.length).toBeGreaterThan(20);
      const boxes = ctx.textAt.map((l) => ({ x: l.x, y: l.y, w: l.text.length * 6 }));
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const a = boxes[i] as (typeof boxes)[number];
          const b = boxes[j] as (typeof boxes)[number];
          const overlap = Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < 14;
          expect(overlap).toBe(false);
        }
      }
    });
  });

  describe("regions", () => {
    // Region 0 around (20, 20), region 1 around (310, 310), a note in neither, a region too
    // small to name and one without a name. Notes have no titles, so only region names draw.
    const nodes = [
      node("p", 10, 10, { label: "" }),
      node("q", 30, 10, { label: "" }),
      node("r", 20, 40, { label: "" }),
      node("u", 300, 300, { label: "" }),
      node("v", 320, 300, { label: "" }),
      node("w", 310, 330, { label: "" }),
      node("loner", 200, 200, { label: "" }),
      node("t1", 100, 300, { label: "" }),
      node("t2", 110, 300, { label: "" }),
      node("m1", 300, 100, { label: "" }),
      node("m2", 310, 100, { label: "" }),
      node("m3", 320, 100, { label: "" }),
    ];
    const regions: SceneRegions = {
      assign: Int32Array.from([0, 0, 0, 1, 1, 1, -1, 2, 2, 3, 3, 3]),
      names: ["Alpha", "Beta", "Tiny", ""],
    };
    const withRegions = (s = 1) => render({ nodes, camera: { x: 0, y: 0, s }, regions });
    /** The region names the last frame drew, in the region font. */
    const names = (ctx: Recording) =>
      lastFrame(ctx).texts.filter((l) => l.font.startsWith("600 16px"));
    const middle = (REGION_FADE_FROM + REGION_FADE_TO) / 2;

    it("names each region at its notes' centroid, larger and softer than note labels", () => {
      const drawn = names(withRegions().ctx);
      expect(drawn.map((l) => [l.text, l.x, l.y])).toEqual([
        ["Alpha", 20, 20],
        ["Beta", 310, 310],
      ]);
      expect(drawn[0]?.alpha).toBeGreaterThan(0.3);
      expect(drawn[0]?.alpha).toBeLessThan(1);
    });

    it("follows the notes as they move", () => {
      const { ctx, r } = withRegions();
      r.setPositions(
        Float64Array.from(nodes, (n) => n.x + 50),
        Float64Array.from(nodes, (n) => n.y + 50),
      );
      flushFrames();
      expect(names(ctx)[0]).toMatchObject({ text: "Alpha", x: 70, y: 70 });
    });

    it("fades names out as you zoom in", () => {
      const whole = names(withRegions().ctx)[0]?.alpha as number;
      const closer = names(withRegions(middle).ctx)[0]?.alpha as number;
      expect(closer).toBeCloseTo(whole / 2);
      expect(names(withRegions(REGION_FADE_TO).ctx)).toEqual([]);
    });

    it("picks a region by its drawn name, and not once it has mostly faded", () => {
      const { r } = withRegions();
      expect(r.pickRegion(20, 20)).toBe(0);
      expect(r.pickRegion(310 + 10, 310)).toBe(1);
      expect(r.pickRegion(200, 200)).toBeNull();
      // Still drawn faintly near the end of the fade, but no longer clickable.
      const s = REGION_FADE_TO - 0.2;
      const faint = withRegions(s);
      expect(names(faint.ctx).map((l) => l.text)).toEqual(["Alpha"]);
      expect(faint.r.pickRegion(20 * s, 20 * s)).toBeNull();
      expect(withRegions(middle).r.pickRegion(20 * middle, 20 * middle)).toBe(0);
    });

    it("gives a region's world bounds where its notes are now", () => {
      const { r } = withRegions();
      expect(r.regionBounds(0)).toEqual({ minX: 10, minY: 10, maxX: 30, maxY: 40 });
      // Small and unnamed regions have bounds too.
      expect(r.regionBounds(2)).toEqual({ minX: 100, minY: 300, maxX: 110, maxY: 300 });
      expect(r.regionBounds(9)).toBeNull();
      r.setPositions(new Float64Array(nodes.length), new Float64Array(nodes.length));
      expect(r.regionBounds(1)).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
      r.setRegions(null);
      flushFrames();
      expect(r.regionBounds(0)).toBeNull();
      expect(r.pickRegion(20, 20)).toBeNull();
    });

    it("keeps each note's region by key when the scene changes", () => {
      const { ctx, r } = withRegions();
      // Reordered, without one of region 1's notes, and with a new note, which has no region.
      const next = [5, 3, 2, 1, 0].map((i) => nodes[i] as SceneNode);
      r.setScene({ nodes: [...next, node("new", 80, 80, { label: "" })], edges: [] });
      flushFrames();
      // Alpha keeps its three notes; Beta has two left, too few to name.
      expect(names(ctx).map((l) => [l.text, l.x, l.y])).toEqual([["Alpha", 20, 20]]);
      expect(r.regionBounds(1)).toEqual({ minX: 300, minY: 300, maxX: 310, maxY: 330 });
    });

    it("ignores regions that do not fit the scene drawn, and never holds them for a later one", () => {
      const { ctx, r } = withRegions();
      const redraw = () => {
        r.setCamera(r.camera);
        flushFrames();
      };
      const next: SceneRegions = { ...regions, names: ["Gamma", "Delta", "", ""] };
      // Regions for all the notes, given while only Alpha's are drawn, change nothing...
      r.setScene({ nodes: nodes.slice(0, 3), edges: [] });
      r.setRegions(next);
      redraw();
      expect(names(ctx).map((l) => l.text)).toEqual(["Alpha"]);
      // ...and are not held for a scene they would fit: its notes keep their regions by key.
      r.setScene({ nodes, edges: [] });
      redraw();
      expect(names(ctx).map((l) => l.text)).toEqual(["Alpha", "Beta"]);
      // Passed right after the scene they are aligned with, they apply to it.
      r.setRegions(next);
      redraw();
      expect(names(ctx).map((l) => [l.text, l.x, l.y])).toEqual([
        ["Gamma", 20, 20],
        ["Delta", 310, 310],
      ]);
    });

    it("places names ahead of other notes' labels, but behind the hovered note's", () => {
      // A big note without a region, whose label would cross Alpha's name.
      const show = (emphasis?: Partial<Emphasis>) => {
        const { ctx } = render({
          nodes: [...nodes, node("big", 20, 18, { size: 99 })],
          regions: { assign: Int32Array.from([...regions.assign, -1]), names: regions.names },
          display: { textFade: 3 },
          emphasis,
        });
        return lastFrame(ctx).texts.map((l) => l.text);
      };
      expect(show()).toEqual(["Alpha", "Beta"]);
      expect(show({ hoverKey: "big", depths: depthsOf({ big: 0 }) })).toEqual(["Beta", "big"]);
    });
  });

  it("rings the dragged note boldly in place of its hover ring", () => {
    const { ctx, r } = render({ nodes: [node("a", 50, 50), node("b", 150, 50)] });
    const radius = ctx.radii[0] as number;
    const rings = () => lastFrame(ctx).strokes.filter((s) => s.ops.some((op) => op[0] === "a"));
    r.setEmphasis({ ...NO_EMPHASIS, hoverKey: "a", depths: depthsOf({ a: 0 }) });
    r.setDragging("a");
    flushFrames();
    const dragged = rings();
    expect(dragged).toHaveLength(1);
    expect(dragged[0]).toMatchObject({ style: ACCENT, width: 2.5, alpha: 1 });
    expect(dragged[0]?.ops).toContainEqual(["a", 50, 50, radius + 4]);
    r.setDragging(null);
    flushFrames();
    const hovered = rings();
    expect(hovered).toHaveLength(1);
    expect(hovered[0]).toMatchObject({ style: ACCENT, width: 1.5 });
    expect(hovered[0]?.ops).toContainEqual(["a", 50, 50, radius + 3]);
  });
});

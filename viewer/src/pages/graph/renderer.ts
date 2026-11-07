// The graph's 2D canvas renderer. It draws only what is on screen, only when something
// changed (one requestAnimationFrame per change), and animates the camera itself so React
// never re-renders per frame. It knows nothing of React or the API: the page hands it a Scene.
import { type Camera, fitCamera } from "./camera";
import type { Bounds } from "./layout";
import { cameraEase, edgeAlpha, SpatialGrid, screenRadius, visibleWorld } from "./renderer-math";
import type { Emphasis, Scene, SceneNode, Tone } from "./scene";

export interface RendererOptions {
  reducedMotion: () => boolean;
  /** The page's whole-area camera scale (the one it passes to levelFor), so dot sizes follow the
   * page's zoom levels. Without it the renderer fits the scene's own bounds, which shift when a
   * type is hidden. */
  fitScale?: () => number;
}

type Listener = (camera: Camera) => void;

interface Palette {
  tones: Record<Tone, string>;
  edge: string;
  edgeStrong: string;
  suggested: string;
}

const TONES: readonly Tone[] = ["slot1", "slot2", "slot3", "other", "topic"];
const TONE_VARS: Record<Tone, string> = {
  slot1: "--type-1",
  slot2: "--type-2",
  slot3: "--type-3",
  other: "--type-other",
  topic: "--type-topic",
};
/** Colours used when a custom property is missing (tests, a stylesheet not loaded yet). */
const FALLBACK: Palette = {
  tones: { slot1: "#2a78d6", slot2: "#eb6834", slot3: "#1baf7a", other: "#8a8b93", topic: "#555" },
  edge: "#6f7078",
  edgeStrong: "#2944b8",
  suggested: "#2944b8",
};

/** Screen margin around the viewport inside which notes and links still draw. */
const CULL_MARGIN = 24;
const DIM_ALPHA = 0.15;
const LEGACY_ALPHA = 0.45;
/** Note strengths, as indices into STRENGTH_ALPHA and the node batches. */
const FULL = 0;
const LEGACY = 1;
const DIMMED = 2;
const STRENGTH_ALPHA = [1, LEGACY_ALPHA, DIM_ALPHA] as const;
const EMPTY_EMPHASIS: Emphasis = { focusKey: null, hoverKey: null, lit: null };

interface Animation {
  from: Camera;
  to: Camera;
  start: number;
  duration: number;
  resolve: () => void;
}

export class GraphRenderer {
  private readonly ctx: CanvasRenderingContext2D | null;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private cam: Camera = { x: 0, y: 0, s: 1 };
  private scene: Scene = { nodes: [], edges: [] };
  private grid = new SpatialGrid([]);
  private bounds: Bounds | null = null;
  private emphasis: Emphasis = EMPTY_EMPHASIS;
  private palette: Palette = FALLBACK;
  private listeners = new Set<Listener>();
  private frame: number | null = null;
  private animation: Animation | null = null;
  private drawMs = 0;
  // Path batches kept across frames so steady-state frames allocate nothing.
  private readonly edgeBatches = {
    rest: new PathBatch(),
    strong: new PathBatch(),
    suggested: new PathBatch(),
    dimmed: new PathBatch(),
    dimmedSuggested: new PathBatch(),
  };
  // One batch per tone and strength, indexed by toneIndex * 3 + strength, so a frame does
  // no string building or map lookups per note.
  private readonly nodeBatches: PathBatch[] = Array.from(
    { length: TONES.length * 3 },
    () => new PathBatch(),
  );
  private readonly ringBatch = new PathBatch();
  private destroyed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly options: RendererOptions,
  ) {
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext("2d");
    } catch {
      // jsdom throws "not implemented" without the canvas package; drawing is skipped.
    }
    this.ctx = ctx;
    this.refreshStyle();
  }

  /** True while an animated camera move runs. */
  get animating(): boolean {
    return this.animation !== null;
  }

  resize(width: number, height: number): void {
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    // Assigning canvas.width reallocates and clears the bitmap, so skip a same-size resize.
    if (width === this.width && height === this.height && dpr === this.dpr) return;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(height * this.dpr));
    // CSS owns the element's size; only the backing store changes here. Resizing it clears the
    // bitmap, so redraw now (a ResizeObserver runs before paint) instead of a blank frame.
    if (this.ctx && !this.destroyed) {
      if (this.frame !== null && !this.animation) {
        cancelAnimationFrame(this.frame);
        this.frame = null;
      }
      this.draw();
    } else {
      this.schedule();
    }
  }

  setScene(scene: Scene): void {
    this.scene = scene;
    this.grid = new SpatialGrid(scene.nodes);
    this.bounds = boundsOf(scene.nodes);
    this.schedule();
  }

  setEmphasis(emphasis: Emphasis): void {
    this.emphasis = emphasis;
    this.schedule();
  }

  get camera(): Camera {
    return { ...this.cam };
  }

  setCamera(camera: Camera): void {
    this.finishAnimation();
    this.moveCamera(camera);
  }

  animateTo(camera: Camera, durationMs: number): Promise<void> {
    this.finishAnimation();
    if (this.options.reducedMotion() || durationMs <= 0 || this.destroyed) {
      this.moveCamera(camera);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.animation = {
        from: this.camera,
        to: { ...camera },
        start: now(),
        duration: durationMs,
        resolve,
      };
      this.schedule();
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  pick(x: number, y: number, slop = 4): string | null {
    if (this.scene.nodes.length === 0) return null;
    const zoom = this.zoomRatio();
    const reach = (12 + 1.5 + slop) / this.cam.s;
    const wx = (x - this.cam.x) / this.cam.s;
    const wy = (y - this.cam.y) / this.cam.s;
    let best: string | null = null;
    let bestD = Infinity;
    for (const i of this.grid.query(wx - reach, wy - reach, wx + reach, wy + reach)) {
      const n = this.scene.nodes[i] as SceneNode;
      const sx = this.cam.x + this.cam.s * n.x;
      const sy = this.cam.y + this.cam.s * n.y;
      const d = Math.hypot(sx - x, sy - y);
      if (d <= screenRadius(n.size, n.tone === "topic", zoom) + slop && d < bestD) {
        bestD = d;
        best = n.key;
      }
    }
    return best;
  }

  nearest(x: number, y: number): string | null {
    const view = visibleWorld(this.cam, this.width, this.height, 0);
    const onScreen = (i: number) => {
      const n = this.scene.nodes[i] as SceneNode;
      return n.x >= view.minX && n.x <= view.maxX && n.y >= view.minY && n.y <= view.maxY;
    };
    const i = this.grid.nearest(
      (x - this.cam.x) / this.cam.s,
      (y - this.cam.y) / this.cam.s,
      onScreen,
    );
    return i < 0 ? null : (this.scene.nodes[i] as SceneNode).key;
  }

  get lastDrawMs(): number {
    return this.drawMs;
  }

  refreshStyle(): void {
    let style: CSSStyleDeclaration | null = null;
    try {
      style = getComputedStyle(this.canvas);
    } catch {
      style = null;
    }
    const read = (name: string, fallback: string) =>
      style?.getPropertyValue(name).trim() || fallback;
    const tones = { ...FALLBACK.tones };
    for (const tone of TONES) tones[tone] = read(TONE_VARS[tone], FALLBACK.tones[tone]);
    this.palette = {
      tones,
      edge: read("--graph-edge", FALLBACK.edge),
      edgeStrong: read("--graph-edge-strong", FALLBACK.edgeStrong),
      suggested: read("--graph-suggested", FALLBACK.suggested),
    };
    this.schedule();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.finishAnimation();
    this.listeners.clear();
  }

  // --- internals ---

  private moveCamera(camera: Camera): void {
    this.cam = { ...camera };
    for (const listener of this.listeners) listener(this.camera);
    this.schedule();
  }

  /** Resolve the running animation where it stands (a newer move takes over). */
  private finishAnimation(): void {
    const anim = this.animation;
    this.animation = null;
    anim?.resolve();
  }

  private schedule(): void {
    if (this.destroyed || this.frame !== null) return;
    this.frame = requestAnimationFrame(this.onFrame);
  }

  private readonly onFrame = (): void => {
    this.frame = null;
    const anim = this.animation;
    if (anim) {
      const p = Math.min(1, (now() - anim.start) / anim.duration);
      const e = cameraEase(p);
      const lerp = (a: number, b: number) => a + (b - a) * e;
      this.cam = {
        x: lerp(anim.from.x, anim.to.x),
        y: lerp(anim.from.y, anim.to.y),
        s: lerp(anim.from.s, anim.to.s),
      };
      for (const listener of this.listeners) listener(this.camera);
      if (p >= 1) this.finishAnimation();
      else this.schedule();
    }
    this.draw();
  };

  /** The camera scale over the whole-area scale, which drives the dot sizes. */
  private zoomRatio(): number {
    const given = this.options.fitScale?.();
    if (given && given > 0) return this.cam.s / given;
    if (!this.bounds || this.width <= 0 || this.height <= 0) return 1;
    const fit = fitCamera(this.bounds, { width: this.width, height: this.height });
    return this.cam.s / fit.s;
  }

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const started = now();
    const { nodes, edges } = this.scene;
    const { focusKey, hoverKey, lit } = this.emphasis;
    const c = this.cam;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    const view = visibleWorld(c, this.width, this.height, CULL_MARGIN);
    const inView = (n: SceneNode) =>
      n.x >= view.minX && n.x <= view.maxX && n.y >= view.minY && n.y <= view.maxY;
    const isLit = (n: SceneNode) => !lit || lit.has(n.key);
    const zoom = this.zoomRatio();

    // Links: sorted into one path per style, so the whole set costs a few strokes.
    const { rest, strong, suggested, dimmed, dimmedSuggested } = this.edgeBatches;
    rest.reset();
    strong.reset();
    suggested.reset();
    dimmed.reset();
    dimmedSuggested.reset();
    let visibleEdges = 0;
    for (const edge of edges) {
      const a = nodes[edge.a];
      const b = nodes[edge.b];
      if (!a || !b || !segmentInBox(a, b, view)) continue;
      visibleEdges += 1;
      const touchesActive =
        a.key === focusKey || b.key === focusKey || a.key === hoverKey || b.key === hoverKey;
      // Dimming wins over style: a dimmed suggested link stays dashed but fades with the rest.
      const dim = !touchesActive && lit !== null && !(isLit(a) || isLit(b));
      const target = dim
        ? edge.suggested
          ? dimmedSuggested
          : dimmed
        : edge.suggested
          ? suggested
          : touchesActive
            ? strong
            : rest;
      target.segment(c.x + c.s * a.x, c.y + c.s * a.y, c.x + c.s * b.x, c.y + c.s * b.y);
    }
    // The rest alpha depends on the count, but only the stroke needs it, so tracing goes first.
    const restAlpha = edgeAlpha(visibleEdges);
    ctx.lineWidth = 1;
    dimmed.stroke(ctx, this.palette.edge, restAlpha * DIM_ALPHA);
    rest.stroke(ctx, this.palette.edge, restAlpha);
    ctx.setLineDash([4, 3]);
    suggested.stroke(ctx, this.palette.suggested, 0.8);
    dimmedSuggested.stroke(ctx, this.palette.suggested, 0.8 * DIM_ALPHA);
    ctx.setLineDash([]);
    ctx.lineWidth = 1.5;
    strong.stroke(ctx, this.palette.edgeStrong, 0.75);

    // Notes: one path per tone and strength (full, legacy, dimmed); topics are rings.
    const groups = this.nodeBatches;
    for (const batch of groups) batch.reset();
    const ring = this.ringBatch;
    ring.reset();
    let hoverRing = false;
    let focusRing = false;
    let focusX = 0;
    let focusY = 0;
    let focusR = 0;
    for (const n of nodes) {
      if (!inView(n)) continue;
      const strength = !isLit(n) ? DIMMED : n.legacy ? LEGACY : FULL;
      const group = groups[TONES.indexOf(n.tone) * 3 + strength] as PathBatch;
      const x = c.x + c.s * n.x;
      const y = c.y + c.s * n.y;
      const r = screenRadius(n.size, n.tone === "topic", zoom);
      group.circle(x, y, r);
      // Hover and focus each get a ring, whatever their order in the scene.
      if (n.key === hoverKey) {
        ring.circle(x, y, r + 3);
        hoverRing = true;
      } else if (n.key === focusKey) {
        focusRing = true;
        focusX = x;
        focusY = y;
        focusR = r;
      }
    }
    for (let i = 0; i < groups.length; i += 1) {
      const path = groups[i] as PathBatch;
      const tone = TONES[Math.floor(i / 3)] as Tone;
      const alpha = STRENGTH_ALPHA[i % 3] as number;
      if (tone === "topic") {
        ctx.lineWidth = 1.5;
        path.stroke(ctx, this.palette.tones.topic, alpha);
      } else {
        path.fill(ctx, this.palette.tones[tone], alpha);
      }
    }
    if (focusRing) ring.circle(focusX, focusY, focusR + 3);
    if (hoverRing || focusRing) {
      ctx.lineWidth = 1.5;
      ring.stroke(ctx, this.palette.edgeStrong, 1);
    }
    ctx.globalAlpha = 1;
    this.drawMs = now() - started;
  }
}

/** A batch of subpaths drawn with one fill or stroke. Built on the context's own path so a
 * WebGL layer can later replace this one class. It reuses one growing buffer across frames
 * (5 numbers per op: kind, then 4 values). Empty batches cost nothing. */
class PathBatch {
  private ops = new Float64Array(5 * 256);
  private length = 0;

  reset(): void {
    this.length = 0;
  }

  segment(x1: number, y1: number, x2: number, y2: number): void {
    this.push(0, x1, y1, x2, y2);
  }

  circle(x: number, y: number, r: number): void {
    this.push(1, x, y, r, 0);
  }

  private push(kind: number, a: number, b: number, p: number, q: number): void {
    if (this.length + 5 > this.ops.length) {
      const grown = new Float64Array(this.ops.length * 2);
      grown.set(this.ops);
      this.ops = grown;
    }
    const o = this.ops;
    const i = this.length;
    o[i] = kind;
    o[i + 1] = a;
    o[i + 2] = b;
    o[i + 3] = p;
    o[i + 4] = q;
    this.length = i + 5;
  }

  private trace(ctx: CanvasRenderingContext2D): boolean {
    if (this.length === 0) return false;
    const o = this.ops;
    ctx.beginPath();
    for (let i = 0; i < this.length; i += 5) {
      const x = o[i + 1] as number;
      const y = o[i + 2] as number;
      const p = o[i + 3] as number;
      if (o[i] === 0) {
        ctx.moveTo(x, y);
        ctx.lineTo(p, o[i + 4] as number);
      } else {
        ctx.moveTo(x + p, y);
        ctx.arc(x, y, p, 0, Math.PI * 2);
      }
    }
    return true;
  }

  fill(ctx: CanvasRenderingContext2D, colour: string, alpha: number): void {
    if (!this.trace(ctx)) return;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = colour;
    ctx.fill();
  }

  stroke(ctx: CanvasRenderingContext2D, colour: string, alpha: number): void {
    if (!this.trace(ctx)) return;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = colour;
    ctx.stroke();
  }
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function boundsOf(nodes: readonly SceneNode[]): Bounds | null {
  if (nodes.length === 0) return null;
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const n of nodes) {
    b.minX = Math.min(b.minX, n.x);
    b.minY = Math.min(b.minY, n.y);
    b.maxX = Math.max(b.maxX, n.x);
    b.maxY = Math.max(b.maxY, n.y);
  }
  return b;
}

/** A cheap box test: a link is drawn unless both ends sit past the same side of the view. */
function segmentInBox(
  a: SceneNode,
  b: SceneNode,
  box: { minX: number; minY: number; maxX: number; maxY: number },
): boolean {
  if (a.x < box.minX && b.x < box.minX) return false;
  if (a.x > box.maxX && b.x > box.maxX) return false;
  if (a.y < box.minY && b.y < box.minY) return false;
  if (a.y > box.maxY && b.y > box.maxY) return false;
  return true;
}

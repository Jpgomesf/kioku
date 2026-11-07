// The graph's 2D canvas renderer. It draws only what is on screen, only when something
// changed (one requestAnimationFrame per change), and animates the camera itself so React
// never re-renders per frame. It knows nothing of React or the API: the page hands it a Scene.
import { type Camera, fitCamera } from "./camera";
import type { Bounds } from "./layout";
import {
  ARROW_MIN_LENGTH,
  cameraEase,
  edgeAlpha,
  labelAlpha,
  SpatialGrid,
  screenRadius,
  shortLabel,
  visibleWorld,
} from "./renderer-math";
import type { DisplayOptions, Emphasis, Scene, SceneNode } from "./scene";

export interface RendererOptions {
  reducedMotion: () => boolean;
  /** The page's whole-area camera scale (the one it passes to levelFor), so dot sizes follow the
   * page's zoom levels. Without it the renderer fits the scene's own bounds, which shift when a
   * type is hidden. */
  fitScale?: () => number;
}

type Listener = (camera: Camera) => void;

interface Palette {
  edge: string;
  edgeStrong: string;
  suggested: string;
  /** The canvas background, used as the label halo. */
  background: string;
  label: string;
  font: string;
}

/** Colours used when a custom property is missing (tests, a stylesheet not loaded yet). */
const FALLBACK: Palette = {
  edge: "#6f7078",
  edgeStrong: "#2944b8",
  suggested: "#2944b8",
  background: "#ffffff",
  label: "#55565e",
  font: "system-ui, sans-serif",
};

const DEFAULT_DISPLAY: DisplayOptions = {
  nodeSize: 1,
  linkThickness: 1,
  arrows: false,
  textFade: 0,
};
/** Labels drawn per frame at most, biggest notes first, so a dense view stays fast and legible. */
const LABEL_CAP = 300;
/** The pick grid is rebuilt at most this often while positions stream in. */
const GRID_REFRESH_MS = 200;

/** One colour's batches for each strength; topics (rings) and dots kept apart. */
interface ColourBatches {
  color: string;
  topic: boolean;
  paths: [PathBatch, PathBatch, PathBatch];
}

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
  /** Positions moved since the grid and bounds were built. */
  private gridStale = false;
  private gridBuiltAt = 0;
  private display: DisplayOptions = DEFAULT_DISPLAY;
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
  // Arrowheads, one batch per link style, filled in the link's colour.
  private readonly arrowBatches = {
    rest: new PathBatch(),
    strong: new PathBatch(),
    suggested: new PathBatch(),
    dimmed: new PathBatch(),
    dimmedSuggested: new PathBatch(),
  };
  // One entry per distinct colour (and ring or dot), built with the scene; batchOf maps each
  // note to its entry, so a frame does no string work per note and paths grow with colours.
  private colourBatches: ColourBatches[] = [];
  private batchOf = new Int32Array(0);
  private readonly ringBatch = new PathBatch();
  private labelOrder: number[] = [];
  // Shortened titles, aligned with scene.nodes, so long titles never form a wall of text.
  private labels: string[] = [];
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
    // Copy the notes: setPositions moves them in place, and the page's objects stay untouched.
    this.scene = { nodes: scene.nodes.map((n) => ({ ...n })), edges: scene.edges };
    this.labels = this.scene.nodes.map((n) => shortLabel(n.label));
    this.indexColours();
    this.rebuildGrid();
    this.schedule();
  }

  /** Move notes (aligned with the scene's nodes) without rebuilding the scene. Redraws once per
   * frame however often it is called; the pick grid catches up lazily. */
  setPositions(xs: Float64Array, ys: Float64Array): void {
    const nodes = this.scene.nodes;
    const n = Math.min(nodes.length, xs.length, ys.length);
    for (let i = 0; i < n; i += 1) {
      const node = nodes[i] as SceneNode;
      node.x = xs[i] as number;
      node.y = ys[i] as number;
    }
    this.gridStale = true;
    this.schedule();
  }

  setDisplay(options: DisplayOptions): void {
    this.display = { ...options };
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
    this.freshGrid();
    const zoom = this.zoomRatio();
    // The largest drawn radius (a capped topic ring) bounds the search box.
    const reach =
      (screenRadius(Infinity, true, Infinity) * this.display.nodeSize + slop) / this.cam.s;
    const wx = (x - this.cam.x) / this.cam.s;
    const wy = (y - this.cam.y) / this.cam.s;
    let best: string | null = null;
    let bestD = Infinity;
    for (const i of this.grid.query(wx - reach, wy - reach, wx + reach, wy + reach)) {
      const n = this.scene.nodes[i] as SceneNode;
      const sx = this.cam.x + this.cam.s * n.x;
      const sy = this.cam.y + this.cam.s * n.y;
      const d = Math.hypot(sx - x, sy - y);
      if (d <= this.radius(n, zoom) + slop && d < bestD) {
        bestD = d;
        best = n.key;
      }
    }
    return best;
  }

  nearest(x: number, y: number): string | null {
    this.freshGrid();
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
    this.palette = {
      edge: read("--graph-edge", FALLBACK.edge),
      edgeStrong: read("--graph-edge-strong", FALLBACK.edgeStrong),
      suggested: read("--graph-suggested", FALLBACK.suggested),
      background: read("--bg", FALLBACK.background),
      label: read("--fg-2", FALLBACK.label),
      font: read("--font-sans", FALLBACK.font),
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

  private indexColours(): void {
    const index = new Map<string, number>();
    const batches: ColourBatches[] = [];
    const batchOf = new Int32Array(this.scene.nodes.length);
    this.scene.nodes.forEach((n, i) => {
      const id = `${n.topic ? "r" : "f"}${n.color}`;
      let b = index.get(id);
      if (b === undefined) {
        b = batches.length;
        index.set(id, b);
        // Reuse earlier PathBatch buffers when the scene changes.
        const old = this.colourBatches[b];
        batches.push({
          color: n.color,
          topic: n.topic,
          paths: old ? old.paths : [new PathBatch(), new PathBatch(), new PathBatch()],
        });
      }
      batchOf[i] = b;
    });
    this.colourBatches = batches;
    this.batchOf = batchOf;
  }

  private rebuildGrid(): void {
    this.grid = new SpatialGrid(this.scene.nodes);
    this.bounds = boundsOf(this.scene.nodes);
    this.gridStale = false;
    this.gridBuiltAt = now();
  }

  /** Before a pick: the grid must match what is drawn. */
  private freshGrid(): void {
    if (this.gridStale) this.rebuildGrid();
  }

  private radius(n: SceneNode, zoom: number): number {
    return screenRadius(n.size, n.topic, zoom) * this.display.nodeSize;
  }

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
    if (this.gridStale && started - this.gridBuiltAt >= GRID_REFRESH_MS) this.rebuildGrid();
    const display = this.display;
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
    const arrows = this.arrowBatches;
    for (const batch of Object.values(arrows)) batch.reset();
    const arrowLength = 6 * Math.max(0.6, Math.sqrt(display.linkThickness));
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
      const style = dim
        ? edge.suggested
          ? "dimmedSuggested"
          : "dimmed"
        : edge.suggested
          ? "suggested"
          : touchesActive
            ? "strong"
            : "rest";
      const ax = c.x + c.s * a.x;
      const ay = c.y + c.s * a.y;
      const bx = c.x + c.s * b.x;
      const by = c.y + c.s * b.y;
      this.edgeBatches[style].segment(ax, ay, bx, by);
      if (display.arrows) {
        // The tip sits on the target dot's edge; skip links too short to carry a readable head.
        const len = Math.hypot(bx - ax, by - ay);
        const back = this.radius(b, zoom);
        if (len - back >= ARROW_MIN_LENGTH) {
          const ux = (bx - ax) / len;
          const uy = (by - ay) / len;
          arrows[style].arrow(bx - ux * back, by - uy * back, ux * arrowLength, uy * arrowLength);
        }
      }
    }
    // The rest alpha depends on the count, but only the stroke needs it, so tracing goes first.
    const restAlpha = edgeAlpha(visibleEdges);
    const thick = display.linkThickness;
    const p = this.palette;
    ctx.lineWidth = thick;
    dimmed.stroke(ctx, p.edge, restAlpha * DIM_ALPHA);
    rest.stroke(ctx, p.edge, restAlpha);
    ctx.setLineDash([4, 3]);
    suggested.stroke(ctx, p.suggested, 0.8);
    dimmedSuggested.stroke(ctx, p.suggested, 0.8 * DIM_ALPHA);
    ctx.setLineDash([]);
    ctx.lineWidth = 1.5 * thick;
    strong.stroke(ctx, p.edgeStrong, 0.75);
    // Heads read better a little stronger than their faint lines.
    arrows.dimmed.fill(ctx, p.edge, Math.min(1, restAlpha * 2) * DIM_ALPHA);
    arrows.rest.fill(ctx, p.edge, Math.min(1, restAlpha * 2));
    arrows.suggested.fill(ctx, p.suggested, 0.8);
    arrows.dimmedSuggested.fill(ctx, p.suggested, 0.8 * DIM_ALPHA);
    arrows.strong.fill(ctx, p.edgeStrong, 0.75);

    // Notes: one path per colour and strength (full, legacy, dimmed); topics are rings.
    const groups = this.colourBatches;
    for (const group of groups) for (const path of group.paths) path.reset();
    const batchOf = this.batchOf;
    const labels = labelAlpha(zoom, display.textFade);
    const labelOrder = this.labelOrder;
    labelOrder.length = 0;
    const ring = this.ringBatch;
    ring.reset();
    let hoverRing = false;
    let focusRing = false;
    let focusX = 0;
    let focusY = 0;
    let focusR = 0;
    for (let i = 0; i < nodes.length; i += 1) {
      const n = nodes[i] as SceneNode;
      if (!inView(n)) continue;
      const strength = !isLit(n) ? DIMMED : n.legacy ? LEGACY : FULL;
      const group = groups[batchOf[i] as number] as ColourBatches;
      const x = c.x + c.s * n.x;
      const y = c.y + c.s * n.y;
      const r = this.radius(n, zoom);
      group.paths[strength].circle(x, y, r);
      if (labels > 0 && !n.topic && n.label) labelOrder.push(i);
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
    for (const group of groups) {
      for (let s = 0; s < 3; s += 1) {
        const path = group.paths[s] as PathBatch;
        const alpha = STRENGTH_ALPHA[s] as number;
        if (group.topic) {
          ctx.lineWidth = 1.5;
          path.stroke(ctx, group.color, alpha);
        } else {
          path.fill(ctx, group.color, alpha);
        }
      }
    }
    if (focusRing) ring.circle(focusX, focusY, focusR + 3);
    if (hoverRing || focusRing) {
      ctx.lineWidth = 1.5;
      ring.stroke(ctx, this.palette.edgeStrong, 1);
    }
    if (labelOrder.length > 0) this.drawLabels(ctx, labelOrder, labels, zoom);
    ctx.globalAlpha = 1;
    this.drawMs = now() - started;
  }

  /** Titles under their dots, biggest notes first, capped, with a halo so links don't cut them. */
  private drawLabels(
    ctx: CanvasRenderingContext2D,
    order: number[],
    alpha: number,
    zoom: number,
  ): void {
    const { nodes } = this.scene;
    const { lit } = this.emphasis;
    const c = this.cam;
    const p = this.palette;
    order.sort((i, j) => (nodes[j] as SceneNode).size - (nodes[i] as SceneNode).size);
    const count = Math.min(order.length, LABEL_CAP);
    ctx.font = `11px ${p.font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = p.background;
    ctx.fillStyle = p.label;
    for (let k = 0; k < count; k += 1) {
      const n = nodes[order[k] as number] as SceneNode;
      const dim = lit !== null && !lit.has(n.key);
      ctx.globalAlpha = alpha * (dim ? DIM_ALPHA : n.legacy ? LEGACY_ALPHA : 1);
      const x = c.x + c.s * n.x;
      const y = c.y + c.s * n.y + this.radius(n, zoom) + 3;
      const text = this.labels[order[k] as number] as string;
      ctx.strokeText(text, x, y);
      ctx.fillText(text, x, y);
    }
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

  /** A filled triangle with its tip at (x, y), pointing along (dx, dy), which is its length. */
  arrow(x: number, y: number, dx: number, dy: number): void {
    this.push(2, x, y, dx, dy);
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
      const q = o[i + 4] as number;
      if (o[i] === 0) {
        ctx.moveTo(x, y);
        ctx.lineTo(p, q);
      } else if (o[i] === 2) {
        // Base centre is one length back from the tip; half-width is half the length.
        const bx = x - p;
        const by = y - q;
        ctx.moveTo(x, y);
        ctx.lineTo(bx - q * 0.5, by + p * 0.5);
        ctx.lineTo(bx + q * 0.5, by - p * 0.5);
        ctx.lineTo(x, y);
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

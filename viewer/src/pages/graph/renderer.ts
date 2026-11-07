// The graph's 2D canvas renderer. It draws only what is on screen, only when something
// changed (one requestAnimationFrame per change), and animates the camera itself so React
// never re-renders per frame. It knows nothing of React or the API: the page hands it a Scene,
// what to emphasise (the hovered or selected note and the depths around it), the note being
// dragged and, optionally, regions of the graph to name.
import { type Camera, fitCamera } from "./camera";
import type { Bounds } from "./layout";
import {
  ARROW_MIN_LENGTH,
  CALM,
  cameraEase,
  type EmphasisMode,
  FADED,
  LabelBoxes,
  labelAlpha,
  labelOpacity,
  labelRank,
  labelSortIndex,
  labelSortKey,
  linkAlphas,
  linkDensity,
  NOTE_ALPHAS,
  nodeLabel,
  noteStrength,
  RANK_REGION,
  regionLabelAlpha,
  SpatialGrid,
  screenRadius,
  shortLabel,
  TAG_SCALE,
  topicLabelOpacity,
  topicLabelRank,
  visibleWorld,
} from "./renderer-math";
import type { DisplayOptions, Emphasis, Scene, SceneEdge, SceneNode, SceneRegions } from "./scene";

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
  /** Canvas fonts for note labels and region names. */
  labelFont: string;
  regionFont: string;
}

/** Note labels: 12 px text set 3 px under the dot, in a box this tall. */
const LABEL_PX = 12;
const LABEL_OFFSET = 3;
const LABEL_LINE = 14;
/** Region names: larger and semibold, but softer than note labels. */
const REGION_PX = 16;
const REGION_LINE = 20;
const REGION_TEXT_ALPHA = 0.6;
/** Region names soften further while a note or a legend group is emphasised, so it reads first. */
const REGION_EMPHASIS_ALPHA = 0.5;
/** A region needs this many notes on the canvas to be named. */
const REGION_MIN_NOTES = 3;
/** A region name takes clicks only while at least this visible. */
const REGION_PICK_ALPHA = 0.3;
/** Space kept clear around every label, in pixels. */
const LABEL_GAP = 2;

function fonts(family: string): Pick<Palette, "labelFont" | "regionFont"> {
  return { labelFont: `${LABEL_PX}px ${family}`, regionFont: `600 ${REGION_PX}px ${family}` };
}

/** Colours used when a custom property is missing (tests, a stylesheet not loaded yet). */
const FALLBACK: Palette = {
  edge: "#6f7078",
  edgeStrong: "#2944b8",
  suggested: "#2944b8",
  background: "#ffffff",
  label: "#55565e",
  ...fonts("system-ui, sans-serif"),
};

const DEFAULT_DISPLAY: DisplayOptions = {
  nodeSize: 1,
  linkThickness: 1,
  arrows: false,
  textFade: 0,
};
/** Note labels drawn per frame at most, so a dense view stays fast and legible. */
const LABEL_CAP = 300;
/** The pick grid is rebuilt at most this often while positions stream in. */
const GRID_REFRESH_MS = 200;

/** One colour's batches for each strength (NOTE_ALPHAS); topics (rings) and dots kept apart. */
interface ColourBatches {
  color: string;
  topic: boolean;
  paths: PathBatch[];
}

/** Screen margin around the viewport inside which notes and links still draw. */
const CULL_MARGIN = 24;

/** Link styles, in stroke order: faded first, the source's own links last, on top. Suggested
 * links are dashed: faded, a deeper step in the path's neutral, or in the accent. */
const DIM = 0;
const REST = 1;
const PATH = 2;
const DIM_SUGGESTED = 3;
const PATH_SUGGESTED = 4;
const SUGGESTED = 5;
const NEAR = 6;
const STYLES = 7;
const DASH = [4, 3];
const SOLID: number[] = [];
/** The source's own links draw this much thicker, so they stand out without thickening the rest. */
const NEAR_WIDTH = 1.5;
/** Hover and selection rings; the dragged note gets a bolder one, further out. */
const RING_GAP = 3;
const RING_WIDTH = 1.5;
const DRAG_RING_GAP = 4;
const DRAG_RING_WIDTH = 2.5;
/** Depths are stored per note in an Int8Array; deeper ones all draw as the deepest anyway. */
const MAX_DEPTH = 100;

const EMPTY_EMPHASIS: Emphasis = { focusKey: null, hoverKey: null, lit: null, depths: null };

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
  /** Each note's index in scene.nodes, by key. */
  private indexOf = new Map<string, number>();
  private grid = new SpatialGrid([]);
  private bounds: Bounds | null = null;
  /** Positions moved since the grid and bounds were built. */
  private gridStale = false;
  private gridBuiltAt = 0;
  private display: DisplayOptions = DEFAULT_DISPLAY;
  private emphasis: Emphasis = EMPTY_EMPHASIS;
  private dragKey: string | null = null;
  // The emphasis resolved against the scene once per change (resolveEmphasis), so a frame
  // compares indices and reads a typed array instead of looking up keys for every link.
  private emphasisStale = true;
  private mode: EmphasisMode = "calm";
  /** Per note: CALM, FADED or its depth from the source, as renderer-math defines them. */
  private standing = new Int8Array(0);
  private hoverIndex = -1;
  private focusIndex = -1;
  private dragIndex = -1;
  private palette: Palette = FALLBACK;
  private listeners = new Set<Listener>();
  private frame: number | null = null;
  private animation: Animation | null = null;
  private drawMs = 0;
  // Path batches kept across frames so steady-state frames allocate nothing: one per link
  // style, and one per style for the arrowheads, filled in the link's colour.
  private readonly linkBatches = pathBatches(STYLES);
  private readonly arrowBatches = pathBatches(STYLES);
  /** The on-screen length drawn in each link style this frame, for the densities. */
  private readonly styleLength = new Float64Array(STYLES);
  // One entry per distinct colour (and ring or dot), built with the scene; batchOf maps each
  // note to its entry, so a frame does no string work per note and paths grow with colours.
  private colourBatches: ColourBatches[] = [];
  private batchOf = new Int32Array(0);
  private readonly ringBatch = new PathBatch();
  // Shortened titles, aligned with scene.nodes, so long titles never form a wall of text.
  private labels: string[] = [];
  /** Label widths in the label font, aligned with scene.nodes; NaN until first measured. */
  private labelWidths = new Float32Array(0);
  // Per frame, aligned with scene.nodes: each candidate label's opacity and priority.
  private labelAlphas = new Float32Array(0);
  private labelRanks = new Uint8Array(0);
  /** This frame's candidate labels as labelSortKey keys; the first labelCount are in use. */
  private labelKeys = new Float64Array(0);
  private labelCount = 0;
  private readonly boxes = new LabelBoxes();
  /** The note labels placed this frame, in priority order. */
  private readonly placedLabels = new Int32Array(LABEL_CAP);
  private regions: RegionLabels | null = null;
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
    // Widths measured before the web font loads would misplace labels: measure again after.
    fontSet()?.addEventListener("loadingdone", this.onFontsLoaded);
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
    const nodes = scene.nodes.map((n) => ({ ...n }));
    const count = nodes.length;
    this.scene = { nodes, edges: scene.edges };
    this.indexOf = new Map(nodes.map((n, i): [string, number] => [n.key, i]));
    this.labels = nodes.map((n) => nodeLabel(n.label, n.tag));
    this.labelWidths = new Float32Array(count).fill(Number.NaN);
    this.labelAlphas = new Float32Array(count);
    this.labelRanks = new Uint8Array(count);
    this.labelKeys = new Float64Array(count);
    this.standing = new Int8Array(count);
    this.emphasisStale = true;
    this.indexColours();
    // Each note keeps its region by key until the page passes regions for this scene.
    this.regions?.align(nodes);
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
    this.emphasisStale = true;
    this.schedule();
  }

  /** The note the viewer is dragging, ringed boldly; null when none is. */
  setDragging(key: string | null): void {
    if (key === this.dragKey) return;
    this.dragKey = key;
    this.emphasisStale = true;
    this.schedule();
  }

  /** Regions to name on the canvas, or null for none. `assign` is aligned with the scene last
   * passed to setScene, so the page maps its regions onto that scene by key and passes them
   * right after setScene; then the order scenes and regions arrive in never matters. Regions
   * of another length are ignored, leaving what is drawn as it was, since the renderer cannot
   * tell which scene they were for. Later scenes (filters, Animate) keep each note's region by
   * key until the next call. */
  setRegions(regions: SceneRegions | null): void {
    if (regions && regions.assign.length !== this.scene.nodes.length) return;
    this.regions = regions ? RegionLabels.from(regions, this.scene.nodes) : null;
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
    const onScreen = (i: number) => inBox(this.scene.nodes[i] as SceneNode, view);
    const i = this.grid.nearest(
      (x - this.cam.x) / this.cam.s,
      (y - this.cam.y) / this.cam.s,
      onScreen,
    );
    return i < 0 ? null : (this.scene.nodes[i] as SceneNode).key;
  }

  /** The region whose name the last frame drew under a screen point, or null. Names that have
   * mostly faded out with the zoom take no clicks. */
  pickRegion(x: number, y: number): number | null {
    const regions = this.regions;
    if (!regions) return null;
    const h = regions.hits;
    for (let k = 0; k < regions.hitCount; k += 1) {
      const o = 4 * k;
      const inside =
        x >= (h[o] as number) &&
        y >= (h[o + 1] as number) &&
        x <= (h[o + 2] as number) &&
        y <= (h[o + 3] as number);
      if (inside) return regions.hitIds[k] as number;
    }
    return null;
  }

  /** The world box of a region's notes where they are now, or null when it has none. */
  regionBounds(region: number): Bounds | null {
    const regions = this.regions;
    if (!regions) return null;
    const nodes = this.scene.nodes;
    let box: Bounds | null = null;
    for (let i = 0; i < regions.of.length; i += 1) {
      if (regions.of[i] !== region) continue;
      const n = nodes[i] as SceneNode;
      if (!box) {
        box = { minX: n.x, minY: n.y, maxX: n.x, maxY: n.y };
        continue;
      }
      box.minX = Math.min(box.minX, n.x);
      box.minY = Math.min(box.minY, n.y);
      box.maxX = Math.max(box.maxX, n.x);
      box.maxY = Math.max(box.maxY, n.y);
    }
    return box;
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
      ...fonts(read("--font-sans", "system-ui, sans-serif")),
    };
    this.forgetWidths();
    this.schedule();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.finishAnimation();
    this.listeners.clear();
    fontSet()?.removeEventListener("loadingdone", this.onFontsLoaded);
  }

  // --- internals ---

  private readonly onFontsLoaded = (): void => {
    this.forgetWidths();
    this.schedule();
  };

  private forgetWidths(): void {
    this.labelWidths.fill(Number.NaN);
    this.regions?.widths.fill(Number.NaN);
  }

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
          paths: old ? old.paths : pathBatches(NOTE_ALPHAS.length),
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
    const r = screenRadius(n.size, n.topic, zoom) * this.display.nodeSize;
    return n.tag ? r * TAG_SCALE : r;
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

  /** Resolves the emphasis against the scene: the mode, each note's standing and the indices
   * of the hovered, selected and dragged notes. */
  private resolveEmphasis(): void {
    const { focusKey, hoverKey, lit, depths } = this.emphasis;
    const standing = this.standing;
    const at = this.indexOf;
    if (depths) {
      this.mode = "depth";
      standing.fill(FADED);
      depths.forEach((depth, key) => {
        const i = at.get(key);
        if (i !== undefined && depth >= 0) standing[i] = Math.min(MAX_DEPTH, Math.floor(depth));
      });
    } else if (lit) {
      this.mode = "lit";
      standing.fill(FADED);
      lit.forEach((key) => {
        const i = at.get(key);
        if (i !== undefined) standing[i] = 1;
      });
    } else {
      this.mode = "calm";
      standing.fill(CALM);
    }
    this.hoverIndex = indexIn(at, hoverKey);
    this.focusIndex = indexIn(at, focusKey);
    this.dragIndex = indexIn(at, this.dragKey);
    this.emphasisStale = false;
  }

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const started = now();
    if (this.gridStale && started - this.gridBuiltAt >= GRID_REFRESH_MS) this.rebuildGrid();
    if (this.emphasisStale) this.resolveEmphasis();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    const view = visibleWorld(this.cam, this.width, this.height, CULL_MARGIN);
    const zoom = this.zoomRatio();
    this.drawLinks(ctx, view, zoom);
    this.drawNotes(ctx, view, zoom);
    this.drawRings(ctx, view, zoom);
    this.drawLabels(ctx, zoom);
    ctx.globalAlpha = 1;
    this.drawMs = now() - started;
  }

  /** Links, sorted into one path per style so the whole set costs a few strokes. Each style's
   * alpha follows how much of the screen its links cover (linkAlphas). */
  private drawLinks(ctx: CanvasRenderingContext2D, view: Bounds, zoom: number): void {
    const { nodes, edges } = this.scene;
    const c = this.cam;
    const display = this.display;
    const lines = this.linkBatches;
    const heads = this.arrowBatches;
    const lengths = this.styleLength;
    for (let s = 0; s < STYLES; s += 1) {
      (lines[s] as PathBatch).reset();
      (heads[s] as PathBatch).reset();
      lengths[s] = 0;
    }
    const depthMode = this.mode === "depth";
    const litMode = this.mode === "lit";
    const standing = this.standing;
    const hover = this.hoverIndex;
    const focus = this.focusIndex;
    const arrowLength = 6 * Math.max(0.6, Math.sqrt(display.linkThickness));
    // For the densities, a link counts at most once across the screen, however long it is.
    const longest = Math.hypot(this.width, this.height);
    for (const edge of edges) {
      const a = nodes[edge.a];
      const b = nodes[edge.b];
      if (!a || !b || !segmentInBox(a, b, view)) continue;
      const style = depthMode
        ? depthStyle(edge, standing)
        : calmStyle(edge, standing, litMode, hover, focus);
      const ax = c.x + c.s * a.x;
      const ay = c.y + c.s * a.y;
      const bx = c.x + c.s * b.x;
      const by = c.y + c.s * b.y;
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.sqrt(dx * dx + dy * dy);
      lengths[style] = (lengths[style] as number) + Math.min(len, longest);
      (lines[style] as PathBatch).segment(ax, ay, bx, by);
      if (display.arrows) {
        // The tip sits on the target dot's edge; skip links too short to carry a readable head.
        const back = this.radius(b, zoom);
        if (len - back >= ARROW_MIN_LENGTH) {
          const ux = dx / len;
          const uy = dy / len;
          const tipX = bx - ux * back;
          const tipY = by - uy * back;
          (heads[style] as PathBatch).arrow(tipX, tipY, ux * arrowLength, uy * arrowLength);
        }
      }
    }
    let total = 0;
    for (let s = 0; s < STYLES; s += 1) total += lengths[s] as number;
    const density = (length: number) => linkDensity(length, this.width, this.height);
    const alpha = linkAlphas(this.mode, {
      all: density(total),
      near: density(lengths[NEAR] as number),
      // Dashed deeper steps draw at the path's alpha, so they count towards its density.
      path: density((lengths[PATH] as number) + (lengths[PATH_SUGGESTED] as number)),
      suggested: density(lengths[SUGGESTED] as number),
    });
    const p = this.palette;
    const line = (s: number) => lines[s] as PathBatch;
    const head = (s: number) => heads[s] as PathBatch;
    const thick = display.linkThickness;
    ctx.lineWidth = thick;
    line(DIM).stroke(ctx, p.edge, alpha.dim);
    line(REST).stroke(ctx, p.edge, alpha.rest);
    line(PATH).stroke(ctx, p.edge, alpha.path);
    ctx.setLineDash(DASH);
    line(DIM_SUGGESTED).stroke(ctx, p.suggested, alpha.dimSuggested);
    line(PATH_SUGGESTED).stroke(ctx, p.edge, alpha.path);
    line(SUGGESTED).stroke(ctx, p.suggested, alpha.suggested);
    ctx.setLineDash(SOLID);
    ctx.lineWidth = NEAR_WIDTH * thick;
    line(NEAR).stroke(ctx, p.edgeStrong, alpha.near);
    // Heads read better a little stronger than their faint lines.
    head(DIM).fill(ctx, p.edge, Math.min(1, alpha.dim * 2));
    head(REST).fill(ctx, p.edge, Math.min(1, alpha.rest * 2));
    head(PATH).fill(ctx, p.edge, Math.min(1, alpha.path * 2));
    head(DIM_SUGGESTED).fill(ctx, p.suggested, alpha.dimSuggested);
    head(PATH_SUGGESTED).fill(ctx, p.edge, Math.min(1, alpha.path * 2));
    head(SUGGESTED).fill(ctx, p.suggested, alpha.suggested);
    head(NEAR).fill(ctx, p.edgeStrong, alpha.near);
  }

  /** Notes: one path per colour and strength, drawn dimmest first so emphasised notes sit on
   * top; topics are rings. Collects this frame's label candidates on the way. */
  private drawNotes(ctx: CanvasRenderingContext2D, view: Bounds, zoom: number): void {
    const nodes = this.scene.nodes;
    const c = this.cam;
    const groups = this.colourBatches;
    for (const group of groups) for (const path of group.paths) path.reset();
    const standing = this.standing;
    const batchOf = this.batchOf;
    const zoomAlpha = labelAlpha(zoom, this.display.textFade);
    // Topic labels on: every topic is named at any zoom, in the same placement as the other
    // labels, so none piles on a region name or a note label. Off: only an active topic is.
    const topicLabels = this.display.topicLabels !== false;
    let candidates = 0;
    for (let i = 0; i < nodes.length; i += 1) {
      const n = nodes[i] as SceneNode;
      if (!inBox(n, view)) continue;
      const s = standing[i] as number;
      const source = i === this.hoverIndex || i === this.dragIndex;
      const selected = i === this.focusIndex;
      const active = source || selected;
      // The selection keeps full strength while the depths around another note fade the rest.
      const strength = noteStrength(active && s === FADED ? CALM : s, n.legacy);
      const group = groups[batchOf[i] as number] as ColourBatches;
      const r = this.radius(n, zoom);
      (group.paths[strength] as PathBatch).circle(c.x + c.s * n.x, c.y + c.s * n.y, r);
      if (!n.label) continue;
      let a: number;
      let rank: number;
      if (n.topic && topicLabels) {
        a = topicLabelOpacity(active, s, n.legacy);
        rank = topicLabelRank(s, source, selected);
      } else {
        if (n.topic && !active) continue;
        // Below the fade threshold only emphasised notes are named, so skip the rest early.
        if (zoomAlpha === 0 && !active && s < 0) continue;
        a = labelOpacity(zoomAlpha, active, s, n.legacy);
        rank = labelRank(s, source, selected);
      }
      if (a <= 0) continue;
      this.labelAlphas[i] = a;
      this.labelRanks[i] = rank;
      this.labelKeys[candidates] = labelSortKey(rank, n.size, i);
      candidates += 1;
    }
    this.labelCount = candidates;
    for (let s = 0; s < NOTE_ALPHAS.length; s += 1) {
      const alpha = NOTE_ALPHAS[s] as number;
      for (const group of groups) {
        const path = group.paths[s] as PathBatch;
        if (group.topic) {
          ctx.lineWidth = 1.5;
          path.stroke(ctx, group.color, alpha);
        } else {
          path.fill(ctx, group.color, alpha);
        }
      }
    }
  }

  /** Hover and selection each get a ring, whatever their order in the scene; the dragged note
   * gets a bolder one in place of its hover ring. */
  private drawRings(ctx: CanvasRenderingContext2D, view: Bounds, zoom: number): void {
    const ring = this.ringBatch;
    const hover = this.hoverIndex;
    const focus = this.focusIndex;
    const drag = this.dragIndex;
    ring.reset();
    if (hover !== drag) this.addRing(hover, RING_GAP, view, zoom);
    if (focus !== hover && focus !== drag) this.addRing(focus, RING_GAP, view, zoom);
    ctx.lineWidth = RING_WIDTH;
    ring.stroke(ctx, this.palette.edgeStrong, 1);
    if (drag < 0) return;
    ring.reset();
    this.addRing(drag, DRAG_RING_GAP, view, zoom);
    ctx.lineWidth = DRAG_RING_WIDTH;
    ring.stroke(ctx, this.palette.edgeStrong, 1);
  }

  private addRing(index: number, gap: number, view: Bounds, zoom: number): void {
    const n = this.scene.nodes[index];
    if (!n || !inBox(n, view)) return;
    const c = this.cam;
    this.ringBatch.circle(c.x + c.s * n.x, c.y + c.s * n.y, this.radius(n, zoom) + gap);
  }

  /** Note titles under their dots and region names on their centroids, placed greedily by
   * priority (labelRank) so no label overlaps another, then drawn with a halo so links don't
   * cut them. At most LABEL_CAP note labels. */
  private drawLabels(ctx: CanvasRenderingContext2D, zoom: number): void {
    const regions = this.regions;
    if (regions) {
      regions.placedCount = 0;
      regions.hitCount = 0;
    }
    const fade = regions ? regionLabelAlpha(zoom) : 0;
    const named = fade > 0 ? regions : null;
    if (this.labelCount === 0 && !named) return;
    const p = this.palette;
    if (named) {
      ctx.font = p.regionFont;
      measureRegions(ctx, named);
      named.sum(this.scene.nodes);
    }
    // Ascending keys run from the highest priority down; sorting a typed array in place
    // without a comparator allocates nothing.
    const keys = this.labelKeys.subarray(0, this.labelCount).sort();
    const nodes = this.scene.nodes;
    const c = this.cam;
    const boxes = this.boxes;
    boxes.reset();
    ctx.font = p.labelFont;
    let placed = 0;
    let regionsPlaced = !named;
    for (let k = 0; k < keys.length && placed < LABEL_CAP; k += 1) {
      const i = labelSortIndex(keys[k] as number);
      if (named && !regionsPlaced && (this.labelRanks[i] as number) < RANK_REGION) {
        this.placeRegions(named, fade);
        regionsPlaced = true;
      }
      const n = nodes[i] as SceneNode;
      const half = this.labelWidth(ctx, i) / 2 + LABEL_GAP;
      const x = c.x + c.s * n.x;
      const y = c.y + c.s * n.y + this.radius(n, zoom) + LABEL_OFFSET;
      if (!boxes.place(x - half, y - LABEL_GAP, x + half, y + LABEL_LINE + LABEL_GAP)) continue;
      this.placedLabels[placed] = i;
      placed += 1;
    }
    if (named && !regionsPlaced) this.placeRegions(named, fade);
    if (named && named.placedCount > 0) this.drawRegionNames(ctx, named, fade);
    if (placed > 0) this.drawNoteLabels(ctx, placed, zoom);
  }

  /** Offers each named region's name, biggest region first, centred on its notes' centroid. */
  private placeRegions(regions: RegionLabels, fade: number): void {
    const c = this.cam;
    const pickable = fade >= REGION_PICK_ALPHA;
    for (const r of regions.order) {
      const count = regions.total[r] as number;
      const x = c.x + (c.s * (regions.sumX[r] as number)) / count;
      const y = c.y + (c.s * (regions.sumY[r] as number)) / count;
      const half = (regions.widths[r] as number) / 2 + LABEL_GAP;
      const x0 = x - half;
      const y0 = y - REGION_LINE / 2 - LABEL_GAP;
      const x1 = x + half;
      const y1 = y + REGION_LINE / 2 + LABEL_GAP;
      // Off screen there is nothing to draw or click.
      if (x1 < 0 || y1 < 0 || x0 > this.width || y0 > this.height) continue;
      if (!this.boxes.place(x0, y0, x1, y1)) continue;
      const m = regions.placedCount;
      regions.placed[m] = r;
      regions.placedX[m] = x;
      regions.placedY[m] = y;
      regions.placedCount = m + 1;
      if (!pickable) continue;
      const h = 4 * regions.hitCount;
      regions.hits[h] = x0;
      regions.hits[h + 1] = y0;
      regions.hits[h + 2] = x1;
      regions.hits[h + 3] = y1;
      regions.hitIds[regions.hitCount] = r;
      regions.hitCount += 1;
    }
  }

  private drawRegionNames(
    ctx: CanvasRenderingContext2D,
    regions: RegionLabels,
    fade: number,
  ): void {
    const p = this.palette;
    ctx.font = p.regionFont;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 4;
    ctx.strokeStyle = p.background;
    ctx.fillStyle = p.label;
    const soften = this.mode === "calm" ? 1 : REGION_EMPHASIS_ALPHA;
    ctx.globalAlpha = fade * REGION_TEXT_ALPHA * soften;
    for (let k = 0; k < regions.placedCount; k += 1) {
      const text = regions.names[regions.placed[k] as number] as string;
      const x = regions.placedX[k] as number;
      const y = regions.placedY[k] as number;
      ctx.strokeText(text, x, y);
      ctx.fillText(text, x, y);
    }
  }

  private drawNoteLabels(ctx: CanvasRenderingContext2D, count: number, zoom: number): void {
    const nodes = this.scene.nodes;
    const c = this.cam;
    const p = this.palette;
    ctx.font = p.labelFont;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = p.background;
    ctx.fillStyle = p.label;
    for (let k = 0; k < count; k += 1) {
      const i = this.placedLabels[k] as number;
      const n = nodes[i] as SceneNode;
      ctx.globalAlpha = this.labelAlphas[i] as number;
      const x = c.x + c.s * n.x;
      const y = c.y + c.s * n.y + this.radius(n, zoom) + LABEL_OFFSET;
      const text = this.labels[i] as string;
      ctx.strokeText(text, x, y);
      ctx.fillText(text, x, y);
    }
  }

  /** A note label's width; the context's font must be the label font. Measured once. */
  private labelWidth(ctx: CanvasRenderingContext2D, i: number): number {
    const known = this.labelWidths[i] as number;
    if (!Number.isNaN(known)) return known;
    const width = ctx.measureText(this.labels[i] as string).width;
    this.labelWidths[i] = width;
    return width;
  }
}

/** The page's regions, kept by note key so a new scene (filters, Animate) keeps every note's
 * region, with the arrays a frame needs to name them. Everything per frame is preallocated. */
class RegionLabels {
  /** Names, shortened like note labels; an empty one leaves its region unnamed. */
  readonly names: readonly string[];
  /** Region per scene node, -1 for none. */
  of = new Int32Array(0);
  /** Notes per region on the canvas. */
  readonly total: Int32Array;
  /** The regions to name, biggest first. */
  order = new Int32Array(0);
  /** Per region, the sum of its notes' positions this frame, for the centroid. */
  readonly sumX: Float64Array;
  readonly sumY: Float64Array;
  /** Name widths in the region font; NaN until first measured. */
  readonly widths: Float32Array;
  /** The names placed this frame, with their screen centres. */
  readonly placed: Int32Array;
  readonly placedX: Float64Array;
  readonly placedY: Float64Array;
  placedCount = 0;
  /** Screen boxes of the names drawn last frame that take clicks, for pickRegion. */
  readonly hits: Float64Array;
  readonly hitIds: Int32Array;
  hitCount = 0;

  private constructor(
    private readonly byKey: ReadonlyMap<string, number>,
    names: readonly string[],
  ) {
    const count = names.length;
    this.names = names.map((name) => shortLabel(name));
    this.total = new Int32Array(count);
    this.sumX = new Float64Array(count);
    this.sumY = new Float64Array(count);
    this.widths = new Float32Array(count).fill(Number.NaN);
    this.placed = new Int32Array(count);
    this.placedX = new Float64Array(count);
    this.placedY = new Float64Array(count);
    this.hits = new Float64Array(4 * count);
    this.hitIds = new Int32Array(count);
  }

  /** The page's regions, given aligned with `nodes`. */
  static from(regions: SceneRegions, nodes: readonly SceneNode[]): RegionLabels {
    const byKey = new Map<string, number>();
    nodes.forEach((n, i) => {
      const r = regions.assign[i] as number;
      if (r >= 0 && r < regions.names.length) byKey.set(n.key, r);
    });
    const labels = new RegionLabels(byKey, regions.names);
    labels.align(nodes);
    return labels;
  }

  /** Lines the regions up with a scene's notes. */
  align(nodes: readonly SceneNode[]): void {
    this.of = Int32Array.from(nodes, (n) => this.byKey.get(n.key) ?? -1);
    this.total.fill(0);
    for (const r of this.of) if (r >= 0) this.total[r] = (this.total[r] as number) + 1;
    const named: number[] = [];
    for (let r = 0; r < this.names.length; r += 1) {
      if (this.names[r] !== "" && (this.total[r] as number) >= REGION_MIN_NOTES) named.push(r);
    }
    named.sort((p, q) => (this.total[q] as number) - (this.total[p] as number) || p - q);
    this.order = Int32Array.from(named);
    this.placedCount = 0;
    this.hitCount = 0;
  }

  /** Sums each region's note positions, for this frame's centroids. */
  sum(nodes: readonly SceneNode[]): void {
    this.sumX.fill(0);
    this.sumY.fill(0);
    const of = this.of;
    for (let i = 0; i < of.length; i += 1) {
      const r = of[i] as number;
      if (r < 0) continue;
      const n = nodes[i] as SceneNode;
      this.sumX[r] = (this.sumX[r] as number) + n.x;
      this.sumY[r] = (this.sumY[r] as number) + n.y;
    }
  }
}

/** Measures the names about to be offered, once each; the context's font must be the region font. */
function measureRegions(ctx: CanvasRenderingContext2D, regions: RegionLabels): void {
  for (const r of regions.order) {
    if (Number.isNaN(regions.widths[r])) {
      regions.widths[r] = ctx.measureText(regions.names[r] as string).width;
    }
  }
}

/** A link's style around a hovered or selected note: only links one step outwards (both ends
 * within the depths, one apart) stand out, the source's own in the accent and deeper steps in
 * a stronger neutral. A suggested link keeps its dashes and takes its step's colour, so the
 * accent never lands further out than the source's own links. Everything else, links among
 * notes at the same depth included, fades. */
function depthStyle(edge: SceneEdge, depth: Int8Array): number {
  const da = depth[edge.a] as number;
  const db = depth[edge.b] as number;
  const step = da >= 0 && db >= 0 && (da - db === 1 || db - da === 1);
  if (!step) return edge.suggested ? DIM_SUGGESTED : DIM;
  const own = da === 0 || db === 0;
  if (edge.suggested) return own ? SUGGESTED : PATH_SUGGESTED;
  return own ? NEAR : PATH;
}

/** A link's style otherwise: the hovered and selected notes' own links in the accent and,
 * under a legend highlight, links touching a lit note stronger while the rest dim. */
function calmStyle(
  edge: SceneEdge,
  standing: Int8Array,
  litMode: boolean,
  hover: number,
  focus: number,
): number {
  const active = edge.a === hover || edge.b === hover || edge.a === focus || edge.b === focus;
  // Dimming wins over style: a dimmed suggested link stays dashed but fades with the rest.
  if (litMode && !active && standing[edge.a] !== 1 && standing[edge.b] !== 1) {
    return edge.suggested ? DIM_SUGGESTED : DIM;
  }
  if (edge.suggested) return SUGGESTED;
  if (active) return NEAR;
  return litMode ? PATH : REST;
}

function indexIn(at: ReadonlyMap<string, number>, key: string | null): number {
  return key === null ? -1 : (at.get(key) ?? -1);
}

function pathBatches(count: number): PathBatch[] {
  return Array.from({ length: count }, () => new PathBatch());
}

/** The page's font loading, absent in jsdom. */
function fontSet(): FontFaceSet | undefined {
  return typeof document === "undefined" ? undefined : (document.fonts as FontFaceSet | undefined);
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

function inBox(n: SceneNode, box: Bounds): boolean {
  return n.x >= box.minX && n.x <= box.maxX && n.y >= box.minY && n.y <= box.maxY;
}

/** A cheap box test: a link is drawn unless both ends sit past the same side of the view. */
function segmentInBox(a: SceneNode, b: SceneNode, box: Bounds): boolean {
  if (a.x < box.minX && b.x < box.minX) return false;
  if (a.x > box.maxX && b.x > box.maxX) return false;
  if (a.y < box.minY && b.y < box.minY) return false;
  if (a.y > box.maxY && b.y > box.maxY) return false;
  return true;
}

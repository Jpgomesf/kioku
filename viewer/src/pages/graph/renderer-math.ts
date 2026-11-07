// Pure helpers for the canvas renderer: easing, screen sizes, how strongly links, notes and
// labels draw, label placement and the spatial grid.
import type { Camera } from "./camera";
import type { SceneNode } from "./scene";

/** A CSS cubic-bezier(x1, y1, x2, y2) easing: solve x(t) = progress for t, return y(t). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (p: number) => number {
  const bez = (t: number, a: number, b: number) =>
    3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  const slope = (t: number, a: number, b: number) =>
    3 * a * (1 - t) ** 2 + 6 * (b - a) * t * (1 - t) + 3 * (1 - b) * t * t;
  return (p: number) => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    // Newton steps converge fast for these curves; bisection is the fallback when the slope is flat.
    let t = p;
    for (let i = 0; i < 8; i += 1) {
      const err = bez(t, x1, x2) - p;
      if (Math.abs(err) < 1e-6) return bez(t, y1, y2);
      const d = slope(t, x1, x2);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = p;
    for (let i = 0; i < 40; i += 1) {
      const x = bez(t, x1, x2);
      if (Math.abs(x - p) < 1e-7) break;
      if (x < p) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return bez(t, y1, y2);
  };
}

/** The camera easing used across the viewer: cubic-bezier(.2,.7,.2,1). */
export const cameraEase = cubicBezier(0.2, 0.7, 0.2, 1);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A node's drawn radius in screen pixels. `zoom` is the camera scale over the whole-area scale. */
export function screenRadius(size: number, topic: boolean, zoom: number): number {
  // About 1.5-5 px at the whole-area scale: a typical note stays small, so a dense area is not
  // a carpet of dots, while hubs (log of their links) still stand out. Grows gently (square
  // root) when zooming in, capped.
  const base = 1.5 + Math.min(3.5, Math.log2(Math.max(1, size)) * 0.5);
  const r = Math.min(12, base * Math.sqrt(Math.max(1, zoom)));
  return topic ? r + 1.5 : r;
}

// --- How strongly links draw ---------------------------------------------------------------

/** How much of the screen a set of links covers: their total on-screen length per screen
 * pixel. The renderer counts each link at most once across the screen, however long. */
export function linkDensity(totalLength: number, width: number, height: number): number {
  return totalLength / Math.max(1, width * height);
}

/** Rest alpha for links while few cover the screen. */
export const REST_LINK_MAX = 0.18;
/** The floor: the densest area keeps a faint web you can still see, about 5 grey levels over
 * the background in either theme. One stroke paints links that overlap only once, so a dense
 * area never builds up past this; any lower and the web disappears. */
export const REST_LINK_MIN = 0.035;

/** 1 at a density of 1 (a screen's worth of links), falling off with the square root: a denser
 * set of links draws fainter, but density still shows. Infinite when there are none. */
function falloff(density: number): number {
  return density > 0 ? 1 / Math.sqrt(density) : Number.POSITIVE_INFINITY;
}

/** Rest alpha for links: clear when few cover the screen and fainter as more do, so a dense
 * area reads as a soft texture instead of a grey mat. 0.05 at a density of 1; 16,000 links
 * across a whole area (a density above 2) sit on the floor. */
export function restLinkAlpha(density: number): number {
  return clamp(0.05 * falloff(density), REST_LINK_MIN, REST_LINK_MAX);
}

/** Links outside a hovered or selected note's neighbourhood: nearly invisible (about one grey
 * level on a dense area), so the highlighted path is obvious at a glance among 16,000 links. */
export function fadedLinkAlpha(rest: number): number {
  return rest * 0.2;
}

/** Links outside a legend highlight: fainter than rest, but still there for context. */
export function dimmedEdgeAlpha(rest: number): number {
  return rest * 0.4;
}

/** What the renderer is emphasising: nothing ("calm", where hover and selection only ring and
 * accent their own links), a legend group ("lit"), or the depths around a note ("depth"). */
export type EmphasisMode = "calm" | "lit" | "depth";

/** The density (linkDensity) of the links drawn in each style this frame. */
export interface LinkDensities {
  all: number;
  near: number;
  path: number;
  suggested: number;
}

export interface LinkAlphas {
  /** Links when nothing is emphasised. */
  rest: number;
  /** Links outside the emphasis. */
  dim: number;
  /** Steps further out than the source's own links (suggested ones dashed), or links of a
   * legend-lit note: a stronger neutral. */
  path: number;
  /** The source's own links, in the accent. */
  near: number;
  /** Links Reflect suggests: dashed, accent. */
  suggested: number;
  dimSuggested: number;
}

/** The accent for the source's own links: as strong as this for a note with a few links... */
export const NEAR_MAX = 0.85;
/** ...and never weaker than this, however many it has. */
export const NEAR_MIN = 0.35;
/** The neutral for deeper steps never goes past this. */
export const PATH_MAX = 0.5;

/** Every style's alpha for one frame. Each emphasised style falls off with its own density, as
 * rest links do, so a hub's fan of links stays a readable fan instead of a solid block. A
 * path link is always at least 2.5 times as strong as a resting one, whatever the density.
 * The accents scale on their own rather than off the rest alpha, so the resting web can be
 * tuned without turning a hub's fan of accent links into a solid burst. */
export function linkAlphas(mode: EmphasisMode, d: LinkDensities): LinkAlphas {
  const rest = restLinkAlpha(d.all);
  const dim = mode === "depth" ? fadedLinkAlpha(rest) : dimmedEdgeAlpha(rest);
  const suggested = clamp(0.1125 * falloff(d.suggested), 0.3, 0.8);
  return {
    rest,
    dim,
    path: Math.min(PATH_MAX, 2.5 * restLinkAlpha(d.path)),
    near: clamp(0.125 * falloff(d.near), NEAR_MIN, NEAR_MAX),
    suggested,
    // Dashes cover less of their length, so they take twice the faded alpha.
    dimSuggested: Math.min(suggested, dim * 2),
  };
}

// --- How strongly notes and labels draw -------------------------------------------------

/** Alpha for notes and labels outside the emphasis: clearly faded but still visible. */
export const DIM_ALPHA = 0.2;
/** Alpha for legacy notes and their labels. */
export const LEGACY_ALPHA = 0.45;
/** Notes two and three links from the source draw a little softer than its own neighbours. */
export const DEPTH_ALPHAS = [1, 1, 0.8, 0.62] as const;

/** A note's place in the emphasis ("standing"): CALM while nothing is emphasised, FADED
 * outside the emphasis, else its number of links from the source (0); a legend-lit note
 * counts as 1. */
export const CALM = -2;
export const FADED = -1;

/** Note strengths, dimmest first: the renderer draws them in this order, so emphasised notes
 * sit on top of faded ones. Indices come from noteStrength. */
export const NOTE_ALPHAS = [DIM_ALPHA, LEGACY_ALPHA, DEPTH_ALPHAS[3], DEPTH_ALPHAS[2], 1] as const;

/** A note's strength, an index into NOTE_ALPHAS. Legacy notes stay faint even when lit. */
export function noteStrength(standing: number, legacy: boolean): number {
  if (standing === FADED) return 0;
  if (legacy) return 1;
  if (standing >= 3) return 2;
  if (standing === 2) return 3;
  return 4;
}

/** The zoom ratio (camera scale over whole-area scale) at which labels start to appear.
 * textFade 0 shows them from 2x; each step of 1 moves that by a factor of 1.6. */
export function labelThreshold(textFade: number): number {
  return 2 * 1.6 ** -textFade;
}

/** Label opacity at a zoom ratio: 0 up to the threshold, then fading in until 1.5x past it. */
export function labelAlpha(zoom: number, textFade: number): number {
  const t = labelThreshold(textFade);
  return clamp((zoom / t - 1) / 0.5, 0, 1);
}

/** A label's opacity. Hovered, selected and dragged notes (`active`) are always named at full
 * strength, and the source and its direct neighbours (or legend-lit notes) whatever the zoom;
 * deeper notes and the rest fade in with the zoom, at their dot's strength. Positional, so
 * the per-node call allocates nothing. */
export function labelOpacity(
  zoomAlpha: number,
  active: boolean,
  standing: number,
  legacy: boolean,
): number {
  if (active) return 1;
  if (standing === FADED) return zoomAlpha * DIM_ALPHA;
  const strength = NOTE_ALPHAS[noteStrength(standing, legacy)] as number;
  if (standing === 0 || standing === 1) return strength;
  return zoomAlpha * strength;
}

/** Label priorities, highest first: a label that would overlap one of a higher priority is
 * skipped. Region names come after the notes the viewer is pointing at and their direct
 * neighbours, and ahead of every other note. Topics come next: they give way to region names
 * (a topic is often its region's hub, right under the name) but never to plain notes. Ties go
 * to the bigger note. */
export const RANK_SOURCE = 6;
export const RANK_SELECTED = 5;
export const RANK_NEAR = 4;
export const RANK_REGION = 3;
export const RANK_TOPIC = 2;
export const RANK_DEEP = 1;
export const RANK_REST = 0;

/** A note label's priority. `source` is the hovered or dragged note; depth 0 counts too. */
export function labelRank(standing: number, source: boolean, selected: boolean): number {
  if (source || standing === 0) return RANK_SOURCE;
  if (selected) return RANK_SELECTED;
  if (standing === 1) return RANK_NEAR;
  if (standing >= 2) return RANK_DEEP;
  return RANK_REST;
}

/** A topic label's priority while topic labels are on: at least RANK_TOPIC, except outside the
 * emphasis, where a faded topic gives way to every lit note. */
export function topicLabelRank(standing: number, source: boolean, selected: boolean): number {
  const rank = labelRank(standing, source, selected);
  return standing === FADED ? rank : Math.max(rank, RANK_TOPIC);
}

/** A topic label's opacity while topic labels are on: shown at any zoom, as strong as its ring,
 * so it fades with the ring outside the emphasis instead of vanishing on every hover. */
export function topicLabelOpacity(active: boolean, standing: number, legacy: boolean): number {
  return active ? 1 : (NOTE_ALPHAS[noteStrength(standing, legacy)] as number);
}

const INDEX_SPAN = 2 ** 21;
const SIZE_SPAN = 2 ** 20;

/** A label's sort key: ascending keys put higher ranks first, then bigger notes, then scene
 * order. Packed into one exact integer so a Float64Array of keys sorts in place without a
 * comparator, allocating nothing per frame. Holds ranks 0-7, sizes up to about a million and
 * about two million notes. */
export function labelSortKey(rank: number, size: number, index: number): number {
  const s = size >= 1 ? Math.min(SIZE_SPAN - 1, Math.floor(size)) : 0;
  return ((7 - rank) * SIZE_SPAN + (SIZE_SPAN - 1 - s)) * INDEX_SPAN + index;
}

/** The scene index a labelSortKey was made for. */
export function labelSortIndex(key: number): number {
  return key % INDEX_SPAN;
}

/** Region names show in full up to this zoom ratio (the whole area is 1)... */
export const REGION_FADE_FROM = 1.25;
/** ...and are gone by this one, about when note labels have faded in. */
export const REGION_FADE_TO = 2.5;

/** A region name's opacity at a zoom ratio, before the renderer's own softening. */
export function regionLabelAlpha(zoom: number): number {
  return clamp((REGION_FADE_TO - zoom) / (REGION_FADE_TO - REGION_FADE_FROM), 0, 1);
}

/** Screen boxes of the labels placed so far in a frame, for greedy collision avoidance: the
 * caller offers labels in priority order and each one is placed only where it overlaps none
 * placed before. One buffer, reused across frames. */
export class LabelBoxes {
  private boxes = new Float64Array(4 * 128);
  private count = 0;

  reset(): void {
    this.count = 0;
  }

  get size(): number {
    return this.count;
  }

  /** Places the box unless it overlaps one already placed; true when placed. */
  place(x0: number, y0: number, x1: number, y1: number): boolean {
    const b = this.boxes;
    const end = 4 * this.count;
    for (let i = 0; i < end; i += 4) {
      if (
        x0 < (b[i + 2] as number) &&
        x1 > (b[i] as number) &&
        y0 < (b[i + 3] as number) &&
        y1 > (b[i + 1] as number)
      ) {
        return false;
      }
    }
    if (end + 4 > b.length) {
      const grown = new Float64Array(b.length * 2);
      grown.set(b);
      this.boxes = grown;
    }
    const o = this.boxes;
    o[end] = x0;
    o[end + 1] = y0;
    o[end + 2] = x1;
    o[end + 3] = y1;
    this.count += 1;
    return true;
  }
}

/** A uniform grid over world space, so pick and nearest look at a few cells, not every note. */
export class SpatialGrid {
  private readonly cells = new Map<string, number[]>();
  readonly cellSize: number;

  constructor(
    private readonly nodes: readonly SceneNode[],
    cellSize?: number,
  ) {
    this.cellSize = cellSize ?? SpatialGrid.chooseCellSize(nodes);
    nodes.forEach((n, i) => {
      const key = this.cellKey(this.cell(n.x), this.cell(n.y));
      const list = this.cells.get(key);
      if (list) list.push(i);
      else this.cells.set(key, [i]);
    });
  }

  /** Aim for about two notes per cell. */
  private static chooseCellSize(nodes: readonly SceneNode[]): number {
    if (nodes.length < 2) return 64;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x);
      maxY = Math.max(maxY, n.y);
    }
    const area = Math.max(1, (maxX - minX) * (maxY - minY));
    return Math.max(1, Math.sqrt((area * 2) / nodes.length));
  }

  private cell(v: number): number {
    return Math.floor(v / this.cellSize);
  }

  private cellKey(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }

  /** Indices of the notes in cells touching the world box. */
  query(minX: number, minY: number, maxX: number, maxY: number, out: number[] = []): number[] {
    const x0 = this.cell(minX);
    const x1 = this.cell(maxX);
    const y0 = this.cell(minY);
    const y1 = this.cell(maxY);
    // A huge box (zoomed far out) would visit many empty cells; scan the occupied ones instead.
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > this.cells.size) {
      for (const [key, list] of this.cells) {
        const [cx, cy] = key.split(",").map(Number) as [number, number];
        if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) out.push(...list);
      }
      return out;
    }
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cy = y0; cy <= y1; cy += 1) {
        const list = this.cells.get(this.cellKey(cx, cy));
        if (list) out.push(...list);
      }
    }
    return out;
  }

  /** The note nearest a world point, searching outward ring by ring. */
  nearest(wx: number, wy: number, accept: (i: number) => boolean): number {
    if (this.nodes.length === 0) return -1;
    const cx = this.cell(wx);
    const cy = this.cell(wy);
    let best = -1;
    let bestD = Infinity;
    const maxRing = 1 + Math.ceil(Math.sqrt(this.cells.size)) * 4;
    for (let ring = 0; ring <= maxRing; ring += 1) {
      for (let x = cx - ring; x <= cx + ring; x += 1) {
        for (let y = cy - ring; y <= cy + ring; y += 1) {
          if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== ring) continue;
          for (const i of this.cells.get(this.cellKey(x, y)) ?? []) {
            if (!accept(i)) continue;
            const n = this.nodes[i] as SceneNode;
            const d = (n.x - wx) ** 2 + (n.y - wy) ** 2;
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
        }
      }
      // Anything in a ring further out is at least `ring * cellSize` away.
      if (best >= 0 && Math.sqrt(bestD) <= ring * this.cellSize) return best;
    }
    if (best >= 0) return best;
    // Far outside the grid: fall back to a scan.
    this.nodes.forEach((n, i) => {
      if (!accept(i)) return;
      const d = (n.x - wx) ** 2 + (n.y - wy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }
}

/** The world box the camera shows, grown by a margin in screen pixels. */
export function visibleWorld(c: Camera, width: number, height: number, marginPx: number) {
  return {
    minX: (-marginPx - c.x) / c.s,
    minY: (-marginPx - c.y) / c.s,
    maxX: (width + marginPx - c.x) / c.s,
    maxY: (height + marginPx - c.y) / c.s,
  };
}

/** Tag nodes draw this much smaller than a note of the same size, as in Obsidian. */
export const TAG_SCALE = 0.6;

/** The text drawn for a node: tags read "#name", long titles end in an ellipsis. */
export function nodeLabel(label: string, tag: boolean): string {
  return shortLabel(tag && !label.startsWith("#") ? `#${label}` : label);
}

/** Shortest on-screen link, in pixels, that still gets an arrowhead. */
export const ARROW_MIN_LENGTH = 24;

/** Longest label drawn, in characters; longer titles end in an ellipsis. */
export const LABEL_MAX = 28;

export function shortLabel(title: string): string {
  return title.length <= LABEL_MAX ? title : `${title.slice(0, LABEL_MAX - 1).trimEnd()}…`;
}

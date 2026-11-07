// Pure helpers for the canvas renderer: easing, screen sizes and the spatial grid.
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

/** A node's drawn radius in screen pixels. `zoom` is the camera scale over the whole-area scale. */
export function screenRadius(size: number, topic: boolean, zoom: number): number {
  // About 2-5 px at the whole-area scale, growing gently (square root) when zooming in, capped.
  const base = 2 + Math.min(3, Math.log2(Math.max(1, size)) * 0.9);
  const r = Math.min(12, base * Math.sqrt(Math.max(1, zoom)));
  return topic ? r + 1.5 : r;
}

/** Rest alpha for links: fainter when many are on screen. */
export function edgeAlpha(visibleEdges: number): number {
  if (visibleEdges <= 200) return 0.2;
  return Math.max(0.06, 0.2 * Math.sqrt(200 / visibleEdges));
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

/** The zoom ratio (camera scale over whole-area scale) at which labels start to appear.
 * textFade 0 shows them from 2x; each step of 1 moves that by a factor of 1.6. */
export function labelThreshold(textFade: number): number {
  return 2 * 1.6 ** -textFade;
}

/** Label opacity at a zoom ratio: 0 up to the threshold, then fading in until 1.5x past it. */
export function labelAlpha(zoom: number, textFade: number): number {
  const t = labelThreshold(textFade);
  return Math.max(0, Math.min(1, (zoom / t - 1) / 0.5));
}

/** Shortest on-screen link, in pixels, that still gets an arrowhead. */
export const ARROW_MIN_LENGTH = 24;

/** Longest label drawn, in characters; longer titles end in an ellipsis. */
export const LABEL_MAX = 28;

export function shortLabel(title: string): string {
  return title.length <= LABEL_MAX ? title : `${title.slice(0, LABEL_MAX - 1).trimEnd()}\u2026`;
}

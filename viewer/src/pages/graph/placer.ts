// Places the HTML overlay (labels, cards, their link lines) over the canvas. React renders the
// overlay's content and marks each element with its world point in data attributes; this sets
// the screen transforms straight on the DOM nodes, so a camera frame never re-renders React.
//
// The notes move while the live layout settles, so a point can follow a note: with data-k the
// element sits at that note's live position (from options.point) plus data-x, data-y as a
// world offset. Without it, data-x, data-y are a fixed world point.
//
// Attributes on a placed element:
//   data-k            note key the point follows (optional)
//   data-x, data-y    world point it sits at when shown, or the offset from data-k
//   data-fk           note key it grows from while hidden (optional)
//   data-fx, data-fy  world point it grows from while hidden, or the offset from data-fk
//                     (with neither data-fk nor these, it grows from where it sits)
//   data-on           "1" when shown; a change animates between the two points
//   data-scale        "detail": sized like the cards step (grows with zoom); otherwise fixed
//   data-anchor       "top": hangs below its point; otherwise centred on it
//   data-dy           a fixed screen offset downwards, in pixels
//   data-grow         "1": shrinks to a speck while hidden (cards)
// An SVG <line> with data-x1, data-y1 (or data-k1, a note key) draws from that point to its
// moving end.
import type { Camera } from "./camera";
import type { Point } from "./layout";
import { cameraEase } from "./renderer-math";

interface Growth {
  on: boolean;
  start: number;
}

const HIDDEN_SCALE = 0.05;

function num(el: Element, name: string, fallback = 0): number {
  const v = el.getAttribute(name);
  if (v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export interface OverlayPlacerOptions {
  camera: () => Camera;
  /** The camera scale at which "detail" elements show at their natural size. */
  detailScale: () => number;
  /** How long an element takes to grow out of its dot; 0 under reduced motion. */
  growMs: () => number;
  /** A note's live world position, or null while it has none. */
  point?: (key: string) => Point | null;
}

export class OverlayPlacer {
  private readonly growth = new WeakMap<Element, Growth>();
  private frame: number | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly options: OverlayPlacerOptions,
  ) {}

  /** Places every marked element for the current camera. Keeps placing on later frames while
   * any element is still growing or shrinking. */
  place(): void {
    const now = performance.now();
    const cam = this.options.camera();
    const detail = cam.s / Math.max(this.options.detailScale(), 1e-9);
    const dur = this.options.growMs();
    let moving = false;
    for (const el of this.root.querySelectorAll("[data-x],[data-k]")) {
      const at = this.resolve(el, "data-k", "data-x", "data-y", null);
      // A note with no position yet: leave the element where it is until it has one.
      if (!at) continue;
      const start = this.resolve(el, "data-fk", "data-fx", "data-fy", at);
      if (!start) continue;
      const on = el.getAttribute("data-on") !== "0";
      let g = this.growth.get(el);
      if (!g) {
        // First sight: no animation, it simply starts where it is.
        g = { on, start: Number.NEGATIVE_INFINITY };
        this.growth.set(el, g);
      } else if (g.on !== on) {
        g.on = on;
        g.start = now;
      }
      const p = dur > 0 ? Math.min(1, Math.max(0, (now - g.start) / dur)) : 1;
      if (p < 1) moving = true;
      const e = cameraEase(p);
      const t = on ? e : 1 - e;
      const wx = start.x + (at.x - start.x) * t;
      const wy = start.y + (at.y - start.y) * t;
      const sx = cam.x + cam.s * wx;
      const sy = cam.y + cam.s * wy + num(el, "data-dy");
      if (el.hasAttribute("data-x1") || el.hasAttribute("data-k1")) {
        const one = this.resolve(el, "data-k1", "data-x1", "data-y1", null);
        if (!one) continue;
        el.setAttribute("x1", String(cam.x + cam.s * one.x));
        el.setAttribute("y1", String(cam.y + cam.s * one.y));
        el.setAttribute("x2", String(sx));
        el.setAttribute("y2", String(sy));
        continue;
      }
      let k = el.getAttribute("data-scale") === "detail" ? detail : 1;
      if (el.getAttribute("data-grow") === "1") k *= HIDDEN_SCALE + (1 - HIDDEN_SCALE) * t;
      const anchor = el.getAttribute("data-anchor") === "top" ? "-50%, 0" : "-50%, -50%";
      (el as HTMLElement).style.transform =
        `translate(${sx}px, ${sy}px) translate(${anchor}) scale(${k})`;
    }
    if (moving) this.schedule();
  }

  /** The world point named by a key attribute plus offsets, or the offsets alone as a fixed
   * point; `fallback` when the element sets none of the three. Null when the key has no
   * position. */
  private resolve(
    el: Element,
    keyAttr: string,
    xAttr: string,
    yAttr: string,
    fallback: Point | null,
  ): Point | null {
    const key = el.getAttribute(keyAttr);
    if (key !== null) {
      const p = this.options.point?.(key) ?? null;
      return p ? { x: p.x + num(el, xAttr), y: p.y + num(el, yAttr) } : null;
    }
    if (fallback && !el.hasAttribute(xAttr) && !el.hasAttribute(yAttr)) return fallback;
    return { x: num(el, xAttr), y: num(el, yAttr) };
  }

  destroy(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  private schedule(): void {
    if (this.frame !== null || typeof requestAnimationFrame !== "function") return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.place();
    });
  }
}

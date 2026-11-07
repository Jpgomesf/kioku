// Places the HTML overlay (labels, cards, their link lines) over the canvas. React renders the
// overlay's content and marks each element with its world point in data attributes; this sets
// the screen transforms straight on the DOM nodes, so a camera frame never re-renders React.
//
// Attributes on a placed element:
//   data-x, data-y    world point it sits at when shown
//   data-fx, data-fy  world point it grows from while hidden (defaults to data-x, data-y)
//   data-on           "1" when shown; a change animates between the two points
//   data-scale        "detail": sized like the cards step (grows with zoom); otherwise fixed
//   data-anchor       "top": hangs below its point; otherwise centred on it
//   data-dy           a fixed screen offset downwards, in pixels
//   data-grow         "1": shrinks to a speck while hidden (cards)
// An SVG <line> with data-x1, data-y1 draws from that fixed world point to its moving end.
import type { Camera } from "./camera";
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
    for (const el of this.root.querySelectorAll("[data-x]")) {
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
      const x = num(el, "data-x");
      const y = num(el, "data-y");
      const wx = num(el, "data-fx", x) + (x - num(el, "data-fx", x)) * t;
      const wy = num(el, "data-fy", y) + (y - num(el, "data-fy", y)) * t;
      const sx = cam.x + cam.s * wx;
      const sy = cam.y + cam.s * wy + num(el, "data-dy");
      if (el.hasAttribute("data-x1")) {
        el.setAttribute("x1", String(cam.x + cam.s * num(el, "data-x1")));
        el.setAttribute("y1", String(cam.y + cam.s * num(el, "data-y1")));
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

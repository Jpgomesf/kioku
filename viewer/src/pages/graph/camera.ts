// Camera math for the semantic zoom, after the GraphZoom board: a screen point is
// (x + s * worldX, y + s * worldY). Both the SVG layer and the HTML labels and cards use the
// same transform, so they stay in step while CSS animates the camera.
import { type Bounds, type Point, WORLD } from "./layout";

export interface Camera {
  x: number;
  y: number;
  s: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** The four steps, as multiples of the whole-area scale (board: 0.94, 2.2, 3.5, 7). */
export const STEPS = [1, 2.34, 3.72, 7.45] as const;
export type Level = 0 | 1 | 2 | 3;

export const MIN_RATIO = 0.6;
export const MAX_RATIO = 10;

/** Thresholds between levels, halfway (geometrically) between the steps. */
const THRESHOLDS = [1.53, 2.95, 5.26] as const;

export function toScreen(c: Camera, p: Point): Point {
  return { x: c.x + c.s * p.x, y: c.y + c.s * p.y };
}

export function toWorld(c: Camera, p: Point): Point {
  return { x: (p.x - c.x) / c.s, y: (p.y - c.y) / c.s };
}

/** The camera that shows the whole area, centred, with a margin. */
export function fitCamera(bounds: Bounds, view: Viewport, margin = 32): Camera {
  // A floor on the box keeps an area with one or two notes from filling the stage.
  const w = Math.max(bounds.maxX - bounds.minX, WORLD.width / 2);
  const h = Math.max(bounds.maxY - bounds.minY, WORLD.height / 2);
  const s = Math.max(Math.min((view.width - 2 * margin) / w, (view.height - 2 * margin) / h), 0.05);
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return { x: view.width / 2 - cx * s, y: view.height / 2 - cy * s, s };
}

/** The camera that centres `p` at scale `s`. */
export function centreOn(p: Point, s: number, view: Viewport): Camera {
  return { x: view.width / 2 - p.x * s, y: view.height / 2 - p.y * s, s };
}

export function clampScale(s: number, fitScale: number): number {
  return Math.min(Math.max(s, fitScale * MIN_RATIO), fitScale * MAX_RATIO);
}

/** Zoom by `factor` keeping the screen point `anchor` over the same world point. */
export function zoomAt(c: Camera, factor: number, anchor: Point, fitScale: number): Camera {
  const s = clampScale(c.s * factor, fitScale);
  const k = s / c.s;
  return { x: anchor.x - (anchor.x - c.x) * k, y: anchor.y - (anchor.y - c.y) * k, s };
}

export function pan(c: Camera, dx: number, dy: number): Camera {
  return { x: c.x + dx, y: c.y + dy, s: c.s };
}

/** Which semantic level a scale shows. */
export function levelFor(s: number, fitScale: number): Level {
  const r = s / fitScale;
  if (r < THRESHOLDS[0]) return 0;
  if (r < THRESHOLDS[1]) return 1;
  if (r < THRESHOLDS[2]) return 2;
  return 3;
}

/** The camera for a step: the whole area, or a step's scale centred on the focus. */
export function stepCamera(level: Level, focus: Point | null, fit: Camera, view: Viewport): Camera {
  if (level === 0 || !focus) return fit;
  return centreOn(focus, fit.s * STEPS[level], view);
}

/** One step in or out from the current level. */
export function nextLevel(level: Level, direction: 1 | -1): Level {
  const n = Math.min(3, Math.max(0, level + direction));
  return n as Level;
}

/** Wheel delta (pixels) to a zoom factor; trackpads send many small deltas. */
export function wheelFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const clamped = Math.max(-200, Math.min(200, px));
  return Math.exp(-clamped * 0.0025);
}

export function cameraTransform(c: Camera): string {
  return `translate(${c.x}px, ${c.y}px) scale(${c.s})`;
}

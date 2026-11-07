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

/**
 * The camera that frames part of the area, such as a region, with a margin. Unlike fitCamera
 * it has no minimum box, so a small part fills the view, but its scale stays within the zoom
 * limits around the whole-area scale `fitScale`.
 */
export function frameCamera(bounds: Bounds, view: Viewport, fitScale: number, margin = 64): Camera {
  const w = Math.max(bounds.maxX - bounds.minX, 1);
  const h = Math.max(bounds.maxY - bounds.minY, 1);
  const s = Math.min((view.width - 2 * margin) / w, (view.height - 2 * margin) / h);
  const centre = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
  return centreOn(centre, clampScale(s > 0 ? s : fitScale, fitScale), view);
}

/** The camera that centres `p` at scale `s`. */
export function centreOn(p: Point, s: number, view: Viewport): Camera {
  return { x: view.width / 2 - p.x * s, y: view.height / 2 - p.y * s, s };
}

/**
 * A scale within the zoom limits around the whole-area scale `fitScale`. `liveFitScale` is the
 * scale that fits the notes where they are now: once forces have spread them past the box the
 * area was fitted to, zooming out may go that much further, so the whole graph can still be
 * seen. It never lowers the zoom-in limit.
 */
export function clampScale(s: number, fitScale: number, liveFitScale = fitScale): number {
  const floor = Math.min(fitScale, liveFitScale) * MIN_RATIO;
  return Math.min(Math.max(s, floor), fitScale * MAX_RATIO);
}

/** Zoom by `factor` keeping the screen point `anchor` over the same world point, within the
 * limits clampScale sets. */
export function zoomAt(
  c: Camera,
  factor: number,
  anchor: Point,
  fitScale: number,
  liveFitScale = fitScale,
): Camera {
  const s = clampScale(c.s * factor, fitScale, liveFitScale);
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

/** World spacing of the canvas dot grid at its coarsest. */
export const DOT_SPACING = 24;

/** The canvas dot grid for a camera, in screen pixels. The grid is anchored to the world, so
 * it pans and scales with the view, and its world spacing halves as you zoom in (doubles as
 * you zoom out) so the dots keep an even density, as in FigJam. */
export function dotGrid(c: Camera): { gap: number; x: number; y: number } {
  let gap = DOT_SPACING * c.s;
  if (!Number.isFinite(gap) || gap <= 0) return { gap: DOT_SPACING, x: 0, y: 0 };
  while (gap >= 32) gap /= 2;
  while (gap < 16) gap *= 2;
  return { gap, x: c.x, y: c.y };
}

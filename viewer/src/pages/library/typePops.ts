// More types and Fewer types: the extra type chips pop up one after another, springing a
// little past full size, and pop down the other way round (last first, quicker) before the
// row closes. The timing lives here so the CSS (library.css) and the fold's timer agree.
import type { CSSProperties } from "react";

/** One chip popping in. */
export const POP_IN_MS = 240;
/** One chip popping out: quicker than in. */
export const POP_OUT_MS = 120;
const IN_STEP_MS = 30;
const OUT_STEP_MS = 12;
/** However many chips there are, the cascade's delays fit in these. */
const IN_SPREAD_MS = 320;
const OUT_SPREAD_MS = 120;

function stepFor(count: number, step: number, spread: number): number {
  return count <= 1 ? 0 : Math.min(step, spread / (count - 1));
}

/** How long Fewer types takes for `count` chips: the last one's delay plus its pop. */
export function foldMs(count: number): number {
  if (count <= 0) return 0;
  return Math.round((count - 1) * stepFor(count, OUT_STEP_MS, OUT_SPREAD_MS)) + POP_OUT_MS;
}

/** The class and timing for the extra chip at `index` of `count`, popping in or out. */
export function popProps(
  index: number,
  count: number,
  leaving: boolean,
): { className: string; style: CSSProperties } {
  const delay = leaving
    ? (count - 1 - index) * stepFor(count, OUT_STEP_MS, OUT_SPREAD_MS)
    : index * stepFor(count, IN_STEP_MS, IN_SPREAD_MS);
  return {
    className: leaving ? "library-chip-pop-out" : "library-chip-pop-in",
    style: {
      "--pop-ms": `${leaving ? POP_OUT_MS : POP_IN_MS}ms`,
      "--pop-delay": `${Math.round(delay)}ms`,
    } as CSSProperties,
  };
}

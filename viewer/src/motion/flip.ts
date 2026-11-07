// Layout animation for a container whose children reflow, such as a wrapping row of chips
// that gains or loses some. Call the returned capture() just before the change; once React
// has committed it, children that stayed glide from where they were (FLIP), new ones fade
// in a step apart, removed ones fade out where they stood, and the container's height follows
// instead of jumping. The container must be positioned (position: relative) for the fading
// copies. Under reduced motion, or without the Web Animations API, everything lands at once.
import { type RefObject, useCallback, useLayoutEffect, useRef } from "react";
import { duration, easing, prefersReducedMotion } from "./index";
import { staggerDelay } from "./presence";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How the moves and the height run. Fades keep the overlay timing and their cascade. */
export interface FlipTiming {
  duration: number;
  easing: string;
}

interface Snapshot {
  boxes: Map<Element, Box>;
  height: number;
  timing: FlipTiming;
}

/** Each child's box, relative to the container's padding box (where absolute children sit). */
function measure(container: HTMLElement): Omit<Snapshot, "timing"> {
  const base = container.getBoundingClientRect();
  const left = base.left + container.clientLeft;
  const top = base.top + container.clientTop;
  const boxes = new Map<Element, Box>();
  for (const child of Array.from(container.children)) {
    const r = child.getBoundingClientRect();
    boxes.set(child, { x: r.left - left, y: r.top - top, width: r.width, height: r.height });
  }
  return { boxes, height: base.height };
}

function play(container: HTMLElement, before: Snapshot): void {
  const after = measure(container);
  const fade = { duration: duration.overlay, easing: easing.standard };
  const timing = before.timing;
  let entering = 0;
  for (const [child, box] of after.boxes) {
    if (!(child instanceof HTMLElement)) continue;
    const was = before.boxes.get(child);
    if (!was) {
      child.animate(
        [
          { opacity: 0, transform: "scale(0.96)" },
          { opacity: 1, transform: "none" },
        ],
        {
          ...fade,
          delay: staggerDelay(entering),
          fill: "backwards",
        },
      );
      entering += 1;
      continue;
    }
    const dx = was.x - box.x;
    const dy = was.y - box.y;
    if (dx !== 0 || dy !== 0) {
      child.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], timing);
    }
  }
  // React has already taken removed children out; a copy of each fades where it stood, the
  // last first, so they leave in the reverse of the order they came in.
  const removed = [...before.boxes].filter(
    (entry): entry is [HTMLElement, Box] =>
      !after.boxes.has(entry[0]) && entry[0] instanceof HTMLElement,
  );
  for (const [i, [child, was]] of removed.entries()) {
    const ghost = child.cloneNode(true) as HTMLElement;
    ghost.removeAttribute("id");
    for (const el of ghost.querySelectorAll("[id]")) el.removeAttribute("id");
    ghost.setAttribute("aria-hidden", "true");
    ghost.inert = true;
    Object.assign(ghost.style, {
      position: "absolute",
      left: `${was.x}px`,
      top: `${was.y}px`,
      width: `${was.width}px`,
      height: `${was.height}px`,
      margin: "0",
      pointerEvents: "none",
    });
    container.append(ghost);
    const out = ghost.animate([{ opacity: 1 }, { opacity: 0, transform: "scale(0.96)" }], {
      ...fade,
      delay: staggerDelay(removed.length - 1 - i),
      fill: "both",
    });
    out.finished.then(
      () => ghost.remove(),
      () => ghost.remove(),
    );
  }
  if (after.height !== before.height) {
    container.animate(
      [
        { height: `${before.height}px`, overflow: "clip" },
        { height: `${after.height}px`, overflow: "clip" },
      ],
      timing,
    );
  }
}

/**
 * Returns capture(): call it right before a change whose reflow should animate. Pass a timing
 * for the moves and the height when the change wants its own, such as a fold that closes
 * slower than it opens; otherwise they take the overlay timing.
 */
export function useFlip(
  ref: RefObject<HTMLElement | null>,
): (timing?: Partial<FlipTiming>) => void {
  const snapshot = useRef<Snapshot | null>(null);

  // After every commit: a waiting snapshot means this commit is the change to animate.
  useLayoutEffect(() => {
    const before = snapshot.current;
    if (!before) return;
    snapshot.current = null;
    if (ref.current) play(ref.current, before);
  });

  return useCallback(
    (timing?: Partial<FlipTiming>) => {
      const container = ref.current;
      if (!container || prefersReducedMotion() || typeof container.animate !== "function") return;
      const taken: Snapshot = {
        ...measure(container),
        timing: {
          duration: timing?.duration ?? duration.overlay,
          easing: timing?.easing ?? easing.standard,
        },
      };
      snapshot.current = taken;
      // A click that changes nothing commits nothing: drop the snapshot before it goes stale.
      requestAnimationFrame(() => {
        if (snapshot.current === taken) snapshot.current = null;
      });
    },
    [ref],
  );
}

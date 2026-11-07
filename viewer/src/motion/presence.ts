// Keeps a panel mounted while it plays its leaving animation, then unmounts it.
// Pair the returned state with the .motion-panel and .motion-list classes in base.css.
// Overlays (palette, area switcher) use app/overlay.ts's usePresence instead; the two
// are due to merge into this one.
import { useEffect, useState } from "react";
import { duration, usePrefersReducedMotion } from "./index";

export type PresenceState = "entering" | "entered" | "leaving" | "gone";

export function usePresence(open: boolean, ms: number = duration.overlay): PresenceState {
  const reduced = usePrefersReducedMotion();
  const [state, setState] = useState<PresenceState>(
    open ? (reduced ? "entered" : "entering") : "gone",
  );
  useEffect(() => {
    if (reduced) {
      setState(open ? "entered" : "gone");
      return;
    }
    if (open) {
      setState((s) => (s === "entered" ? s : "entering"));
      // Two frames: the first paints the entering state, the second starts the transition.
      let second = 0;
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => setState("entered"));
      });
      return () => {
        cancelAnimationFrame(first);
        cancelAnimationFrame(second);
      };
    }
    setState((s) => (s === "gone" ? "gone" : "leaving"));
    const timer = setTimeout(() => setState("gone"), ms);
    return () => clearTimeout(timer);
  }, [open, ms, reduced]);
  return state;
}

/** Inline style for a list item's staggered entry; capped so long lists stay quick. */
export function staggerStyle(index: number, step = 20, max = 8): { animationDelay: string } {
  return { animationDelay: `${staggerDelay(index, step, max)}ms` };
}

/** The same stagger in milliseconds, for animations started from script. */
export function staggerDelay(index: number, step = 20, max = 8): number {
  return Math.min(index, max) * step;
}

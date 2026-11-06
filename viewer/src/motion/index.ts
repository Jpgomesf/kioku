// Motion values and the reduced-motion hook. press and overlay come from the design
// tokens (tokens.css); view and zoom are the viewer's own, and zoom matches the
// GraphZoom board's camera (650ms, cubic-bezier(.2,.7,.2,1)). motion.css exposes the
// same values to CSS as --duration-view, --duration-zoom and --ease-zoom.
// JS-driven animation (the graph camera) must check usePrefersReducedMotion() and
// jump straight to the final state when it is true.
import { useEffect, useState } from "react";

export const duration = {
  press: 120,
  overlay: 180,
  view: 240,
  zoom: 650,
} as const;

export const easing = {
  standard: "cubic-bezier(0, 0, 0.2, 1)",
  zoom: "cubic-bezier(0.2, 0.7, 0.2, 1)",
} as const;

const QUERY = "(prefers-reduced-motion: reduce)";

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(QUERY).matches
  );
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(QUERY);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export { type PresenceState, staggerStyle, usePresence } from "./presence";
export {
  canViewTransition,
  runViewTransition,
  useViewTransition,
  type ViewTransitionOptions,
} from "./viewTransition";

// Runs a DOM update inside a view transition when the browser has one, and plainly
// when it doesn't or when the person prefers reduced motion.
import { useCallback } from "react";
import { prefersReducedMotion, usePrefersReducedMotion } from "./index";

interface ViewTransitionLike {
  finished: Promise<void>;
}

type StartViewTransition = (update: () => void) => ViewTransitionLike;

function getStart(doc: Document): StartViewTransition | null {
  const start = (doc as Document & { startViewTransition?: StartViewTransition })
    .startViewTransition;
  return typeof start === "function" ? start.bind(doc) : null;
}

/** True when runViewTransition would animate (the API exists and motion is allowed). */
export function canViewTransition(options: { reduced?: boolean; doc?: Document } = {}): boolean {
  const reduced = options.reduced ?? prefersReducedMotion();
  return !reduced && getStart(options.doc ?? document) !== null;
}

export interface ViewTransitionOptions {
  reduced?: boolean;
  doc?: Document;
  /**
   * Sets data-transition="<type>" on the root element for the transition's life, so CSS
   * can scope view-transition-name to one kind of change (base.css uses "route").
   */
  type?: string;
}

// The latest typed transition; an older one that finishes (or is skipped) late must not
// clear the attribute the newer one still needs.
let latestTyped = 0;

/** Applies update, animated when possible. Resolves once the transition is done. */
export function runViewTransition(
  update: () => void,
  options: ViewTransitionOptions = {},
): Promise<void> {
  const doc = options.doc ?? document;
  const reduced = options.reduced ?? prefersReducedMotion();
  const start = reduced ? null : getStart(doc);
  if (!start) {
    update();
    return Promise.resolve();
  }
  const root = doc.documentElement as HTMLElement | null | undefined;
  const { type } = options;
  // Only typed transitions take a token: an untyped one never clears the attribute, so
  // letting it advance the token would leave a typed one's attribute set for good.
  let token = 0;
  if (type && root) {
    root.dataset.transition = type;
    latestTyped += 1;
    token = latestTyped;
  }
  const clear = () => {
    if (!type || !root || token !== latestTyped) return;
    if (root.dataset.transition === type) delete root.dataset.transition;
  };
  try {
    const transition = start(update);
    return transition.finished.catch(() => undefined).finally(clear);
  } catch {
    clear();
    update();
    return Promise.resolve();
  }
}

/** A stable function that wraps updates in a view transition. */
export function useViewTransition(): (update: () => void) => Promise<void> {
  const reduced = usePrefersReducedMotion();
  return useCallback((update: () => void) => runViewTransition(update, { reduced }), [reduced]);
}

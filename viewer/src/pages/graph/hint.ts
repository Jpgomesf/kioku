// The stage's how-to line ("Scroll to zoom and drag to move…"): shown for HINT_MS the first
// time the graph is seen, then faded for good. It stays in the page as the stage's description
// for screen readers, so only its look goes.
import { useEffect, useState } from "react";

export const HINT_KEY = "kioku.viewer.graph.hintSeen";
export const HINT_MS = 5000;

/** Covers storage being blocked: the hint then shows once per launch, not on every visit. */
let seenThisLaunch = false;

function seen(): boolean {
  if (seenThisLaunch) return true;
  try {
    return window.localStorage.getItem(HINT_KEY) === "1";
  } catch {
    return false;
  }
}

function markSeen(): void {
  seenThisLaunch = true;
  try {
    window.localStorage.setItem(HINT_KEY, "1");
  } catch {
    // Storage can be blocked (private windows, previews); seenThisLaunch still holds.
  }
}

/** True while the hint shows: the first HINT_MS of the first graph seen. */
export function useFirstVisitHint(): boolean {
  const [shown, setShown] = useState(() => !seen());
  useEffect(() => {
    if (!shown) return;
    const timer = window.setTimeout(() => {
      markSeen();
      setShown(false);
    }, HINT_MS);
    return () => window.clearTimeout(timer);
  }, [shown]);
  return shown;
}

/** Tests: as if the graph had never been seen. */
export function resetFirstVisitHint(): void {
  seenThisLaunch = false;
}

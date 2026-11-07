// Where the app has been, so a page can offer a Back button that names where it goes. Each
// history entry carries its place in history.state, and the route at each place is kept for
// the session. Pages that add or rewrite entries themselves (the graph's selection, the
// Library's search) go through pushEntry and replaceEntry, so their entries keep a place.
import { useSyncExternalStore } from "react";
import { parseHash, type Route } from "./router";

const PLACE = "kiokuPlace";

/** The current entry's place; -1 before the first route is seen. */
let place = -1;
/** The route at each place. A gap means an entry from before a reload. */
let trail: (Route | undefined)[] = [];
let version = 0;
const listeners = new Set<() => void>();

function stateOf(): Record<string, unknown> {
  const state: unknown = window.history.state;
  return typeof state === "object" && state !== null ? (state as Record<string, unknown>) : {};
}

function stampedPlace(): number | null {
  const value = stateOf()[PLACE];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function notify(): void {
  version += 1;
  for (const l of listeners) l();
}

/**
 * Note where the current entry sits. A stamped entry was seen before (Back, Forward, a
 * reload); an unstamped one is new, so it goes after the current place and drops the entries
 * that were ahead of it. Runs on every hashchange and popstate; a second call is harmless.
 */
export function recordEntry(): void {
  const known = stampedPlace();
  if (known !== null) {
    place = known;
  } else {
    place += 1;
    trail = trail.slice(0, place);
    try {
      window.history.replaceState({ ...stateOf(), [PLACE]: place }, "");
    } catch {
      // Some embeddings block history changes; Back then falls back to the parent page.
    }
  }
  trail[place] = parseHash(window.location.hash);
  notify();
}

/** Add an entry for `href` without a hashchange, as the graph does for a new selection. */
export function pushEntry(href: string): void {
  try {
    window.history.pushState({ [PLACE]: place + 1 }, "", href);
  } catch {
    return;
  }
  place += 1;
  trail = trail.slice(0, place);
  trail[place] = parseHash(href);
  notify();
}

/** Rewrite the current entry's URL, keeping its place. */
export function replaceEntry(href: string): void {
  try {
    window.history.replaceState({ ...stateOf(), [PLACE]: Math.max(place, 0) }, "", href);
  } catch {
    return;
  }
  trail[Math.max(place, 0)] = parseHash(href);
}

/** True when Back stays in the app: there is an entry before the current one. */
export function canGoBack(): boolean {
  return place > 0;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The page Back returns to: undefined when the app has no earlier page (it opened here),
 * null when it has one but doesn't know it (an entry from before a reload).
 */
export function usePreviousRoute(): Route | null | undefined {
  useSyncExternalStore(subscribe, () => version);
  if (place <= 0) return undefined;
  return trail[place - 1] ?? null;
}

/** The name a Back button shows for the page it returns to. */
export function backLabel(route: Route | null): string {
  switch (route?.name) {
    case "library":
      return "Library";
    case "graph":
      return "Graph";
    case "note":
      return "Previous note";
    case "health":
      return "Health";
    case "reflect":
      return "Reflect";
    case "vaults":
    case "vaults-review":
      return "Vaults";
    case "guide":
      return "Guide";
    default:
      return "Back";
  }
}

/** Tests: forget the session, as on a fresh launch. */
export function resetHistory(): void {
  place = -1;
  trail = [];
  notify();
}

if (typeof window !== "undefined") {
  recordEntry();
  window.addEventListener("hashchange", recordEntry);
  window.addEventListener("popstate", recordEntry);
}

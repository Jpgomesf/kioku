// The current area and the recently used ones, shared by the shell, the area switcher
// and every page. Pages call useCurrentArea(); only the switcher and the sidebar set it.
import { useSyncExternalStore } from "react";
import { graphHref, navigate, parseHash } from "./router";

const CURRENT_KEY = "kioku.viewer.area";
const RECENT_KEY = "kioku.viewer.recentAreas";
const DEFAULT_AREA = "personal/kioku";
const RECENT_LIMIT = 3;

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be blocked (private windows, previews); the in-memory state still works.
  }
}

function readRecent(): string[] {
  const raw = read(RECENT_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((d): d is string => typeof d === "string").slice(0, RECENT_LIMIT)
      : [];
  } catch {
    return [];
  }
}

let current: string = read(CURRENT_KEY) ?? DEFAULT_AREA;
let recent: string[] = readRecent();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Switch to an area and move it to the front of the recent list. */
export function setCurrentArea(domain: string): void {
  if (!domain) return;
  const nextRecent = [domain, ...recent.filter((d) => d !== domain)].slice(0, RECENT_LIMIT);
  if (domain === current && nextRecent.every((d, i) => d === recent[i])) return;
  current = domain;
  recent = nextRecent;
  write(CURRENT_KEY, current);
  write(RECENT_KEY, JSON.stringify(recent));
  for (const l of listeners) l();
}

export function getCurrentArea(): string {
  return current;
}

export function useCurrentArea(): string {
  return useSyncExternalStore(subscribe, () => current);
}

/** Up to three recently used domains, most recent first. May be empty on first run. */
export function useRecentAreas(): readonly string[] {
  return useSyncExternalStore(subscribe, () => recent);
}

/**
 * What the area picker and the sidebar call. On the graph, the URL may still name another
 * area even when `domain` is already current, so the graph is sent to the pick as well.
 */
export function pickArea(domain: string): void {
  setCurrentArea(domain);
  const route = parseHash(window.location.hash);
  if (route.name === "graph" && route.domain !== undefined && route.domain !== domain) {
    navigate(graphHref(domain));
  }
}

/**
 * Once the area list is known, make sure the current area is one of them. A stored or
 * first-run area that doesn't exist is replaced: by a vault's default domain when one is
 * listed, else by the area with the most notes. Unknown domains leave the recent list.
 */
export function reconcileAreas(
  known: readonly { domain: string; noteCount: number }[],
  preferred: readonly string[] = [],
): void {
  if (known.length === 0) return;
  const domains = new Set(known.map((a) => a.domain));
  const nextRecent = recent.filter((d) => domains.has(d));
  let nextCurrent = current;
  if (!domains.has(current)) {
    const fallback =
      preferred.find((d) => domains.has(d)) ??
      [...known].sort((a, b) => b.noteCount - a.noteCount)[0]?.domain;
    if (!fallback) return;
    nextCurrent = fallback;
  }
  if (nextCurrent === current && nextRecent.length === recent.length) return;
  current = nextCurrent;
  recent = nextRecent;
  write(CURRENT_KEY, current);
  write(RECENT_KEY, JSON.stringify(recent));
  for (const l of listeners) l();
}

// "Changed since your last visit": when this area's notes were last marked as reviewed.
// A per-viewer convenience in browser storage; it falls back to null when storage is blocked.
// Opening the Library records nothing, so the date only moves when a person marks the
// area as reviewed.
import { useSyncExternalStore } from "react";
import { parseInstant } from "../../app/dates";

const KEY = "kioku.viewer.library.lastVisit";

/** Domain -> a review recorded in this session (ISO timestamp). */
const marked = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

function readAll(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(
      // Drop anything that isn't a timestamp, so a corrupted entry reads as no visit.
      Object.entries(parsed).filter(
        (e): e is [string, string] => typeof e[1] === "string" && !Number.isNaN(parseInstant(e[1])),
      ),
    );
  } catch {
    return {};
  }
}

/** The last time this area was marked as reviewed (ISO timestamp), or null. */
export function readLastVisit(domain: string): string | null {
  return marked.get(domain) ?? readAll()[domain] ?? null;
}

/** Same as readLastVisit; kept for callers that read it once per render. */
export const lastVisitFor = (domain: string): string | null => readLastVisit(domain);

/** Record that the person reviewed this area's changes now. */
export function markReviewed(domain: string, now: Date = new Date()): void {
  const at = now.toISOString();
  marked.set(domain, at);
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...readAll(), [domain]: at }));
  } catch {
    // Storage blocked: the mark lasts for this session only.
  }
  version += 1;
  for (const l of listeners) l();
}

/** For tests: forget this session's marks. */
export function resetLastVisitSession(): void {
  marked.clear();
  version += 1;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLastVisit(domain: string): string | null {
  useSyncExternalStore(subscribe, () => version);
  return readLastVisit(domain);
}

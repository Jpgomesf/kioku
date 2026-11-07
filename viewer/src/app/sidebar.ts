// Whether the sidebar is a full panel or a rail of icons. It follows the window width: below
// NARROW_QUERY it starts as a rail. The toggle (the sidebar's button or ⌘\) stores a choice
// only when it differs from what the width would pick, so collapsing back on a narrow
// window doesn't leave the sidebar collapsed on a wide one.
import { useSyncExternalStore } from "react";

const KEY = "kioku.viewer.sidebar";

/** Below this width the Library's list and preview need the room the sidebar takes. */
export const NARROW_QUERY = "(max-width: 1299px)";

export type SidebarChoice = "expanded" | "collapsed" | null;

export function isCollapsed(choice: SidebarChoice, narrow: boolean): boolean {
  return choice === null ? narrow : choice === "collapsed";
}

/** The choice after a toggle: null when the new state is what the width picks anyway. */
export function toggledChoice(choice: SidebarChoice, narrow: boolean): SidebarChoice {
  const collapse = !isCollapsed(choice, narrow);
  if (collapse === narrow) return null;
  return collapse ? "collapsed" : "expanded";
}

function readChoice(): SidebarChoice {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === "expanded" || value === "collapsed" ? value : null;
  } catch {
    return null;
  }
}

function writeChoice(value: SidebarChoice): void {
  try {
    if (value === null) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, value);
  } catch {
    // Storage can be blocked (private windows, previews); the choice holds for this session.
  }
}

function narrowQuery(): MediaQueryList | null {
  return typeof window.matchMedia === "function" ? window.matchMedia(NARROW_QUERY) : null;
}

let choice: SidebarChoice = readChoice();
let query: MediaQueryList | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    query = narrowQuery();
    query?.addEventListener?.("change", notify);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      query?.removeEventListener?.("change", notify);
      query = null;
    }
  };
}

function isNarrow(): boolean {
  return (query ?? narrowQuery())?.matches ?? false;
}

function collapsedNow(): boolean {
  return isCollapsed(choice, isNarrow());
}

export function useSidebarCollapsed(): boolean {
  return useSyncExternalStore(subscribe, collapsedNow);
}

export function toggleSidebar(): void {
  choice = toggledChoice(choice, isNarrow());
  writeChoice(choice);
  notify();
}

/** Tests: back to following the window width. */
export function resetSidebar(): void {
  choice = null;
  writeChoice(null);
  notify();
}

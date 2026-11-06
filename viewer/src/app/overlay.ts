// One overlay at a time: opening the palette closes the area switcher and the other way round.
// Also the pieces both overlays share: the open and close animation, listbox movement, the
// platform's command key and a cached area list.
import { type CSSProperties, useEffect, useState, useSyncExternalStore } from "react";
import { type Area, listAreas } from "../api";
import { duration, easing, usePrefersReducedMotion } from "../motion";

export type OverlayName = "palette" | "area-switcher";

interface State {
  open: OverlayName | null;
  /** Grows on every open, so a reopen remounts the overlay with empty state. */
  session: number;
}

let state: State = { open: null, session: 0 };
const listeners = new Set<() => void>();

function set(next: OverlayName | null): void {
  if (next === state.open) return;
  state = { open: next, session: next === null ? state.session : state.session + 1 };
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const openOverlay = (name: OverlayName): void => set(name);

/** Close one overlay, or whichever is open when no name is given. */
export function closeOverlay(name?: OverlayName): void {
  if (name === undefined || state.open === name) set(null);
}

/** Open the overlay, or close it when it is already open. */
export function toggleOverlay(name: OverlayName): void {
  set(state.open === name ? null : name);
}

export const currentOverlay = (): OverlayName | null => state.open;

export function useOverlay(): OverlayName | null {
  return useSyncExternalStore(subscribe, () => state.open);
}

function useSession(): number {
  return useSyncExternalStore(subscribe, () => state.session);
}

/** Move the active option by delta, wrapping at both ends. -1 means nothing is active. */
export function moveActive(index: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  if (index < 0) return delta < 0 ? length - 1 : 0;
  return (((index + delta) % length) + length) % length;
}

/** True on macOS, where ⌘ is the command key and Ctrl edits text. */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** The platform's command modifier alone: ⌘ on macOS, Ctrl elsewhere. */
export function hasCommandKey(event: { metaKey: boolean; ctrlKey: boolean }, mac = isMac()) {
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export interface Presence {
  /** Keep the overlay in the tree: true while open and during the closing fade. */
  mounted: boolean;
  /** True during the closing fade: the panel ignores input. */
  closing: boolean;
  /** Changes on every open; use it as the Dialog's key. */
  session: number;
  /** Inline animation for the panel; empty under reduced motion. */
  style: CSSProperties;
}

/**
 * Fade and scale an overlay in and out over the overlay duration. Under reduced motion, and
 * when the other overlay takes over, it disappears at once, so only one dialog is ever mounted.
 * Needs the k-overlay-in and k-overlay-out keyframes from overlay.css.
 */
export function usePresence(name: OverlayName): Presence {
  const open = useOverlay();
  const session = useSession();
  const reduced = usePrefersReducedMotion();
  const isOpen = open === name;
  const handoff = open !== null && !isOpen;
  const [mounted, setMounted] = useState(isOpen);

  useEffect(() => {
    if (isOpen) {
      setMounted(true);
      return;
    }
    if (reduced || handoff) {
      setMounted(false);
      return;
    }
    const timer = window.setTimeout(() => setMounted(false), duration.overlay);
    return () => window.clearTimeout(timer);
  }, [isOpen, reduced, handoff]);

  const style: CSSProperties = reduced
    ? {}
    : {
        animation: `${isOpen ? "k-overlay-in" : "k-overlay-out"} ${duration.overlay}ms ${easing.standard} both`,
      };
  return {
    mounted: isOpen || (mounted && !handoff && !reduced),
    closing: !isOpen,
    session,
    style,
  };
}

let areas: Promise<Area[]> | null = null;

/** The area list, loaded once and shared by both overlays. */
export function loadAreas(): Promise<Area[]> {
  if (!areas) refreshAreas();
  return areas ?? Promise.resolve([]);
}

/** Load the area list again; the switcher calls this when it opens. */
export function refreshAreas(): Promise<Area[]> {
  const next = listAreas();
  areas = next;
  next.catch(() => {
    if (areas === next) areas = null;
  });
  return next;
}

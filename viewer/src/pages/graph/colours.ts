// Which types the graph colours. Only three hues stay apart for colour-blind readers, so each
// area colours at most three types and every other type is grey. A type keeps its slot until
// the viewer changes it, so its colour never follows its rank when filters or counts change.
import { useCallback, useState } from "react";
import { isKindId, type NoteKind, TOPIC_KIND } from "../../api";

export type ColourSlots = readonly [NoteKind | null, NoteKind | null, NoteKind | null];

/** Named after the hues of --type-1, --type-2 and --type-3. */
export const SLOT_NAMES = ["Blue", "Orange", "Green"] as const;

export const DEFAULT_SLOTS: ColourSlots = ["decision", "question", null];

const KEY_PREFIX = "kioku.viewer.graph.colours.";

function isSlots(value: unknown): value is ColourSlots {
  if (!Array.isArray(value) || value.length !== 3) return false;
  const kinds = value.filter((v) => v !== null);
  return (
    kinds.every((v) => typeof v === "string" && isKindId(v) && v !== TOPIC_KIND) &&
    new Set(kinds).size === kinds.length
  );
}

/** The saved slots for an area, or the default when nothing valid is saved. */
export function readSlots(domain: string): ColourSlots {
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + domain);
    if (raw === null) return DEFAULT_SLOTS;
    const parsed: unknown = JSON.parse(raw);
    return isSlots(parsed) ? parsed : DEFAULT_SLOTS;
  } catch {
    return DEFAULT_SLOTS;
  }
}

export function writeSlots(domain: string, slots: ColourSlots): void {
  try {
    window.localStorage.setItem(KEY_PREFIX + domain, JSON.stringify(slots));
  } catch {
    // Storage can be blocked (private windows, previews); the in-memory picks still work.
  }
}

/** Puts a type in a slot, or clears it with null. A type already in another slot moves. */
export function assignSlot(slots: ColourSlots, index: number, kind: NoteKind | null): ColourSlots {
  if (kind === TOPIC_KIND) return slots;
  const next = slots.map((k, i) => (i === index ? kind : k === kind ? null : k));
  return [next[0] ?? null, next[1] ?? null, next[2] ?? null];
}

/** The slot a type sits in, or -1. */
export function slotOf(slots: ColourSlots, kind: NoteKind): number {
  return slots.indexOf(kind);
}

/** CSS colour for a dot or swatch; text never takes these. */
export function colourFor(slots: ColourSlots, kind: NoteKind): string {
  if (kind === TOPIC_KIND) return "var(--type-topic)";
  const slot = slotOf(slots, kind);
  return slot < 0 ? "var(--type-other)" : `var(--type-${slot + 1})`;
}

/** The area's slots, saved on every change. Remount per area (GraphView is keyed by it). */
export function useColourSlots(
  domain: string,
): [ColourSlots, (index: number, kind: NoteKind | null) => void] {
  const [slots, setSlots] = useState<ColourSlots>(() => readSlots(domain));
  const assign = useCallback(
    (index: number, kind: NoteKind | null) => {
      setSlots((prev) => {
        const next = assignSlot(prev, index, kind);
        writeSlots(domain, next);
        return next;
      });
    },
    [domain],
  );
  return [slots, assign];
}

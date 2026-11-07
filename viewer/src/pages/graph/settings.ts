// The graph's settings, after Obsidian's graph view: filters, colour groups, display and forces,
// plus our own clusters: whether notes gather by colour group or by brain region (the clusters
// their links form), and which of the two colours them.
// They are saved per area in this browser; the panel's open state is saved once per viewer.
import { useCallback, useMemo, useRef, useState } from "react";
import type { KindCount } from "../../api";
import { clampForces, DEFAULT_FORCES, type Forces } from "./forces";
import { paletteColour } from "./palette";

export interface GraphGroup {
  id: string;
  query: string;
  /** #rrggbb */
  color: string;
}

export interface GraphFilters {
  query: string;
  /** Show each tag as its own node linked to the notes that carry it; off by default, as in Obsidian. */
  tags: boolean;
  legacy: boolean;
  suggested: boolean;
  orphans: boolean;
}

/** How many links away a hovered or selected note lights up: 1 is its direct links. */
export type HighlightDepth = 1 | 2 | 3;

export interface GraphDisplay {
  arrows: boolean;
  textFade: number;
  nodeSize: number;
  linkThickness: number;
  topicLabels: boolean;
  highlightDepth: HighlightDepth;
  /** Name each brain region on the canvas. */
  regionLabels: boolean;
}

/** What gathers notes in places of their own: nothing (as in Obsidian), their colour group, or
 * their brain region. */
export type SeparateBy = "none" | "groups" | "regions";
/** Where a note's colour comes from: its colour group, or its brain region. */
export type ColourBy = "groups" | "regions";

export interface GraphClusters {
  separateBy: SeparateBy;
  colourBy: ColourBy;
}

export interface GraphSettings {
  filters: GraphFilters;
  groups: GraphGroup[];
  display: GraphDisplay;
  forces: Forces;
  clusters: GraphClusters;
}

export interface PanelState {
  open: boolean;
  sections: { filters: boolean; groups: boolean; display: boolean; forces: boolean };
}

export interface Range {
  min: number;
  max: number;
  step: number;
}

/** Obsidian's display slider ranges, and the highlight depth's in whole links. */
export const DISPLAY_RANGES: Readonly<
  Record<"textFade" | "nodeSize" | "linkThickness" | "highlightDepth", Range>
> = {
  textFade: { min: -3, max: 3, step: 0.1 },
  nodeSize: { min: 0.1, max: 5, step: 0.1 },
  linkThickness: { min: 0.1, max: 5, step: 0.1 },
  // Three links away already reaches most of a large, well-linked area.
  highlightDepth: { min: 1, max: 3, step: 1 },
};

const SEPARATE_BY: readonly SeparateBy[] = ["none", "groups", "regions"];
const COLOUR_BY: readonly ColourBy[] = ["groups", "regions"];

export const MAX_GROUPS = 100;
/** Long enough for any real query; stops a corrupt entry from bloating every render. */
const MAX_QUERY_LENGTH = 1000;
const HEX = /^#[0-9a-f]{6}$/i;

const SETTINGS_PREFIX = "kioku.viewer.graph.settings.";
const PANEL_KEY = "kioku.viewer.graph.panel";

export function clampNumber(value: unknown, range: Range, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(range.max, Math.max(range.min, value));
}

/** A highlight depth from untrusted input (storage, a slider): a whole number of links, 1 to 3. */
export function toHighlightDepth(value: unknown, fallback: HighlightDepth): HighlightDepth {
  const links = Math.round(clampNumber(value, DISPLAY_RANGES.highlightDepth, fallback));
  return links === 3 ? 3 : links === 2 ? 2 : 1;
}

export function defaultSettings(types: readonly KindCount[]): GraphSettings {
  // Most common first, so the strongest colours go to the types seen most.
  const sorted = [...types].sort((a, b) => b.count - a.count);
  return {
    filters: { query: "", tags: false, legacy: true, suggested: true, orphans: true },
    groups: sorted.slice(0, MAX_GROUPS).map((t, i) => ({
      id: `type-${t.kind}`,
      query: `type:${t.kind}`,
      color: paletteColour(i),
    })),
    display: {
      arrows: false,
      textFade: 0,
      nodeSize: 1,
      linkThickness: 1,
      topicLabels: true,
      // Direct links only, so a hover never lights more than the note's own neighbours.
      highlightDepth: 1,
      regionLabels: true,
    },
    forces: { ...DEFAULT_FORCES },
    // Regions show how the area is organised; colours stay with the types people know.
    clusters: { separateBy: "regions", colourBy: "groups" },
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.slice(0, MAX_QUERY_LENGTH) : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((option) => option === value) ?? fallback;
}

function validGroups(value: unknown): GraphGroup[] | null {
  if (!Array.isArray(value)) return null;
  const groups: GraphGroup[] = [];
  const ids = new Set<string>();
  for (const item of value.slice(0, MAX_GROUPS)) {
    const g = record(item);
    if (typeof g.id !== "string" || g.id === "" || ids.has(g.id)) continue;
    if (typeof g.query !== "string" || typeof g.color !== "string" || !HEX.test(g.color)) continue;
    ids.add(g.id);
    groups.push({ id: g.id, query: text(g.query, ""), color: g.color.toLowerCase() });
  }
  return groups;
}

/**
 * Settings from untrusted input: every field checked, broken ones taken from the fallback.
 * Settings saved before a field existed have no value for it, so they take the fallback's.
 */
export function validateSettings(input: unknown, fallback: GraphSettings): GraphSettings {
  const source = record(input);
  const f = record(source.filters);
  const d = record(source.display);
  const c = record(source.clusters);
  const base = fallback;
  return {
    filters: {
      query: text(f.query, base.filters.query),
      tags: bool(f.tags, base.filters.tags),
      legacy: bool(f.legacy, base.filters.legacy),
      suggested: bool(f.suggested, base.filters.suggested),
      orphans: bool(f.orphans, base.filters.orphans),
    },
    groups: validGroups(source.groups) ?? base.groups,
    display: {
      arrows: bool(d.arrows, base.display.arrows),
      textFade: clampNumber(d.textFade, DISPLAY_RANGES.textFade, base.display.textFade),
      nodeSize: clampNumber(d.nodeSize, DISPLAY_RANGES.nodeSize, base.display.nodeSize),
      linkThickness: clampNumber(
        d.linkThickness,
        DISPLAY_RANGES.linkThickness,
        base.display.linkThickness,
      ),
      topicLabels: bool(d.topicLabels, base.display.topicLabels),
      highlightDepth: toHighlightDepth(d.highlightDepth, base.display.highlightDepth),
      regionLabels: bool(d.regionLabels, base.display.regionLabels),
    },
    forces: clampForces(source.forces),
    clusters: {
      separateBy: oneOf(c.separateBy, SEPARATE_BY, base.clusters.separateBy),
      colourBy: oneOf(c.colourBy, COLOUR_BY, base.clusters.colourBy),
    },
  };
}

function readJson(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be blocked (private windows, previews); the settings still work in memory.
  }
}

function removeKey(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // As above.
  }
}

function sameGroups(a: readonly GraphGroup[], b: readonly GraphGroup[]): boolean {
  return (
    a.length === b.length &&
    a.every((g, i) => g.id === b[i]?.id && g.query === b[i]?.query && g.color === b[i]?.color)
  );
}

/**
 * The area's settings. Until the viewer changes something, nothing is saved, so the default
 * groups follow the area's types as they load. Edits are kept per area, so switching areas
 * never shows one area's settings in another.
 */
export function useGraphSettings(
  domain: string,
  types: readonly KindCount[] | null,
): { settings: GraphSettings; update: (next: GraphSettings) => void; reset: () => void } {
  // What was saved, re-validated against the current defaults so unedited groups keep following the types.
  const [edited, setEdited] = useState<{ domain: string; saved: unknown } | null>(null);
  // Bumped on reset so the stored value is read again after it is removed.
  const [generation, setGeneration] = useState(0);

  const defaults = useMemo(() => defaultSettings(types ?? []), [types]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: generation re-reads storage after a reset
  const stored = useMemo(() => readJson(SETTINGS_PREFIX + domain), [domain, generation]);

  // Validation builds a new groups array each time; keep the last one when its content is
  // unchanged, so a force or display slider step does not rebuild the graph's colours and scene.
  const lastGroups = useRef<GraphGroup[] | null>(null);
  const settings = useMemo(() => {
    const next =
      edited !== null && edited.domain === domain
        ? validateSettings(edited.saved, defaults)
        : stored === undefined
          ? defaults
          : validateSettings(stored, defaults);
    const prev = lastGroups.current;
    if (prev !== null && prev !== next.groups && sameGroups(prev, next.groups))
      return { ...next, groups: prev };
    lastGroups.current = next.groups;
    return next;
  }, [edited, domain, stored, defaults]);

  const update = useCallback(
    (next: GraphSettings) => {
      const valid = validateSettings(next, defaults);
      // Untouched default groups are left out, so types that load or appear later still get a
      // group. Everything else is kept, so a field added later is saved without a change here.
      const { groups, ...rest } = valid;
      const saved: Partial<GraphSettings> = sameGroups(groups, defaults.groups) ? rest : valid;
      writeJson(SETTINGS_PREFIX + domain, saved);
      setEdited({ domain, saved });
    },
    [domain, defaults],
  );

  const reset = useCallback(() => {
    removeKey(SETTINGS_PREFIX + domain);
    setEdited(null);
    setGeneration((g) => g + 1);
  }, [domain]);

  return { settings, update, reset };
}

/**
 * The panel opens by default, so people find the settings without looking for the gear. Only
 * Forces starts open, with the separation, so the box fits the app's smallest window and leaves
 * most of the graph in view; Display and Forces together already run past the default 1440x900
 * window.
 */
const DEFAULT_PANEL: PanelState = {
  open: true,
  sections: { filters: false, groups: false, display: false, forces: true },
};

/**
 * Saved with the panel state. The first version kept the panel closed and every section open by
 * default, so what it saved says little about the layout wanted now: its saves start from the
 * defaults once, and only a save from this version keeps the panel closed or a section changed.
 */
const PANEL_VERSION = 2;

function readPanel(): PanelState {
  const stored = record(readJson(PANEL_KEY));
  // An older save counts as none (see PANEL_VERSION).
  const source: Record<string, unknown> = stored.version === PANEL_VERSION ? stored : {};
  const s = record(source.sections);
  const d = DEFAULT_PANEL.sections;
  return {
    open: bool(source.open, DEFAULT_PANEL.open),
    sections: {
      filters: bool(s.filters, d.filters),
      groups: bool(s.groups, d.groups),
      display: bool(s.display, d.display),
      forces: bool(s.forces, d.forces),
    },
  };
}

/** Whether the panel and each section are open, remembered for this viewer across areas. */
export function usePanelState(): [PanelState, (next: PanelState) => void] {
  const [panel, setPanel] = useState<PanelState>(readPanel);
  const update = useCallback((next: PanelState) => {
    writeJson(PANEL_KEY, { ...next, version: PANEL_VERSION });
    setPanel(next);
  }, []);
  return [panel, update];
}

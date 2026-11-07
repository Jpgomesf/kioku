// The graph's forces, after Obsidian's graph view: the same four controls, ranges and
// defaults. The simulation (layout.worker.ts) reads them; the settings panel edits them.

export interface Forces {
  /** Pull towards the centre. */
  center: number;
  /** Push between every pair of notes. */
  repel: number;
  /** How hard a link pulls its two notes towards the link distance. */
  link: number;
  /** The length a link settles at, in world units. */
  distance: number;
}

export interface ForceRange {
  min: number;
  max: number;
  step: number;
}

/** Obsidian's defaults. */
export const DEFAULT_FORCES: Readonly<Forces> = { center: 0.52, repel: 10, link: 1, distance: 250 };

/** Obsidian's slider ranges. */
export const FORCE_RANGES: Readonly<Record<keyof Forces, ForceRange>> = {
  center: { min: 0, max: 1, step: 0.01 },
  repel: { min: 0, max: 20, step: 0.1 },
  link: { min: 0, max: 1, step: 0.01 },
  distance: { min: 30, max: 500, step: 1 },
};

const KEYS = Object.keys(FORCE_RANGES) as Array<keyof Forces>;

/** Forces from untrusted input (storage, a slider): each value finite and in range,
 * missing or broken ones replaced by the default. */
export function clampForces(input: unknown): Forces {
  const source =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const out = { ...DEFAULT_FORCES };
  for (const key of KEYS) {
    const value = source[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const { min, max } = FORCE_RANGES[key];
    out[key] = Math.min(max, Math.max(min, value));
  }
  return out;
}

export function sameForces(a: Forces, b: Forces): boolean {
  return KEYS.every((key) => a[key] === b[key]);
}

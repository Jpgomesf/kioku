import { describe, expect, it } from "vitest";
import { clampForces, DEFAULT_FORCES, FORCE_RANGES, sameForces } from "./forces";

describe("forces", () => {
  it("keeps values inside Obsidian's ranges", () => {
    expect(clampForces({ center: 2, repel: -1, link: 0.5, distance: 9999 })).toEqual({
      center: FORCE_RANGES.center.max,
      repel: FORCE_RANGES.repel.min,
      link: 0.5,
      distance: FORCE_RANGES.distance.max,
    });
  });

  it("replaces missing or broken values with the defaults", () => {
    expect(clampForces(null)).toEqual(DEFAULT_FORCES);
    expect(clampForces("junk")).toEqual(DEFAULT_FORCES);
    expect(clampForces({ center: Number.NaN, repel: "5", link: Number.POSITIVE_INFINITY })).toEqual(
      DEFAULT_FORCES,
    );
  });

  it("compares by value", () => {
    expect(sameForces(clampForces({}), { ...DEFAULT_FORCES })).toBe(true);
    expect(sameForces(DEFAULT_FORCES, { ...DEFAULT_FORCES, repel: 11 })).toBe(false);
  });
});

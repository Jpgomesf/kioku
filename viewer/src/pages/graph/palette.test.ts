import { describe, expect, it } from "vitest";
import { DISTINCT_COLOURS, paletteColour } from "./palette";

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

function distance(a: string, b: string): number {
  let sum = 0;
  for (const i of [1, 3, 5]) {
    const d = Number.parseInt(a.slice(i, i + 2), 16) - Number.parseInt(b.slice(i, i + 2), 16);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function oklab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function perceptualDistance(a: string, b: string): number {
  const [x, y] = [oklab(a), oklab(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

const colours = Array.from({ length: 40 }, (_, i) => paletteColour(i));

describe("paletteColour", () => {
  it("gives valid hex and is deterministic", () => {
    for (const [i, c] of colours.entries()) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/);
      expect(paletteColour(i)).toBe(c);
    }
    expect(paletteColour(Number.NaN)).toBe(colours[0]);
    expect(paletteColour(-3)).toBe(colours[0]);
  });

  it("keeps neighbours apart", () => {
    for (let i = 1; i < colours.length; i++) {
      expect(distance(colours[i] ?? "", colours[i - 1] ?? "")).toBeGreaterThan(60);
    }
  });

  it("keeps every pair of the first DISTINCT_COLOURS apart, not only neighbours", () => {
    expect(DISTINCT_COLOURS).toBe(12);
    let min = Number.POSITIVE_INFINITY;
    for (let i = 0; i < DISTINCT_COLOURS; i++) {
      for (let j = i + 1; j < DISTINCT_COLOURS; j++) {
        min = Math.min(min, perceptualDistance(colours[i] ?? "", colours[j] ?? ""));
      }
    }
    expect(min).toBeGreaterThan(0.08);
  });

  it("reads at 3:1 on both canvases", () => {
    for (const c of colours) {
      expect(contrast(c, "#f6f6f3")).toBeGreaterThanOrEqual(3);
      expect(contrast(c, "#111214")).toBeGreaterThanOrEqual(3);
    }
  });
});

import { describe, expect, it } from "vitest";
import { DEFAULT_FORCES, type Forces } from "./forces";
import { Simulation, seededRandom, settle } from "./simulation";

type Pair = readonly [number, number];

/** A seeded random graph with a few busy hubs, like a real area. */
function randomGraph(n: number, m: number, seed = 3): Pair[] {
  const next = seededRandom(seed);
  const edges: Pair[] = [];
  for (let k = 0; k < m; k += 1) edges.push([Math.floor(n * next() ** 2), Math.floor(n * next())]);
  return edges;
}

const finite = (xs: Float64Array) => xs.every((v) => Number.isFinite(v));

/** Mean distance from the centroid. */
function spread(xs: Float64Array, ys: Float64Array): number {
  const n = xs.length;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i += 1) {
    cx += xs[i] as number;
    cy += ys[i] as number;
  }
  cx /= n;
  cy /= n;
  let s = 0;
  for (let i = 0; i < n; i += 1) s += Math.hypot((xs[i] as number) - cx, (ys[i] as number) - cy);
  return s / n;
}

function meanLink(xs: Float64Array, ys: Float64Array, edges: readonly Pair[]): number {
  let s = 0;
  for (const [a, b] of edges)
    s += Math.hypot((xs[a] ?? 0) - (xs[b] ?? 0), (ys[a] ?? 0) - (ys[b] ?? 0));
  return s / edges.length;
}

const input = { n: 200, edges: randomGraph(200, 400), seed: 5 };
const run = (forces: Partial<Forces>) => settle(input, { ...DEFAULT_FORCES, ...forces });

describe("simulation", () => {
  it("is deterministic for a seed", () => {
    const a = run({});
    const b = run({});
    expect(Array.from(a.xs)).toEqual(Array.from(b.xs));
    const c = settle({ ...input, seed: 6 }, DEFAULT_FORCES);
    expect(Array.from(c.xs)).not.toEqual(Array.from(a.xs));
  });

  it("stays finite on the edge cases", () => {
    expect(settle({ n: 0, edges: [], seed: 1 }, DEFAULT_FORCES).xs.length).toBe(0);
    const one = settle({ n: 1, edges: [[0, 0]], seed: 1 }, DEFAULT_FORCES);
    expect(finite(one.xs) && finite(one.ys)).toBe(true);
    // Duplicate, self and out-of-range links, isolated notes.
    const odd = settle(
      {
        n: 6,
        edges: [
          [0, 1],
          [1, 0],
          [0, 1],
          [2, 2],
          [3, 99],
          [-1, 2],
        ],
        seed: 2,
      },
      DEFAULT_FORCES,
    );
    expect(finite(odd.xs) && finite(odd.ys)).toBe(true);
    // Every note on one spot.
    const n = 30;
    const same = {
      xs: new Float64Array(n),
      ys: new Float64Array(n),
      known: new Uint8Array(n).fill(1),
    };
    const crowd = settle({ n, edges: randomGraph(n, 40), seed: 3, initial: same }, DEFAULT_FORCES);
    expect(finite(crowd.xs) && finite(crowd.ys)).toBe(true);
    expect(spread(crowd.xs, crowd.ys)).toBeGreaterThan(1);
    // Extreme forces.
    for (const forces of [
      { center: 0, repel: 0, link: 0, distance: 30 },
      { center: 1, repel: 20, link: 1, distance: 500 },
    ]) {
      const r = settle(input, forces);
      expect(finite(r.xs) && finite(r.ys)).toBe(true);
    }
  });

  it("spreads further with a stronger repel", () => {
    const weak = run({ repel: 2 });
    const strong = run({ repel: 18 });
    expect(spread(strong.xs, strong.ys)).toBeGreaterThan(spread(weak.xs, weak.ys) * 1.3);
  });

  it("lengthens links with a longer link distance", () => {
    const short = run({ distance: 40 });
    const long = run({ distance: 450 });
    expect(meanLink(long.xs, long.ys, input.edges)).toBeGreaterThan(
      meanLink(short.xs, short.ys, input.edges) * 1.3,
    );
  });

  it("shrinks the spread with a stronger center force", () => {
    const loose = run({ center: 0.05 });
    const tight = run({ center: 1 });
    expect(spread(tight.xs, tight.ys)).toBeLessThan(spread(loose.xs, loose.ys) * 0.9);
  });

  it("keeps known notes near their old spots on a warm start", () => {
    const before = run({});
    const known = new Uint8Array(input.n).fill(1);
    known[7] = 0; // a new note
    const sim = new Simulation(
      { ...input, initial: { xs: before.xs.slice(), ys: before.ys.slice(), known } },
      DEFAULT_FORCES,
    );
    expect(sim.alpha).toBeCloseTo(0.3);
    while (!sim.settled) sim.tick();
    const scale = spread(before.xs, before.ys);
    let moved = 0;
    for (let i = 0; i < input.n; i += 1) {
      if (i === 7) continue;
      moved += Math.hypot(
        (sim.xs[i] as number) - (before.xs[i] as number),
        (sim.ys[i] as number) - (before.ys[i] as number),
      );
    }
    expect(moved / (input.n - 1)).toBeLessThan(scale * 0.25);
  });

  it("reheats on new forces and settles again", () => {
    const sim = new Simulation(input, DEFAULT_FORCES);
    while (!sim.settled) sim.tick();
    sim.setForces({ ...DEFAULT_FORCES, repel: 15 });
    expect(sim.settled).toBe(false);
    expect(sim.alpha).toBeGreaterThanOrEqual(0.3);
    let ticks = 0;
    while (!sim.settled && ticks < 1000) {
      sim.tick();
      ticks += 1;
    }
    expect(sim.settled).toBe(true);
  });

  it("settles 2,000 notes and 16,000 links in time, without a dense core", () => {
    const n = 2000;
    const started = performance.now();
    const { xs, ys } = settle({ n, edges: randomGraph(n, 16000), seed: 1 }, DEFAULT_FORCES);
    expect(performance.now() - started).toBeLessThan(8000);
    expect(finite(xs) && finite(ys)).toBe(true);
    // The inner quarter of the radius holds about what an even disc would (6.25%).
    const radii = Array.from(xs, (x, i) => Math.hypot(x, ys[i] as number)).sort((a, b) => a - b);
    const outer = radii[Math.floor(n * 0.95)] as number;
    const inner = radii.filter((r) => r < outer / 4).length / n;
    expect(inner).toBeLessThan(0.12);
  }, 20000);

  it("lengthens links with link distance on a big area too", () => {
    // On big areas repulsion used to outweigh the springs, so the slider did nothing.
    const n = 1500;
    const edges = randomGraph(n, 6000, 9);
    const at = (distance: number) => {
      const { xs, ys } = settle({ n, edges, seed: 2 }, { ...DEFAULT_FORCES, distance });
      return meanLink(xs, ys, edges);
    };
    expect(at(500)).toBeGreaterThan(at(30) * 1.3);
  }, 20000);
});

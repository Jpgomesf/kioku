import { describe, expect, it } from "vitest";
import { DEFAULT_FORCES, type Forces } from "./forces";
import { packClusters, Simulation, seededRandom, settle } from "./simulation";

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

/** Each cluster's centre and root-mean-square radius. */
function clusterStats(xs: Float64Array, ys: Float64Array, clusters: Int32Array) {
  const count = Math.max(...clusters) + 1;
  const stats = Array.from({ length: count }, () => ({ x: 0, y: 0, r: 0, size: 0 }));
  clusters.forEach((c, i) => {
    const s = stats[c];
    if (!s) return;
    s.x += xs[i] as number;
    s.y += ys[i] as number;
    s.size += 1;
  });
  for (const s of stats) {
    s.x /= s.size;
    s.y /= s.size;
  }
  clusters.forEach((c, i) => {
    const s = stats[c];
    if (s) s.r += ((xs[i] as number) - s.x) ** 2 + ((ys[i] as number) - s.y) ** 2;
  });
  for (const s of stats) s.r = Math.sqrt(s.r / s.size);
  return stats;
}

function meanCentreDistance(stats: ReturnType<typeof clusterStats>): number {
  let total = 0;
  let pairs = 0;
  stats.forEach((a, i) => {
    for (const b of stats.slice(i + 1)) {
      total += Math.hypot(a.x - b.x, a.y - b.y);
      pairs += 1;
    }
  });
  return total / pairs;
}

/** The share of notes whose nearest other note is in the same cluster. */
function purity(xs: Float64Array, ys: Float64Array, clusters: Int32Array): number {
  let same = 0;
  for (let i = 0; i < xs.length; i += 1) {
    let best = Number.POSITIVE_INFINITY;
    let nearest = -1;
    for (let j = 0; j < xs.length; j += 1) {
      if (j === i) continue;
      const d =
        ((xs[i] as number) - (xs[j] as number)) ** 2 + ((ys[i] as number) - (ys[j] as number)) ** 2;
      if (d < best) {
        best = d;
        nearest = j;
      }
    }
    if (clusters[nearest] === clusters[i]) same += 1;
  }
  return same / xs.length;
}

/** Clusters whose notes link mostly inside: `size` notes each, numbered cluster by cluster. */
function plantedGraph(clusters: number, size: number, seed = 2) {
  const next = seededRandom(seed);
  const n = clusters * size;
  const edges: Pair[] = [];
  for (let i = 0; i < n; i += 1) {
    const start = Math.floor(i / size) * size;
    for (let k = 0; k < 5; k += 1) edges.push([i, start + Math.floor(next() * size)]);
    if (next() < 0.5) edges.push([i, Math.floor(next() * n)]);
  }
  const truth = Int32Array.from({ length: n }, (_, i) => Math.floor(i / size));
  return { n, edges, truth };
}

/** The graph without the `hidden` notes, renumbered in order, as a filter leaves it. */
function without(n: number, edges: readonly Pair[], hidden: ReadonlySet<number>) {
  const keep = Array.from({ length: n }, (_, i) => i).filter((i) => !hidden.has(i));
  const at = new Map(keep.map((i, k) => [i, k]));
  const kept: Pair[] = [];
  for (const [a, b] of edges) {
    const p = at.get(a);
    const q = at.get(b);
    if (p !== undefined && q !== undefined) kept.push([p, q]);
  }
  return { keep, edges: kept };
}

/** Mean distance between where the same notes are in two layouts. */
function travel(
  from: { xs: Float64Array; ys: Float64Array },
  to: { xs: Float64Array; ys: Float64Array },
  pairs: ReadonlyArray<readonly [number, number]> = Array.from(from.xs, (_, i) => [i, i] as const),
): number {
  let total = 0;
  for (const [i, j] of pairs) {
    total += Math.hypot(
      (to.xs[j] as number) - (from.xs[i] as number),
      (to.ys[j] as number) - (from.ys[i] as number),
    );
  }
  return total / pairs.length;
}

const everyNote = (n: number) => new Uint8Array(n).fill(1);

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
      { center: 0, repel: 0, link: 0, distance: 30, separation: 0 },
      { center: 1, repel: 20, link: 1, distance: 500, separation: 1 },
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

describe("separation", () => {
  // The hard case: groups the links ignore, as colour groups can be.
  const n = 600;
  const edges = randomGraph(n, 2400, 4);
  const pick = seededRandom(8);
  const groups = Int32Array.from({ length: n }, () => Math.floor(pick() * 6));
  const runWith = (separation: number, clusters: Int32Array | undefined = groups) =>
    settle({ n, edges, seed: 5, clusters }, { ...DEFAULT_FORCES, separation });

  it("pulls clusters apart", () => {
    const mixed = runWith(0);
    const apart = runWith(0.5);
    const far = runWith(1);
    const distance = (r: { xs: Float64Array; ys: Float64Array }) =>
      meanCentreDistance(clusterStats(r.xs, r.ys, groups)) / spread(r.xs, r.ys);
    expect(distance(apart)).toBeGreaterThan(distance(mixed) * 4);
    expect(distance(far)).toBeGreaterThan(distance(mixed) * 4);
    // Sorted: most notes sit next to a note of their own group.
    expect(purity(mixed.xs, mixed.ys, groups)).toBeLessThan(0.3);
    expect(purity(apart.xs, apart.ys, groups)).toBeGreaterThan(0.6);
    expect(purity(far.xs, far.ys, groups)).toBeGreaterThan(purity(apart.xs, apart.ys, groups));
  });

  it("changes nothing at 0", () => {
    const plain = runWith(0, undefined);
    const clustered = runWith(0);
    expect(Array.from(clustered.xs)).toEqual(Array.from(plain.xs));
    expect(Array.from(clustered.ys)).toEqual(Array.from(plain.ys));
  });

  it("opens gaps between regions at 1 without collapsing them", () => {
    const { n: count, edges: links, truth } = plantedGraph(6, 100);
    const at = (separation: number) => {
      const { xs, ys } = settle(
        { n: count, edges: links, seed: 3, clusters: truth },
        { ...DEFAULT_FORCES, separation },
      );
      return clusterStats(xs, ys, truth);
    };
    // How far apart neighbouring clusters are, against their size: 1 is just touching.
    const gap = (stats: ReturnType<typeof clusterStats>) =>
      Math.min(
        ...stats.map((a) =>
          Math.min(
            ...stats
              .filter((b) => b !== a)
              .map((b) => Math.hypot(a.x - b.x, a.y - b.y) / (Math.SQRT2 * (a.r + b.r))),
          ),
        ),
      );
    const radius = (stats: ReturnType<typeof clusterStats>) =>
      stats.reduce((sum, c) => sum + c.r, 0) / stats.length;
    const loose = at(0);
    const tight = at(1);
    expect(gap(tight)).toBeGreaterThan(Math.max(1, gap(loose) * 1.3));
    expect(radius(tight)).toBeGreaterThan(radius(loose) * 0.4);
  });

  it("sorts a settled layout when clusters arrive, without a restart", () => {
    const sim = new Simulation({ n, edges, seed: 5 }, DEFAULT_FORCES);
    while (!sim.settled) sim.tick();
    sim.setClusters(groups);
    expect(sim.settled).toBe(false);
    expect(sim.alpha).toBeCloseTo(0.3);
    while (!sim.settled) sim.tick();
    expect(purity(sim.xs, sim.ys, groups)).toBeGreaterThan(0.6);
    // Back to no clusters: the same simulation reheats and mixes them again.
    sim.setClusters(null);
    expect(sim.settled).toBe(false);
  });

  it("stays still when clusters change with no separation", () => {
    const sim = new Simulation({ n, edges, seed: 5 }, { ...DEFAULT_FORCES, separation: 0 });
    while (!sim.settled) sim.tick();
    sim.setClusters(groups);
    expect(sim.settled).toBe(true);
  });

  it("takes any cluster numbers and ignores the rest", () => {
    // Sparse numbers, -1, and an array shorter than the notes.
    const odd = Int32Array.from({ length: n - 50 }, (_, i) => (i % 7 === 0 ? -1 : (i % 3) * 40));
    const r = runWith(1, odd);
    expect(finite(r.xs) && finite(r.ys)).toBe(true);
    // No note in a cluster: no force at all.
    const none = runWith(1, new Int32Array(n).fill(-1));
    expect(Array.from(none.xs)).toEqual(Array.from(runWith(0, undefined).xs));
  });

  it("does nothing with one cluster for every note, but gathers one beside the rest", () => {
    // Every note of one type is one colour group: the pull would only shrink the graph.
    const plain = runWith(0, undefined);
    const all = runWith(1, new Int32Array(n).fill(3));
    expect(Array.from(all.xs)).toEqual(Array.from(plain.xs));
    expect(Array.from(all.ys)).toEqual(Array.from(plain.ys));
    // A single group among notes in none is still pulled together.
    const one = Int32Array.from(groups, (g) => (g === 0 ? 0 : -1));
    const radius = (r: { xs: Float64Array; ys: Float64Array }) =>
      (clusterStats(r.xs, r.ys, one)[0] as { r: number }).r;
    expect(radius(runWith(1, one))).toBeLessThan(radius(runWith(0, one)) * 0.8);
  });
});

describe("separation over a laid-out graph", () => {
  // Regions of the same size, as Louvain often finds, so their size ranks swap easily.
  const { n, edges, truth } = plantedGraph(6, 100);

  it("keeps clusters where they are when a filter renumbers them", () => {
    const before = settle({ n, edges, seed: 3, clusters: truth }, DEFAULT_FORCES);
    // Hiding a few notes of region 0 makes it the smallest: regions found afresh are ranked,
    // and numbered, differently, largest first.
    const { keep, edges: kept } = without(n, edges, new Set([0, 1, 2, 3, 4, 5, 6, 7]));
    const renumbered = Int32Array.from(keep, (i) => ((truth[i] as number) + 5) % 6);
    const after = settle(
      {
        n: keep.length,
        edges: kept,
        seed: 3,
        clusters: renumbered,
        initial: {
          xs: Float64Array.from(keep, (i) => before.xs[i] as number),
          ys: Float64Array.from(keep, (i) => before.ys[i] as number),
          known: everyNote(keep.length),
        },
      },
      DEFAULT_FORCES,
    );
    const moved = travel(
      before,
      after,
      keep.map((i, k) => [i, k] as const),
    );
    expect(moved).toBeLessThan(spread(before.xs, before.ys) * 0.15);
    expect(purity(after.xs, after.ys, renumbered)).toBeGreaterThan(0.95);
  });

  it("keeps clusters where they are when separation turns on over a settled layout", () => {
    // The slider leaving 0, and Separate by going from None to the regions.
    const fromSlider = new Simulation(
      { n, edges, seed: 3, clusters: truth },
      { ...DEFAULT_FORCES, separation: 0 },
    );
    const fromNone = new Simulation({ n, edges, seed: 3 }, DEFAULT_FORCES);
    for (const [sim, turnOn] of [
      [fromSlider, () => fromSlider.setForces(DEFAULT_FORCES)],
      [fromNone, () => fromNone.setClusters(truth)],
    ] as const) {
      while (!sim.settled) sim.tick();
      const before = clusterStats(sim.xs, sim.ys, truth);
      const scale = spread(sim.xs, sim.ys);
      const mixed = purity(sim.xs, sim.ys, truth);
      turnOn();
      while (!sim.settled) sim.tick();
      const after = clusterStats(sim.xs, sim.ys, truth);
      // Each region moves a little to open the gaps; none crosses the picture.
      const moved = before.map((b, g) =>
        Math.hypot(b.x - (after[g]?.x ?? 0), b.y - (after[g]?.y ?? 0)),
      );
      expect(Math.max(...moved)).toBeLessThan(scale * 0.4);
      expect(purity(sim.xs, sim.ys, truth)).toBeGreaterThan(Math.max(0.95, mixed));
    }
  });

  it("carries on from the anchors it is handed, as if it had never stopped", () => {
    const first = new Simulation({ n, edges, seed: 3, clusters: truth }, DEFAULT_FORCES);
    while (!first.settled) first.tick();
    const anchors = first.anchors() ?? undefined;
    expect(anchors).toHaveLength(12);
    // The same layout restarted at rest, as the page does to drag a note of a cached layout.
    const again = new Simulation(
      {
        n,
        edges,
        seed: 3,
        clusters: truth,
        initial: { xs: first.xs.slice(), ys: first.ys.slice(), known: everyNote(n), anchors },
      },
      DEFAULT_FORCES,
    );
    again.reheat(0);
    // The same drag on both.
    for (const sim of [first, again]) {
      const x = sim.xs[0] as number;
      const y = sim.ys[0] as number;
      for (let t = 0; t < 20; t += 1) {
        sim.pin(0, x + 10 * t, y);
        sim.setAlphaTarget(0.3);
        sim.tick();
      }
      sim.unpin(0);
      sim.setAlphaTarget(0);
      while (!sim.settled) sim.tick();
    }
    // Finding anchors anew from the notes would shift every region a little.
    expect(travel(first, again)).toBeLessThan(spread(first.xs, first.ys) * 0.002);
  });

  it("hands out anchors only while separating, and ignores ones that do not fit", () => {
    expect(new Simulation(input, DEFAULT_FORCES).anchors()).toBeNull();
    const off = new Simulation(
      { n, edges, seed: 3, clusters: truth },
      { ...DEFAULT_FORCES, separation: 0 },
    );
    expect(off.anchors()).toBeNull();
    const settled = settle({ n, edges, seed: 3, clusters: truth }, DEFAULT_FORCES);
    for (const anchors of [
      new Float64Array(4),
      Float64Array.of(...new Array(12).fill(Number.NaN)),
    ]) {
      const r = settle(
        {
          n,
          edges,
          seed: 3,
          clusters: truth,
          initial: { xs: settled.xs, ys: settled.ys, known: everyNote(n), anchors },
        },
        DEFAULT_FORCES,
      );
      expect(finite(r.xs) && finite(r.ys)).toBe(true);
      expect(purity(r.xs, r.ys, truth)).toBeGreaterThan(0.95);
    }
  });
});

describe("packClusters", () => {
  it("gives each cluster a circle by its size, with no overlaps, about the centre of mass", () => {
    const sizes = [50, 10, 200, 1, 30, 30, 7, 120, 3, 3];
    const p = packClusters(sizes);
    const at = (g: number) => ({ x: p[2 * g] as number, y: p[2 * g + 1] as number });
    for (let a = 0; a < sizes.length; a += 1) {
      for (let b = a + 1; b < sizes.length; b += 1) {
        const d = Math.hypot(at(a).x - at(b).x, at(a).y - at(b).y);
        expect(d).toBeGreaterThan(
          Math.sqrt(sizes[a] as number) + Math.sqrt(sizes[b] as number) - 1e-6,
        );
      }
    }
    let x = 0;
    let y = 0;
    sizes.forEach((s, g) => {
      x += s * at(g).x;
      y += s * at(g).y;
    });
    expect(Math.abs(x) + Math.abs(y)).toBeLessThan(1e-6);
    // The largest sits nearer the middle than the smallest.
    expect(Math.hypot(at(2).x, at(2).y)).toBeLessThan(Math.hypot(at(3).x, at(3).y));
  });

  it("handles none, one and two clusters", () => {
    expect(packClusters([])).toHaveLength(0);
    expect(Array.from(packClusters([5]))).toEqual([0, 0]);
    const two = packClusters([4, 4]);
    expect(
      Math.hypot((two[0] as number) - (two[2] as number), (two[1] as number) - (two[3] as number)),
    ).toBeCloseTo(4);
  });
});

describe("dragging", () => {
  /** The note with the most links in `input`, and the notes it links to. */
  function hub() {
    const links = new Map<number, Set<number>>();
    for (const [a, b] of input.edges) {
      if (a === b) continue;
      links.set(a, (links.get(a) ?? new Set()).add(b));
      links.set(b, (links.get(b) ?? new Set()).add(a));
    }
    const [index, neighbours] = [...links.entries()].sort((p, q) => q[1].size - p[1].size)[0] as [
      number,
      Set<number>,
    ];
    return { index, neighbours: [...neighbours] };
  }

  function settled(): Simulation {
    const sim = new Simulation(input, DEFAULT_FORCES);
    while (!sim.settled) sim.tick();
    return sim;
  }

  const meanDistance = (sim: Simulation, notes: number[], x: number, y: number) =>
    notes.reduce(
      (sum, i) => sum + Math.hypot((sim.xs[i] as number) - x, (sim.ys[i] as number) - y),
      0,
    ) / notes.length;

  it("holds a pinned note while its neighbours follow and the rest gives way", () => {
    const sim = settled();
    const { index, neighbours } = hub();
    const others = Array.from({ length: input.n }, (_, i) => i).filter(
      (i) => i !== index && !neighbours.includes(i),
    );
    const x = (sim.xs[index] as number) + spread(sim.xs, sim.ys);
    const y = sim.ys[index] as number;
    const before = meanDistance(sim, neighbours, x, y);
    const start = { xs: sim.xs.slice(), ys: sim.ys.slice() };
    expect(sim.pin(index, x, y)).toBe(true);
    sim.setAlphaTarget(0.3);
    // Held warm from rest, as in d3: live at once, never settling while held.
    expect(sim.settled).toBe(false);
    for (let t = 0; t < 120; t += 1) {
      sim.tick();
      expect([sim.xs[index], sim.ys[index]]).toEqual([x, y]);
    }
    expect(sim.settled).toBe(false);
    expect(sim.alpha).toBeGreaterThan(0.2);
    expect(meanDistance(sim, neighbours, x, y)).toBeLessThan(before * 0.85);
    // The neighbours move more than the notes it does not link to.
    const moved = (notes: number[]) =>
      notes.reduce(
        (sum, i) =>
          sum +
          Math.hypot(
            (sim.xs[i] as number) - (start.xs[i] as number),
            (sim.ys[i] as number) - (start.ys[i] as number),
          ),
        0,
      ) / notes.length;
    expect(moved(neighbours)).toBeGreaterThan(moved(others) * 1.5);
  });

  it("settles again after release", () => {
    const sim = settled();
    const { index } = hub();
    const x = (sim.xs[index] as number) + 300;
    const y = (sim.ys[index] as number) - 200;
    sim.pin(index, x, y);
    sim.setAlphaTarget(0.3);
    for (let t = 0; t < 60; t += 1) sim.tick();
    sim.unpin(index);
    sim.setAlphaTarget(0);
    let ticks = 0;
    while (!sim.settled && ticks < 1000) {
      sim.tick();
      ticks += 1;
    }
    expect(sim.settled).toBe(true);
    expect(ticks).toBeLessThan(400);
    expect(finite(sim.xs) && finite(sim.ys)).toBe(true);
    // Free again: the forces pulled it back towards its neighbours.
    expect(
      Math.hypot((sim.xs[index] as number) - x, (sim.ys[index] as number) - y),
    ).toBeGreaterThan(10);
  });

  it("ignores pins it cannot apply", () => {
    const sim = new Simulation(input, DEFAULT_FORCES);
    expect(sim.pin(-1, 0, 0)).toBe(false);
    expect(sim.pin(input.n, 0, 0)).toBe(false);
    expect(sim.pin(1.5, 0, 0)).toBe(false);
    expect(sim.pin(0, Number.NaN, 0)).toBe(false);
    expect(() => sim.unpin(99999)).not.toThrow();
    sim.setAlphaTarget(Number.NaN);
    expect(sim.alphaTarget).toBe(0);
    sim.setAlphaTarget(5);
    expect(sim.alphaTarget).toBe(1);
  });
});

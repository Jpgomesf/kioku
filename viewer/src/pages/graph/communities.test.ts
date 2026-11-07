import { describe, expect, it } from "vitest";
import { detectCommunities } from "./communities";
import { seededRandom } from "./simulation";

type Pair = readonly [number, number];

/**
 * A graph with planted clusters: each note links mostly inside its own cluster and now and
 * then to any note. `sizes` gives each cluster's size; notes are numbered cluster by cluster.
 */
function planted(sizes: readonly number[], inside: number, across: number, seed = 1) {
  const next = seededRandom(seed);
  const truth: number[] = [];
  sizes.forEach((s, c) => {
    for (let k = 0; k < s; k += 1) truth.push(c);
  });
  const starts = sizes.map((_, c) => sizes.slice(0, c).reduce((a, b) => a + b, 0));
  const n = truth.length;
  const edges: Pair[] = [];
  for (let i = 0; i < n; i += 1) {
    const c = truth[i] as number;
    for (let k = 0; k < inside; k += 1) {
      edges.push([i, (starts[c] as number) + Math.floor(next() * (sizes[c] as number))]);
    }
    for (let k = 0; k < across; k += 1) edges.push([i, Math.floor(next() * n)]);
  }
  return { n, edges, truth };
}

/** For each planted cluster, the share of its notes in its most common found region. */
function recovery(truth: readonly number[], assign: Int32Array) {
  const clusters = Math.max(...truth) + 1;
  const majority: number[] = [];
  const share: number[] = [];
  for (let c = 0; c < clusters; c += 1) {
    const counts = new Map<number, number>();
    let size = 0;
    truth.forEach((t, i) => {
      if (t !== c) return;
      size += 1;
      const a = assign[i] as number;
      counts.set(a, (counts.get(a) ?? 0) + 1);
    });
    const [best, count] = [...counts.entries()].sort((p, q) => q[1] - p[1])[0] ?? [-1, 0];
    majority.push(best);
    share.push(count / size);
  }
  return { majority, share };
}

describe("detectCommunities", () => {
  it("recovers planted clusters", () => {
    const { n, edges, truth } = planted([120, 100, 90, 80, 70, 60, 50, 40], 6, 1);
    const { assign, count } = detectCommunities(n, edges, 7);
    const { majority, share } = recovery(truth, assign);
    expect(Math.min(...share)).toBeGreaterThan(0.9);
    // Each planted cluster has a region of its own.
    expect(new Set(majority).size).toBe(8);
    expect(count).toBeGreaterThanOrEqual(8);
    expect(count).toBeLessThanOrEqual(10);
  });

  it("splits two dense groups joined by a single link", () => {
    const edges: Pair[] = [];
    for (let a = 0; a < 6; a += 1) {
      for (let b = a + 1; b < 6; b += 1) {
        edges.push([a, b]);
        edges.push([a + 6, b + 6]);
      }
    }
    edges.push([0, 6]);
    const { assign, count } = detectCommunities(12, edges, 1);
    expect(count).toBe(2);
    expect(new Set(assign.subarray(0, 6)).size).toBe(1);
    expect(new Set(assign.subarray(6)).size).toBe(1);
    expect(assign[0]).not.toBe(assign[6]);
  });

  it("numbers regions by size, largest first", () => {
    const { n, edges } = planted([30, 90, 60], 6, 0, 4);
    const { assign, count } = detectCommunities(n, edges, 2);
    const sizes = Array.from({ length: count }, (_, c) => assign.filter((a) => a === c).length);
    expect(sizes).toEqual([...sizes].sort((p, q) => q - p));
    // The 90-note cluster (notes 30 to 119) is region 0.
    expect(assign[30]).toBe(0);
  });

  it("gives notes with no links no region", () => {
    const edges: Pair[] = [
      [0, 1],
      [1, 2],
      [2, 0],
      [4, 4], // a self link is not a link
      [3, 99], // out of range
    ];
    const { assign, count } = detectCommunities(6, edges, 1);
    expect(Array.from(assign)).toEqual([0, 0, 0, -1, -1, -1]);
    expect(count).toBe(1);
    expect(detectCommunities(4, [], 1)).toEqual({
      assign: Int32Array.of(-1, -1, -1, -1),
      count: 0,
    });
    expect(detectCommunities(0, [], 1)).toEqual({ assign: new Int32Array(0), count: 0 });
  });

  it("is deterministic for a seed and ignores duplicate links and link order", () => {
    const { n, edges } = planted([80, 70, 60, 50], 4, 2, 9);
    const a = detectCommunities(n, edges, 3);
    const b = detectCommunities(n, edges, 3);
    expect(Array.from(b.assign)).toEqual(Array.from(a.assign));
    const shuffledTwice = [...edges, ...edges.map(([p, q]): Pair => [q, p])].reverse();
    expect(Array.from(detectCommunities(n, shuffledTwice, 3).assign)).toEqual(Array.from(a.assign));
  });

  it("handles 10,000 notes and 100,000 links in time", () => {
    const sizes = Array.from({ length: 40 }, (_, c) => 150 + ((c * 37) % 200));
    const total = sizes.reduce((a, b) => a + b, 0);
    sizes[0] = (sizes[0] as number) + 10000 - total;
    const { n, edges, truth } = planted(sizes, 8, 2, 5);
    expect(n).toBe(10000);
    expect(edges.length).toBe(100000);
    const started = performance.now();
    const { assign } = detectCommunities(n, edges, 1);
    const took = performance.now() - started;
    expect(took).toBeLessThan(2000);
    expect(Math.min(...recovery(truth, assign).share)).toBeGreaterThan(0.8);
  }, 20000);
});

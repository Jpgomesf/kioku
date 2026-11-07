import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphData, GraphNode } from "../../api";
import { forceLayout } from "./forceLayout";
import {
  clearLayoutCache,
  type LayoutReply,
  type LayoutRequest,
  seededRandom,
  useLayout,
} from "./layout";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Pair = readonly [number, number];

/** k planted clusters: dense inside, a few links between. Deterministic. */
function planted(k: number, size: number, inside: number, between: number): Pair[] {
  const edges: Pair[] = [];
  const next = seededRandom(7);
  for (let c = 0; c < k; c += 1) {
    for (let e = 0; e < size * inside; e += 1) {
      edges.push([c * size + Math.floor(next() * size), c * size + Math.floor(next() * size)]);
    }
  }
  for (let e = 0; e < between; e += 1) {
    edges.push([Math.floor(next() * k * size), Math.floor(next() * k * size)]);
  }
  return edges;
}

const dist = (xs: Float64Array, ys: Float64Array, a: number, b: number) =>
  Math.hypot((xs[a] ?? 0) - (xs[b] ?? 0), (ys[a] ?? 0) - (ys[b] ?? 0));

/** Mean distance inside clusters and between them; cluster of i is clusterOf(i). */
function separation(xs: Float64Array, ys: Float64Array, clusterOf: (i: number) => number) {
  let inSum = 0;
  let inCount = 0;
  let outSum = 0;
  let outCount = 0;
  for (let a = 0; a < xs.length; a += 3) {
    for (let b = a + 1; b < xs.length; b += 5) {
      const d = dist(xs, ys, a, b);
      if (clusterOf(a) === clusterOf(b)) {
        inSum += d;
        inCount += 1;
      } else {
        outSum += d;
        outCount += 1;
      }
    }
  }
  return { inside: inSum / inCount, between: outSum / outCount };
}

const allFinite = (xs: Float64Array) => xs.every((v) => Number.isFinite(v));

describe("forceLayout", () => {
  it("is deterministic for a seed", () => {
    const input = { n: 120, edges: planted(4, 30, 3, 10), seed: 42 };
    const a = forceLayout(input);
    const b = forceLayout(input);
    expect([...a.xs]).toEqual([...b.xs]);
    expect([...a.ys]).toEqual([...b.ys]);
    const c = forceLayout({ ...input, seed: 43 });
    expect([...c.xs]).not.toEqual([...a.xs]);
  });

  it("never produces NaN on edge cases", () => {
    expect(forceLayout({ n: 0, edges: [], seed: 1 }).xs.length).toBe(0);
    const one = forceLayout({ n: 1, edges: [[0, 0]], seed: 1 });
    expect([one.xs[0], one.ys[0]]).toEqual([0, 0]);
    const cases: Array<{ n: number; edges: Pair[] }> = [
      { n: 2, edges: [] },
      { n: 5, edges: [] },
      {
        n: 3,
        edges: [
          [0, 0],
          [1, 1],
        ],
      },
      {
        n: 3,
        edges: [
          [0, 1],
          [0, 1],
          [1, 0],
          [0, 1],
        ],
      },
      {
        n: 4,
        edges: [
          [0, 9],
          [-1, 2],
          [1, 2],
        ],
      },
      { n: 50, edges: Array.from({ length: 49 }, (_, i): Pair => [0, i + 1]) },
    ];
    for (const c of cases) {
      const r = forceLayout({ ...c, seed: 3 });
      expect(allFinite(r.xs) && allFinite(r.ys)).toBe(true);
    }
  });

  it("separates planted clusters", () => {
    const size = 50;
    const { xs, ys } = forceLayout({ n: 4 * size, edges: planted(4, size, 4, 12), seed: 9 });
    const { inside, between } = separation(xs, ys, (i) => Math.floor(i / size));
    expect(inside).toBeLessThan(between / 2);
  });

  it("keeps a big hub from swallowing the other clusters", () => {
    const size = 40;
    const edges = [...planted(3, size, 4, 6)];
    // Note 120 is a hub with 300 leaves (121..420), linked once into each cluster.
    const hub = 3 * size;
    for (let leaf = 1; leaf <= 300; leaf += 1) edges.push([hub, hub + leaf]);
    for (let c = 0; c < 3; c += 1) edges.push([hub, c * size]);
    const n = hub + 301;
    const { xs, ys } = forceLayout({ n, edges, seed: 5 });
    // Each cluster keeps its own place: its notes sit nearer their centre than the hub does.
    for (let c = 0; c < 3; c += 1) {
      const members = Array.from({ length: size }, (_, k) => c * size + k);
      const cx = members.reduce((t, i) => t + (xs[i] ?? 0), 0) / size;
      const cy = members.reduce((t, i) => t + (ys[i] ?? 0), 0) / size;
      const radius =
        members.reduce((t, i) => t + Math.hypot((xs[i] ?? 0) - cx, (ys[i] ?? 0) - cy), 0) / size;
      const toHub = Math.hypot((xs[hub] ?? 0) - cx, (ys[hub] ?? 0) - cy);
      expect(radius).toBeLessThan(toHub);
    }
    // The clusters themselves stay apart from each other.
    const inner = separation(xs.slice(0, hub), ys.slice(0, hub), (i) => Math.floor(i / size));
    expect(inner.inside).toBeLessThan(inner.between / 2);
  });

  it("keeps unlinked notes in a band just outside the linked ones", () => {
    const next = seededRandom(21);
    const linkedCount = 1800;
    // Hub-heavy links among the first 1,800 notes; notes 1,800..1,999 have no links.
    const edges: Pair[] = Array.from({ length: 14000 }, () => [
      Math.floor(next() * linkedCount),
      Math.floor(next() ** 3 * linkedCount),
    ]);
    const { xs, ys } = forceLayout({ n: 2000, edges, seed: 4 });
    expect(allFinite(xs) && allFinite(ys)).toBe(true);
    const box = (from: number, to: number) => {
      const px = [...xs.slice(from, to)];
      const py = [...ys.slice(from, to)];
      return Math.max(Math.max(...px) - Math.min(...px), Math.max(...py) - Math.min(...py));
    };
    expect(box(0, 2000)).toBeLessThan(1.6 * box(0, linkedCount));
  }, 20000);

  it("separates notes that start on the same spot without NaN", () => {
    const n = 54;
    const initial = {
      xs: Array.from({ length: n }, (_, i) => (i < 4 ? 0 : 1e-12)),
      ys: new Array<number>(n).fill(0),
    };
    const edges = Array.from({ length: n - 1 }, (_, i): Pair => [i, i + 1]);
    const { xs, ys } = forceLayout({ n, edges, seed: 2 }, { initial });
    expect(allFinite(xs) && allFinite(ys)).toBe(true);
    let closest = Number.POSITIVE_INFINITY;
    for (let a = 0; a < n; a += 1)
      for (let b = a + 1; b < n; b += 1) closest = Math.min(closest, dist(xs, ys, a, b));
    expect(closest).toBeGreaterThan(1e-6);
  });

  it("lays out 2,000 notes and 16,000 links in under 8 s", () => {
    let s = 1;
    const next = () => {
      s = (s * 48271) % 2147483647;
      return s / 2147483647;
    };
    // Power-law-ish: many links land on a few hubs, like a real area.
    const edges: Pair[] = Array.from({ length: 16000 }, () => [
      Math.floor(next() * 2000),
      Math.floor(next() ** 3 * 2000),
    ]);
    let progress = 0;
    const started = performance.now();
    const r = forceLayout({ n: 2000, edges, seed: 11 }, { onProgress: () => (progress += 1) });
    expect(performance.now() - started).toBeLessThan(8000);
    expect(progress).toBeGreaterThan(0);
    expect(allFinite(r.xs) && allFinite(r.ys)).toBe(true);
  }, 20000);
});

const node = (key: string): GraphNode => ({
  key,
  domain: "t",
  title: key,
  kind: "decision",
  status: "active",
  degree: 0,
});

const graph = (keys: string[]): GraphData => ({
  nodes: keys.map(node),
  edges: keys
    .slice(1)
    .map((k) => ({ source: k, target: keys[0] ?? k, relation: "related", suggested: false })),
});

/** A stand-in Worker that records requests and lets the test answer them. */
class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((event: { data: LayoutReply }) => void) | null = null;
  onerror: (() => void) | null = null;
  request: LayoutRequest | null = null;
  terminated = false;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(request: LayoutRequest) {
    this.request = request;
  }
  terminate() {
    this.terminated = true;
  }
  reply(id: number, done: boolean) {
    const n = this.request?.n ?? 0;
    const xs = Float64Array.from({ length: n }, (_, i) => i);
    this.onmessage?.({ data: { id, xs, ys: xs.slice(), done } });
  }
}

let seen: Array<ReturnType<typeof useLayout>> = [];

function Probe(props: { domain: string; data: GraphData }) {
  seen.push(useLayout(props.domain, props.data));
  return null;
}

function mountHook(initial: { domain: string; data: GraphData }) {
  seen = [];
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(createElement(Probe, initial)));
  return {
    rerender: (p: { domain: string; data: GraphData }) =>
      act(() => root.render(createElement(Probe, p))),
    unmount: () => act(() => root.unmount()),
    last: () => seen[seen.length - 1],
  };
}

describe("useLayout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeWorker.all = [];
    clearLayoutCache();
  });

  it("lays out synchronously without Worker", () => {
    vi.stubGlobal("Worker", undefined);
    const h = mountHook({ domain: "demo", data: graph(["a", "b", "c"]) });
    expect(h.last()?.settling).toBe(false);
    expect(h.last()?.layout?.positions.size).toBe(3);
    h.unmount();
  });

  it("shows progress, ignores a stale result and terminates old workers", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const first = graph(["a", "b", "c"]);
    const h = mountHook({ domain: "demo", data: first });
    expect(h.last()).toEqual({ layout: null, settling: true });
    const old = FakeWorker.all[0];
    const oldId = old?.request?.id ?? 0;
    act(() => old?.reply(oldId, false));
    expect(h.last()?.settling).toBe(true);
    expect(h.last()?.layout?.positions.size).toBe(3);

    const second = graph(["x", "y"]);
    h.rerender({ domain: "other", data: second });
    expect(old?.terminated).toBe(true);
    act(() => old?.reply(oldId, true));
    expect(h.last()?.layout ?? null).toBeNull();

    const current = FakeWorker.all[1];
    act(() => current?.reply(current.request?.id ?? 0, true));
    expect(h.last()?.settling).toBe(false);
    expect([...(h.last()?.layout?.positions.keys() ?? [])]).toEqual(["x", "y"]);
    // The final layout is cached: coming back needs no new worker.
    h.rerender({ domain: "demo", data: first });
    h.rerender({ domain: "other", data: second });
    expect(h.last()?.settling).toBe(false);
    h.unmount();
    expect(current?.terminated).toBe(true);
  });

  it("falls back to the synchronous layout when the worker fails", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const h = mountHook({ domain: "demo", data: graph(["a", "b"]) });
    act(() => FakeWorker.all[0]?.onerror?.());
    expect(h.last()?.settling).toBe(false);
    expect(h.last()?.layout?.positions.size).toBe(2);
    h.unmount();
  });
});

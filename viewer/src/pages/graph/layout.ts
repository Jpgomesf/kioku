// Graph layout: runs the force layout (forceLayout.ts), normalises it into the world box and
// caches it per area. The seed comes from the domain, so an area always opens with the same
// picture, and the cache is keyed by the graph's shape so moving between views never re-runs
// it. useLayout runs the same layout in a Web Worker so big areas never block the page.
import { useEffect, useMemo, useState } from "react";
import type { GraphData } from "../../api";
import { forceLayout } from "./forceLayout";

export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Layout {
  positions: ReadonlyMap<string, Point>;
  bounds: Bounds;
}

/** The world box the layout fills. */
export const WORLD = { width: 1000, height: 640 } as const;

/** A 32-bit string hash (FNV-1a). */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a small, fast seeded generator in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface LayoutOptions {
  iterations?: number;
}

/** Sorted keys and their links as index pairs: the input the force layout needs. */
export function layoutInput(data: GraphData): { keys: string[]; edges: Array<[number, number]> } {
  const keys = data.nodes.map((n) => n.key).sort();
  const index = new Map(keys.map((k, i) => [k, i]));
  return { keys, edges: linkPairs(data, index) };
}

/** Lay out a graph from scratch. Pure: the same domain and data give the same positions. */
export function computeLayout(
  domain: string,
  data: GraphData,
  options: LayoutOptions = {},
): Layout {
  const { keys, edges } = layoutInput(data);
  const { xs, ys } = forceLayout(
    { n: keys.length, edges, seed: hashSeed(domain) },
    { maxIterations: options.iterations },
  );
  return normalise(keys, xs, ys);
}

/** Links as sorted, de-duplicated index pairs, so edge order never changes the picture. */
function linkPairs(data: GraphData, index: ReadonlyMap<string, number>): Array<[number, number]> {
  const seen = new Set<number>();
  const n = index.size;
  for (const e of data.edges) {
    const a = index.get(e.source);
    const b = index.get(e.target);
    if (a === undefined || b === undefined || a === b) continue;
    seen.add(Math.min(a, b) * n + Math.max(a, b));
  }
  return [...seen]
    .sort((p, q) => p - q)
    .map((code): [number, number] => [Math.floor(code / n), code % n]);
}

/** Scale the raw positions into the world box, keeping the aspect ratio. */
export function normalise(keys: string[], xs: Float64Array, ys: Float64Array): Layout {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < keys.length; i += 1) {
    const x = xs[i] ?? 0;
    const y = ys[i] ?? 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const positions = new Map<string, Point>();
  if (keys.length === 0) {
    return { positions, bounds: { minX: 0, minY: 0, maxX: WORLD.width, maxY: WORLD.height } };
  }
  const pad = 40;
  const w = Math.max(maxX - minX, 1);
  const h = Math.max(maxY - minY, 1);
  const scale = Math.min((WORLD.width - 2 * pad) / w, (WORLD.height - 2 * pad) / h, 4);
  const offX = WORLD.width / 2 - ((minX + maxX) / 2) * scale;
  const offY = WORLD.height / 2 - ((minY + maxY) / 2) * scale;
  keys.forEach((key, i) => {
    positions.set(key, { x: (xs[i] ?? 0) * scale + offX, y: (ys[i] ?? 0) * scale + offY });
  });
  return {
    positions,
    bounds: {
      minX: minX * scale + offX,
      minY: minY * scale + offY,
      maxX: maxX * scale + offX,
      maxY: maxY * scale + offY,
    },
  };
}

/** A cheap signature of the graph's shape, so a changed area gets a fresh layout. */
function signature(data: GraphData): string {
  let h = hashSeed(String(data.nodes.length));
  for (const key of data.nodes.map((n) => n.key).sort()) h = hashSeed(`${h}:${key}`);
  const links = data.edges.map((e) => `${e.source}>${e.target}`).sort();
  for (const link of links) h = hashSeed(`${h}:${link}`);
  return `${data.nodes.length}:${data.edges.length}:${h}`;
}

const cache = new Map<string, { sig: string; layout: Layout }>();

/** The layout for an area, computed once per domain and graph shape. */
export function layoutFor(domain: string, data: GraphData): Layout {
  const sig = signature(data);
  const hit = cache.get(domain);
  if (hit && hit.sig === sig) return hit.layout;
  const layout = computeLayout(domain, data);
  cache.set(domain, { sig, layout });
  return layout;
}

/** True when `layoutFor` would answer from the cache without laying out. */
export function hasLayout(domain: string, data: GraphData): boolean {
  return cache.get(domain)?.sig === signature(data);
}

export function clearLayoutCache(): void {
  cache.clear();
}

function storeLayout(domain: string, data: GraphData, layout: Layout): void {
  cache.set(domain, { sig: signature(data), layout });
}

/** What the page sends the layout worker. */
export interface LayoutRequest {
  id: number;
  n: number;
  edges: Array<[number, number]>;
  seed: number;
}

/** What the worker answers: positions so far, and done on the final one. */
export interface LayoutReply {
  id: number;
  xs: Float64Array;
  ys: Float64Array;
  done: boolean;
}

let nextRequestId = 1;

interface LayoutState {
  domain: string;
  data: GraphData;
  layout: Layout | null;
  settling: boolean;
}

/**
 * The layout for an area, computed off the main thread. Answers from the cache at once when
 * it can; otherwise shows the worker's progress (settling) and caches the final layout. Without
 * Worker (tests) or when the worker fails, it lays out synchronously instead.
 */
export function useLayout(
  domain: string,
  data: GraphData,
): { layout: Layout | null; settling: boolean } {
  // Synchronous answers: a cache hit, or no Worker at all.
  const immediate = useMemo(
    () =>
      hasLayout(domain, data) || typeof Worker === "undefined" ? layoutFor(domain, data) : null,
    [domain, data],
  );
  const [state, setState] = useState<LayoutState | null>(null);

  useEffect(() => {
    if (immediate) return;
    const { keys, edges } = layoutInput(data);
    const id = nextRequestId;
    nextRequestId += 1;
    let active = true;
    const fallback = () => {
      if (!active) return;
      setState({ domain, data, layout: layoutFor(domain, data), settling: false });
    };
    let worker: Worker;
    try {
      worker = new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" });
    } catch {
      fallback();
      return;
    }
    worker.onmessage = (event: MessageEvent<LayoutReply>) => {
      const reply = event.data;
      // A reply for an older request (area or data changed) must never land.
      if (!active || reply.id !== id) return;
      const layout = normalise(keys, reply.xs, reply.ys);
      if (reply.done) {
        storeLayout(domain, data, layout);
        worker.terminate();
      }
      setState({ domain, data, layout, settling: !reply.done });
    };
    worker.onerror = () => {
      worker.terminate();
      fallback();
    };
    const request: LayoutRequest = { id, n: keys.length, edges, seed: hashSeed(domain) };
    worker.postMessage(request);
    return () => {
      active = false;
      worker.terminate();
    };
  }, [domain, data, immediate]);

  if (immediate) return { layout: immediate, settling: false };
  if (state && state.domain === domain && state.data === data) {
    return { layout: state.layout, settling: state.settling };
  }
  return { layout: null, settling: true };
}

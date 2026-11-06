// A deterministic force layout (Fruchterman-Reingold with a cooling schedule). The seed comes
// from the domain, so an area always opens with the same picture, and positions are cached
// per domain and graph shape so moving between views never re-runs it.
import type { GraphData } from "../../api";

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

/** Lay out a graph from scratch. Pure: the same domain and data give the same positions. */
export function computeLayout(
  domain: string,
  data: GraphData,
  options: LayoutOptions = {},
): Layout {
  const keys = data.nodes.map((n) => n.key).sort();
  const index = new Map(keys.map((k, i) => [k, i]));
  const n = keys.length;
  // Big areas get fewer rounds; with the grid below that keeps the cost near linear.
  const iterations = options.iterations ?? (n > 1200 ? 90 : n > 500 ? 140 : 220);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const rand = seededRandom(hashSeed(domain));
  for (let i = 0; i < n; i += 1) {
    xs[i] = (rand() - 0.5) * WORLD.width;
    ys[i] = (rand() - 0.5) * WORLD.height;
  }
  const links = linkPairs(data, index);
  const area = WORLD.width * WORLD.height;
  const k = Math.sqrt(area / Math.max(n, 1)) * 0.75;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  let temperature = WORLD.width / 10;
  const cooling = temperature / (iterations + 1);
  for (let step = 0; step < iterations; step += 1) {
    dx.fill(0);
    dy.fill(0);
    const repel = (i: number, j: number) => {
      let vx = (xs[i] ?? 0) - (xs[j] ?? 0);
      let vy = (ys[i] ?? 0) - (ys[j] ?? 0);
      let d2 = vx * vx + vy * vy;
      if (d2 < 0.01) {
        vx = 0.1 * ((i % 7) - 3) + 0.05;
        vy = 0.1 * ((j % 5) - 2) + 0.05;
        d2 = vx * vx + vy * vy;
      }
      const f = (k * k) / d2;
      dx[i] = (dx[i] ?? 0) + vx * f;
      dy[i] = (dy[i] ?? 0) + vy * f;
      dx[j] = (dx[j] ?? 0) - vx * f;
      dy[j] = (dy[j] ?? 0) - vy * f;
    };
    if (n <= GRID_AFTER) {
      for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) repel(i, j);
    } else {
      forNearPairs(xs, ys, 3 * k, repel);
    }
    for (const [a, b] of links) {
      const vx = (xs[a] ?? 0) - (xs[b] ?? 0);
      const vy = (ys[a] ?? 0) - (ys[b] ?? 0);
      const d = Math.sqrt(vx * vx + vy * vy) || 0.01;
      const f = d / k;
      dx[a] = (dx[a] ?? 0) - vx * f;
      dy[a] = (dy[a] ?? 0) - vy * f;
      dx[b] = (dx[b] ?? 0) + vx * f;
      dy[b] = (dy[b] ?? 0) + vy * f;
    }
    for (let i = 0; i < n; i += 1) {
      // A weak pull to the centre keeps unlinked notes from drifting off.
      const gx = (dx[i] ?? 0) - (xs[i] ?? 0) * 0.02 * k;
      const gy = (dy[i] ?? 0) - (ys[i] ?? 0) * 0.02 * k;
      const len = Math.sqrt(gx * gx + gy * gy) || 1;
      const move = Math.min(len, temperature);
      xs[i] = (xs[i] ?? 0) + (gx / len) * move;
      ys[i] = (ys[i] ?? 0) + (gy / len) * move;
    }
    temperature -= cooling;
  }
  return normalise(keys, xs, ys);
}

/** Above this many notes, repulsion only acts between notes within a few spacings. */
const GRID_AFTER = 400;

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

/** Calls `visit(i, j)` once for each pair closer than about `cell`, using a uniform grid. */
function forNearPairs(
  xs: Float64Array,
  ys: Float64Array,
  cell: number,
  visit: (i: number, j: number) => void,
): void {
  const grid = new Map<string, number[]>();
  const cellOf = (i: number) => [Math.floor((xs[i] ?? 0) / cell), Math.floor((ys[i] ?? 0) / cell)];
  for (let i = 0; i < xs.length; i += 1) {
    const [cx, cy] = cellOf(i);
    const id = `${cx},${cy}`;
    const list = grid.get(id);
    if (list) list.push(i);
    else grid.set(id, [i]);
  }
  for (let i = 0; i < xs.length; i += 1) {
    const [cx = 0, cy = 0] = cellOf(i);
    for (let ox = -1; ox <= 1; ox += 1) {
      for (let oy = -1; oy <= 1; oy += 1) {
        for (const j of grid.get(`${cx + ox},${cy + oy}`) ?? []) if (j > i) visit(i, j);
      }
    }
  }
}

/** Scale the raw positions into the world box, keeping the aspect ratio. */
function normalise(keys: string[], xs: Float64Array, ys: Float64Array): Layout {
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

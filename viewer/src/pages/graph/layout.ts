// Graph layout. useLiveLayout runs the live simulation (simulation.ts) in a Web Worker so
// notes glide while the forces settle, and big areas never block the page. The seed comes
// from the domain, so an area always opens with the same picture, and final positions are
// cached per area, graph shape, forces and clustering, so reopening is instant; a restart
// from a cached layout carries on from the same balance, so it does not drift. It also
// reports the graph's regions (communities.ts), numbered so they keep their numbers as
// filters change the graph, and lets the page drag a note while the graph moves around it.
// computeLayout and layoutFor are the synchronous form for callers that want a finished,
// fitted layout.
import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphData } from "../../api";
import { detectCommunities } from "./communities";
import { DEFAULT_FORCES, type Forces, sameForces } from "./forces";
import { hashSeed, Simulation, type SimulationInput, seededRandom, settle } from "./simulation";

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

export { hashSeed, seededRandom };

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
  const { xs, ys } = settle(
    { n: keys.length, edges, seed: hashSeed(domain) },
    DEFAULT_FORCES,
    options.iterations,
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
export function signature(data: GraphData): string {
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

// --- The live layout ---------------------------------------------------------------------

/** What the separation force sorts notes by: nothing, the colour groups, or the regions. */
export type ClusterMode = "none" | "groups" | "regions";

/** The page's clustering. For "groups", each note's group (-1 for none), aligned with the
 * data's nodes; other modes ignore it. */
export interface Clustering {
  mode: ClusterMode;
  groups: Int32Array | null;
}

/** The graph's regions: each note's region from 0 to count - 1, and -1 for a note with no
 * links. An area's first regions are numbered by size, largest first; later ones keep the
 * numbers of the regions they share most notes with (matchRegions), so colours and names
 * stay put when a filter changes the graph. */
export interface Regions {
  assign: Int32Array;
  count: number;
}

/** What the page sends the layout worker. */
export type WorkerRequest =
  | {
      type: "start";
      id: number;
      n: number;
      edges: Array<[number, number]>;
      seed: number;
      forces: Forces;
      initial?: SimulationInput["initial"];
      /** The clustering from the first tick, so the result never depends on message timing. */
      clusters: { mode: ClusterMode; groups?: Int32Array };
      /** Where alpha starts instead of the usual 1 (cold) or 0.3 (warm): 0 wakes a settled
       * layout at rest, so a drag's alpha target warms it gently, as on a run that settled
       * in the session. */
      alpha?: number;
    }
  | { type: "forces"; id: number; rev: number; forces: Forces }
  /** groups is in layout order (sorted keys), for "groups" only. */
  | { type: "clusters"; id: number; rev: number; mode: ClusterMode; groups?: Int32Array }
  /** Pins note `index` (layout order) at x, y and keeps the graph live around it. */
  | { type: "drag"; id: number; index: number; x: number; y: number }
  | { type: "release"; id: number; index: number }
  | { type: "stop"; id: number };

/** What the worker answers: the graph's regions once per run, then positions so far, and
 * settled once the simulation rests. */
export type WorkerReply =
  | {
      type: "positions";
      id: number;
      /** The settings revision these positions were computed under: forces and clusters
       * changes count up from 0 at "start". */
      rev: number;
      xs: Float64Array;
      ys: Float64Array;
      settled: boolean;
      /** With settled positions, the separation anchors they balance under (absent while
       * the force is off), so a restart of the same graph and clustering carries on from
       * them. */
      anchors?: Float64Array;
    }
  | { type: "regions"; id: number; assign: Int32Array; count: number };

/** Positions in simulation units, centred near the origin, aligned with keys. */
export interface LivePositions {
  keys: readonly string[];
  xs: Float64Array;
  ys: Float64Array;
}

export interface LiveLayout {
  current(): LivePositions | null;
  subscribe(listener: () => void): () => void;
  ready: boolean;
  settled: boolean;
  /** The graph's regions, aligned with the data last passed in; null until they are found.
   * Right after the notes change, notes the last regions did not know have -1. */
  regions(): Regions | null;
  /** Bumped only when the regions change, so React can recompute what it derives from them. */
  regionsVersion: number;
  /** Holds a note at x, y (the units of current()) while it is dragged; call it on every
   * pointer move. The graph moves around it as in d3; without a worker, or under reduced
   * motion, only the note moves. */
  drag(key: string, x: number, y: number): void;
  /** Lets the dragged note go, so the graph settles again. */
  release(key: string): void;
}

const NO_CLUSTERING: Clustering = { mode: "none", groups: null };

/** The clustering in layout order (sorted keys), with a key that names it. */
interface LayoutClusters {
  mode: ClusterMode;
  groups: Int32Array | null;
  key: string;
}

const NO_LAYOUT_CLUSTERS: LayoutClusters = { mode: "none", groups: null, key: "none" };

/** Regions with the keys of the notes they assign, in the same order. */
type KeyedRegions = Regions & { keys: readonly string[] };

/** The regions with the graph they belong to and its keys in layout order. */
interface LiveRegions extends KeyedRegions {
  sig: string;
}

const forcesKey = (f: Forces) => `${f.center}:${f.repel}:${f.link}:${f.distance}:${f.separation}`;

/** A 32-bit hash (FNV-1a over whole values) of a group assignment, for its cache key. */
function hashInts(values: Int32Array): number {
  let h = 0x811c9dc5;
  for (const v of values) h = Math.imul(h ^ v, 0x01000193);
  return h >>> 0;
}

/** The page's clustering in layout order: groups follow each note's key, -1 where unknown. */
function layoutClusters(
  keys: readonly string[],
  nodes: readonly { key: string }[],
  clustering: Clustering,
): LayoutClusters {
  if (clustering.mode === "regions") return { mode: "regions", groups: null, key: "regions" };
  const groups = clustering.groups;
  if (clustering.mode !== "groups" || !groups) return NO_LAYOUT_CLUSTERS;
  const at = new Map<string, number>();
  nodes.forEach((n, i) => {
    at.set(n.key, i);
  });
  const inLayout = Int32Array.from(keys, (k) => {
    const i = at.get(k);
    return i === undefined ? -1 : (groups[i] ?? -1);
  });
  return { mode: "groups", groups: inLayout, key: `groups:${keys.length}:${hashInts(inLayout)}` };
}

/** A settled layout: its positions, the graph's regions and the separation anchors the
 * positions balance under (null while the force is off). */
interface Settled {
  positions: LivePositions;
  regions: LiveRegions | null;
  anchors: Float64Array | null;
}

/** Settled layouts per area, graph shape, forces and clustering. Small, oldest out first. */
const liveCache = new Map<string, Settled>();
const LIVE_CACHE_SIZE = 24;

function cacheKey(domain: string, sig: string, forces: Forces, clusters: LayoutClusters): string {
  // With no separation the clustering moves nothing, so every mode shares one entry.
  const clustering = forces.separation > 0 ? clusters.key : "none";
  return `${domain}\n${sig}\n${forcesKey(forces)}\n${clustering}`;
}

function remember(key: string, value: Settled) {
  liveCache.delete(key);
  liveCache.set(key, value);
  if (liveCache.size > LIVE_CACHE_SIZE) {
    const oldest = liveCache.keys().next().value;
    if (oldest !== undefined) liveCache.delete(oldest);
  }
}

let nextRunId = 1;

interface LayoutInputs {
  keys: string[];
  edges: Array<[number, number]>;
  sig: string;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * `next`'s assignment renumbered to follow `previous`, matched by key: each new region takes
 * the number of the old region it shares the most notes with (biggest overlaps first), so a
 * region keeps its colour and name when a filter changes the graph and the regions are found
 * afresh. The rest take the free numbers in their own order. Numbers stay 0 to count - 1, so
 * an old number the new count does not reach goes to another region.
 */
export function matchRegions(previous: KeyedRegions, next: KeyedRegions): Int32Array {
  const old = new Map<string, number>();
  previous.keys.forEach((key, i) => {
    const r = previous.assign[i] as number;
    if (r >= 0) old.set(key, r);
  });
  // Notes shared by each new and old region pair, coded as new * stride + old.
  const stride = Math.max(1, previous.count);
  const shared = new Map<number, number>();
  next.keys.forEach((key, i) => {
    const r = next.assign[i] as number;
    const s = old.get(key);
    if (r < 0 || s === undefined) return;
    const code = r * stride + s;
    shared.set(code, (shared.get(code) ?? 0) + 1);
  });
  const number = new Int32Array(next.count).fill(-1);
  const taken = new Uint8Array(next.count);
  const pairs = [...shared.entries()].sort((p, q) => q[1] - p[1] || p[0] - q[0]);
  for (const [code] of pairs) {
    const r = Math.floor(code / stride);
    const s = code % stride;
    if (s >= next.count || number[r] !== -1 || taken[s] === 1) continue;
    number[r] = s;
    taken[s] = 1;
  }
  let free = 0;
  for (let r = 0; r < next.count; r += 1) {
    if (number[r] !== -1) continue;
    while (taken[free] === 1) free += 1;
    number[r] = free;
    taken[free] = 1;
  }
  return Int32Array.from(next.assign, (r) => (r < 0 ? -1 : (number[r] ?? -1)));
}

/**
 * Aligns layout positions to a scene. `from[i]` is the layout index of scene note i, or -1
 * for a note the layout does not know yet (a filter just added it). Such a note sits next to
 * a linked known note, else on a small spiral, so it never piles up at 0,0 for a frame.
 */
export function alignPositions(
  from: Int32Array,
  layoutXs: Float64Array,
  layoutYs: Float64Array,
  edges: ReadonlyArray<{ a: number; b: number }>,
  xs: Float64Array,
  ys: Float64Array,
): void {
  const n = from.length;
  const known = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const j = from[i] as number;
    if (j < 0) continue;
    xs[i] = layoutXs[j] as number;
    ys[i] = layoutYs[j] as number;
    known[i] = 1;
  }
  if (known.every((k) => k === 1)) return;
  for (const { a, b } of edges) {
    if (known[a] === 1 && known[b] === 0) {
      xs[b] = xs[a] as number;
      ys[b] = ys[a] as number;
      known[b] = 2;
    } else if (known[b] === 1 && known[a] === 0) {
      xs[a] = xs[b] as number;
      ys[a] = ys[b] as number;
      known[a] = 2;
    }
  }
  for (let i = 0; i < n; i += 1) {
    if (known[i] !== 0) continue;
    const r = 10 * Math.sqrt(0.5 + i);
    xs[i] = r * Math.cos(i * 2.399963);
    ys[i] = r * Math.sin(i * 2.399963);
  }
}

/**
 * Drives one area's simulation outside React: owns the worker, ignores stale replies by id,
 * publishes positions and regions to the hook's store and reports ready and settled.
 */
class LiveEngine {
  private worker: Worker | null = null;
  /** False once Worker is missing or failed: lay out synchronously from then on. */
  private useWorker = typeof Worker !== "undefined";
  private id = 0;
  /** Counts forces and clusters changes within a run, so a settled reply from before one is
   * not trusted. */
  private rev = 0;
  /** True while the worker holds a simulation for this.id (running or rested). */
  private running = false;
  private inputs: LayoutInputs = { keys: [], edges: [], sig: "" };
  /** Each layout key's index, for drag messages. */
  private index = new Map<string, number>();
  private forces: Forces = DEFAULT_FORCES;
  private clusters: LayoutClusters = NO_LAYOUT_CLUSTERS;
  private value: LivePositions | null = null;
  private regions: LiveRegions | null = null;
  /** The separation anchors of the last settled layout, with the graph and clustering they
   * belong to (anchorsKey): a restart of the same ones hands them back, so it moves nothing. */
  private anchors: { key: string; unit: Float64Array } | null = null;
  /** Where the current drag goes: the worker's simulation, or only the note itself. */
  private dragging: "worker" | "alone" | null = null;
  /** The positions a drag without a simulation moves: a copy, so cached arrays never change. */
  private moved: LivePositions | null = null;
  private destroyed = false;
  private reported: { ready: boolean; settled: boolean } | null = null;

  constructor(
    private readonly domain: string,
    private readonly publish: (value: LivePositions | null) => void,
    private readonly publishRegions: (regions: LiveRegions) => void,
    private readonly report: (ready: boolean, settled: boolean) => void,
  ) {}

  /** New notes or links: a fresh simulation warm-started from the notes still present. */
  load(inputs: LayoutInputs, forces: Forces, clusters: LayoutClusters): void {
    this.stopRun();
    this.inputs = inputs;
    this.index = new Map(inputs.keys.map((k, i) => [k, i]));
    this.forces = forces;
    this.clusters = clusters;
    this.dragging = null;
    const hit = liveCache.get(this.cacheKey());
    if (hit) {
      if (hit.regions) this.setRegions(hit.regions);
      this.keepAnchors(hit.anchors);
      this.show(hit.positions, true);
      return;
    }
    this.start(this.warmStart(inputs.keys));
  }

  /** New forces: the same simulation reheats from where the notes are now. */
  setForces(forces: Forces): void {
    if (sameForces(forces, this.forces)) return;
    this.forces = forces;
    if (this.running && this.worker) {
      this.rev += 1;
      this.post({ type: "forces", id: this.id, rev: this.rev, forces });
      this.reportChange(this.value !== null, false);
      return;
    }
    // Nothing running (a cache hit or the synchronous path): start warm from here.
    this.start(this.warmStart(this.inputs.keys));
  }

  /** A new clustering: like forces, the same simulation takes it and reheats. */
  setClusters(clusters: LayoutClusters): void {
    if (clusters.key === this.clusters.key) return;
    this.clusters = clusters;
    if (this.running && this.worker) {
      this.rev += 1;
      const { mode, groups } = clusters;
      this.post({
        type: "clusters",
        id: this.id,
        rev: this.rev,
        mode,
        ...(groups ? { groups } : {}),
      });
      this.reportChange(this.value !== null, false);
      return;
    }
    // Without separation the clustering moves nothing (the cache key ignores it too), so a
    // settled layout stays as it is; raising separation later starts from these clusters.
    if (this.forces.separation === 0) return;
    this.start(this.warmStart(this.inputs.keys));
  }

  drag(key: string, x: number, y: number): void {
    const index = this.index.get(key);
    if (this.destroyed || index === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }
    if (this.dragging !== "alone" && this.useWorker && !prefersReducedMotion()) {
      // A cache hit has no simulation yet: wake one at rest from the positions on screen, so
      // the drag warms it gently, as on a run that settled in the session. Never a
      // synchronous settle for a drag: without a worker the note moves alone.
      if (!this.running && this.ensureWorker()) {
        const initial = this.warmStart(this.inputs.keys);
        this.start(initial, initial ? 0 : undefined);
      }
      if (this.running && this.worker) {
        this.dragging = "worker";
        this.post({ type: "drag", id: this.id, index, x, y });
        this.reportChange(this.value !== null, false);
        return;
      }
    }
    this.moveAlone(index, x, y);
  }

  release(key: string): void {
    const index = this.index.get(key);
    const was = this.dragging;
    this.dragging = null;
    if (was === null || index === undefined || !this.running || !this.worker) return;
    if (was === "alone") {
      // The worker never heard of this drag, and the settled reply it may have sent meanwhile
      // was held back so the note stayed put. Hand it the note's place: it posts once more
      // with the note there, and its next run starts from it.
      const x = this.value?.xs[index];
      const y = this.value?.ys[index];
      if (x === undefined || y === undefined) return;
      this.post({ type: "drag", id: this.id, index, x, y });
    }
    this.post({ type: "release", id: this.id, index });
  }

  destroy(): void {
    this.destroyed = true;
    this.worker?.terminate();
    this.worker = null;
    this.running = false;
  }

  private post(message: WorkerRequest): void {
    this.worker?.postMessage(message);
  }

  private cacheKey(): string {
    return cacheKey(this.domain, this.inputs.sig, this.forces, this.clusters);
  }

  /** The regions found for the current graph, if they have arrived. */
  private currentRegions(): LiveRegions | null {
    return this.regions?.sig === this.inputs.sig ? this.regions : null;
  }

  /** Regions are fixed for a graph (the seed is the area's), so the same graph is no change.
   * Another graph's regions keep the numbers of the ones before them where they share notes. */
  private setRegions(next: LiveRegions): void {
    if (this.regions?.sig === next.sig) return;
    const regions = this.regions ? { ...next, assign: matchRegions(this.regions, next) } : next;
    this.regions = regions;
    this.publishRegions(regions);
  }

  /** The graph and clustering separation anchors belong to: they fit only those clusters. */
  private anchorsKey(): string {
    return `${this.inputs.sig}\n${this.clusters.key}`;
  }

  /** Keeps the anchors a settled layout of the current graph and clustering balances under. */
  private keepAnchors(unit: Float64Array | null | undefined): void {
    this.anchors = unit ? { key: this.anchorsKey(), unit } : null;
  }

  /** Without a simulation to follow, or under reduced motion, only the dragged note moves. */
  private moveAlone(index: number, x: number, y: number): void {
    const value = this.value;
    if (!value) return;
    const moved =
      value === this.moved
        ? value
        : { keys: value.keys, xs: value.xs.slice(), ys: value.ys.slice() };
    moved.xs[index] = x;
    moved.ys[index] = y;
    this.dragging = "alone";
    this.moved = moved;
    this.value = moved;
    this.publish(moved);
  }

  /** Report only changes: even a same-value setState can cost React a render per post. */
  private reportChange(ready: boolean, settled: boolean): void {
    if (this.reported?.ready === ready && this.reported.settled === settled) return;
    this.reported = { ready, settled };
    this.report(ready, settled);
  }

  private show(value: LivePositions, settled: boolean): void {
    this.value = value;
    this.publish(value);
    this.reportChange(true, settled);
  }

  private withdraw(): void {
    if (this.value !== null) {
      this.value = null;
      this.publish(null);
    }
    this.reportChange(false, false);
  }

  private stopRun(): void {
    if (this.running && this.worker) this.post({ type: "stop", id: this.id });
    this.running = false;
    this.rev = 0;
    this.id = nextRunId;
    nextRunId += 1;
  }

  /** Start positions from the current ones, for the notes still present, with the anchors
   * they settled under when the graph and clustering are still the same. */
  private warmStart(keys: readonly string[]): SimulationInput["initial"] {
    const prev = this.value;
    if (!prev) return undefined;
    const at = new Map(prev.keys.map((k, i) => [k, i]));
    const xs = new Float64Array(keys.length);
    const ys = new Float64Array(keys.length);
    const known = new Uint8Array(keys.length);
    let any = false;
    keys.forEach((key, i) => {
      const j = at.get(key);
      if (j === undefined) return;
      xs[i] = prev.xs[j] as number;
      ys[i] = prev.ys[j] as number;
      known[i] = 1;
      any = true;
    });
    if (!any) return undefined;
    const anchors = this.anchors?.key === this.anchorsKey() ? this.anchors.unit : undefined;
    return anchors ? { xs, ys, known, anchors } : { xs, ys, known };
  }

  /** A new run in the worker (or the synchronous settle without one); `alpha` as in the
   * start message. */
  private start(initial: SimulationInput["initial"], alpha?: number): void {
    this.stopRun();
    const { keys, edges } = this.inputs;
    const seed = hashSeed(this.domain);
    const worker = this.ensureWorker();
    if (!worker) {
      this.settleNow(initial);
      return;
    }
    const { mode, groups } = this.clusters;
    this.post({
      type: "start",
      id: this.id,
      n: keys.length,
      edges,
      seed,
      forces: this.forces,
      initial,
      clusters: groups ? { mode, groups } : { mode },
      ...(alpha === undefined ? {} : { alpha }),
    });
    this.running = true;
    // Publish the warm start now, so current().keys always matches the data last passed in;
    // without one, the old picture belongs to other notes and is withdrawn.
    // New notes take the simulation's own start places (near a linked note, else on the
    // spiral), never 0,0, so they do not pile up at the origin until the first reply.
    if (initial) {
      const placed = new Simulation({ n: keys.length, edges, seed, initial }, this.forces);
      this.show({ keys, xs: placed.xs.slice(), ys: placed.ys.slice() }, false);
    } else this.withdraw();
  }

  /** The synchronous path, regions included, for when there is no worker. */
  private settleNow(initial: SimulationInput["initial"]): void {
    const { keys, edges, sig } = this.inputs;
    const seed = hashSeed(this.domain);
    const regions = this.currentRegions() ?? {
      sig,
      keys,
      ...detectCommunities(keys.length, edges, seed),
    };
    const { mode, groups } = this.clusters;
    const clusters = mode === "regions" ? regions.assign : mode === "groups" ? groups : null;
    const { xs, ys, anchors } = settle(
      { n: keys.length, edges, seed, initial, clusters: clusters ?? undefined },
      this.forces,
    );
    const value = { keys, xs, ys };
    this.setRegions(regions);
    this.keepAnchors(anchors);
    remember(this.cacheKey(), { positions: value, regions: this.currentRegions(), anchors });
    this.show(value, true);
  }

  private ensureWorker(): Worker | null {
    if (this.worker || !this.useWorker || this.destroyed) return this.worker;
    try {
      const worker = new Worker(new URL("./layout.worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (event: MessageEvent<WorkerReply>) => this.onReply(event.data);
      worker.onerror = () => this.onFailure();
      this.worker = worker;
    } catch {
      this.useWorker = false;
    }
    return this.worker;
  }

  private onReply(reply: WorkerReply): void {
    // A reply for an older run (data changed, or a stop) must never land.
    if (this.destroyed || reply.id !== this.id) return;
    const { keys, sig } = this.inputs;
    if (reply.type === "regions") {
      if (reply.assign.length !== keys.length) return;
      this.setRegions({ sig, keys, assign: reply.assign, count: reply.count });
      return;
    }
    if (reply.xs.length !== keys.length) return;
    // A note dragged on its own keeps its place; release() hands it to the worker, which
    // then posts again.
    if (this.dragging === "alone") return;
    const value = { keys, xs: reply.xs, ys: reply.ys };
    // Computed under older settings, or posted before the worker heard of the drag in
    // progress: show it, but it is neither settled nor cacheable.
    const settled = reply.settled && reply.rev === this.rev && this.dragging !== "worker";
    // Under reduced motion the notes do not glide: the worker still runs, but only the
    // settled positions are shown.
    if (!settled && prefersReducedMotion()) {
      this.reportChange(this.value !== null, false);
      return;
    }
    if (settled) {
      const anchors = reply.anchors ?? null;
      this.keepAnchors(anchors);
      remember(this.cacheKey(), { positions: value, regions: this.currentRegions(), anchors });
    }
    this.show(value, settled);
  }

  private onFailure(): void {
    if (this.destroyed) return;
    this.worker?.terminate();
    this.worker = null;
    this.useWorker = false;
    this.running = false;
    this.settleNow(this.warmStart(this.inputs.keys));
  }
}

/** Positions and regions for the hook's callers, read outside React, and their listeners. */
class LiveStore {
  value: LivePositions | null = null;
  regions: LiveRegions | null = null;
  readonly listeners = new Set<() => void>();
  /** The last regions() answer, kept while neither the regions nor the notes change. */
  private aligned: {
    regions: LiveRegions | null;
    nodes: readonly { key: string }[] | null;
    out: Regions | null;
  } = { regions: null, nodes: null, out: null };

  setPositions(value: LivePositions | null): void {
    this.value = value;
    this.notify();
  }

  setRegions(regions: LiveRegions | null): void {
    this.regions = regions;
    this.notify();
  }

  /** The regions aligned with `nodes`; a note they do not know has -1. */
  regionsFor(nodes: readonly { key: string }[]): Regions | null {
    const r = this.regions;
    if (!r) return null;
    const memo = this.aligned;
    if (memo.regions === r && memo.nodes === nodes) return memo.out;
    const at = new Map(r.keys.map((k, i) => [k, i]));
    const assign = Int32Array.from(nodes, (n) => {
      const i = at.get(n.key);
      return i === undefined ? -1 : (r.assign[i] as number);
    });
    const out = { assign, count: r.count };
    this.aligned = { regions: r, nodes, out };
    return out;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/**
 * The live layout of an area: positions reach subscribers outside React (so a running
 * simulation never re-renders the page), while ready, settled and regionsVersion are React
 * state. A data change starts a new simulation warm-started from the notes still present; a
 * forces or clustering change reheats the running one. `clustering` picks what the
 * separation force sorts notes by; the regions are found whatever it is.
 */
export function useLiveLayout(
  domain: string,
  data: GraphData,
  forces: Forces,
  clustering: Clustering = NO_CLUSTERING,
): LiveLayout {
  const inputs = useMemo(
    (): LayoutInputs => ({ ...layoutInput(data), sig: signature(data) }),
    [data],
  );
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  const forcesRef = useRef(forces);
  forcesRef.current = forces;
  const nodesRef = useRef(data.nodes);
  nodesRef.current = data.nodes;
  const { mode, groups } = clustering;
  const clusters = useMemo(
    () => layoutClusters(inputs.keys, data.nodes, { mode, groups }),
    [inputs, data.nodes, mode, groups],
  );
  const clustersRef = useRef(clusters);
  clustersRef.current = clusters;

  const [store] = useState(() => new LiveStore());
  const [engine, setEngine] = useState<LiveEngine | null>(null);
  const engineRef = useRef<LiveEngine | null>(null);
  const [status, setStatus] = useState({ domain, ready: false, settled: false });
  const [regionsVersion, setRegionsVersion] = useState(0);

  useEffect(() => {
    const created = new LiveEngine(
      domain,
      (value) => store.setPositions(value),
      (regions) => {
        store.setRegions(regions);
        setRegionsVersion((v) => v + 1);
      },
      (ready, settled) =>
        setStatus((s) =>
          s.domain === domain && s.ready === ready && s.settled === settled
            ? s
            : { domain, ready, settled },
        ),
    );
    store.setPositions(null);
    if (store.regions !== null) {
      store.setRegions(null);
      setRegionsVersion((v) => v + 1);
    }
    engineRef.current = created;
    setEngine(created);
    return () => {
      created.destroy();
      engineRef.current = null;
      setEngine(null);
    };
  }, [domain, store]);

  // Only a changed shape restarts: a new data object with the same notes and links does not.
  const sig = inputs.sig;
  useEffect(() => {
    if (sig !== inputsRef.current.sig) return;
    engine?.load(inputsRef.current, forcesRef.current, clustersRef.current);
  }, [engine, sig]);

  // An equal clustering (the same groups in a new array) has the same key and changes nothing.
  const clustersKey = clusters.key;
  useEffect(() => {
    if (clustersKey !== clustersRef.current.key) return;
    engine?.setClusters(clustersRef.current);
  }, [engine, clustersKey]);

  const { center, repel, link, distance, separation } = forces;
  useEffect(() => {
    engine?.setForces({ center, repel, link, distance, separation });
  }, [engine, center, repel, link, distance, separation]);

  // The functions never change, so effects that subscribe or drag do not rerun as state moves.
  const [calls] = useState(() => ({
    current: () => store.value,
    subscribe: (listener: () => void) => {
      store.listeners.add(listener);
      return () => {
        store.listeners.delete(listener);
      };
    },
    regions: () => store.regionsFor(nodesRef.current),
    drag: (key: string, x: number, y: number) => engineRef.current?.drag(key, x, y),
    release: (key: string) => engineRef.current?.release(key),
  }));
  const fresh = status.domain === domain;
  const ready = fresh && status.ready;
  const settled = fresh && status.settled;
  return useMemo(
    () => ({ ...calls, ready, settled, regionsVersion }),
    [calls, ready, settled, regionsVersion],
  );
}

/** Forget every cached layout, fitted and live. Tests use it. */
export function clearLayoutCache(): void {
  cache.clear();
  liveCache.clear();
}

// Graph layout. useLiveLayout runs the live simulation (simulation.ts) in a Web Worker so
// notes glide while the forces settle, and big areas never block the page. The seed comes
// from the domain, so an area always opens with the same picture, and final positions are
// cached per area, graph shape and forces, so reopening is instant. computeLayout and
// layoutFor are the synchronous form for callers that want a finished, fitted layout.
import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphData } from "../../api";
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

/** What the page sends the layout worker. */
export type WorkerRequest =
  | {
      type: "start";
      id: number;
      n: number;
      edges: Array<[number, number]>;
      seed: number;
      forces: Forces;
      initial?: { xs: Float64Array; ys: Float64Array; known: Uint8Array };
    }
  | { type: "forces"; id: number; rev: number; forces: Forces }
  | { type: "stop"; id: number };

/** What the worker answers: positions so far, and settled once the simulation rests. */
export interface WorkerReply {
  id: number;
  /** The forces revision these positions were computed under; "start" is revision 0. */
  rev: number;
  xs: Float64Array;
  ys: Float64Array;
  settled: boolean;
}

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
}

const forcesKey = (f: Forces) => `${f.center}:${f.repel}:${f.link}:${f.distance}`;

/** Final positions per area, graph shape and forces. Small, oldest out first. */
const liveCache = new Map<string, LivePositions>();
const LIVE_CACHE_SIZE = 24;

function cacheKey(domain: string, sig: string, forces: Forces): string {
  return `${domain}\n${sig}\n${forcesKey(forces)}`;
}

function remember(key: string, value: LivePositions): void {
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

/**
 * Drives one area's simulation outside React: owns the worker, ignores stale replies by id,
 * publishes positions to the hook's listeners and reports ready and settled.
 */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
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

class LiveEngine {
  private worker: Worker | null = null;
  /** False once Worker is missing or failed: lay out synchronously from then on. */
  private useWorker = typeof Worker !== "undefined";
  private id = 0;
  /** Counts forces changes within a run, so a settled reply from before one is not trusted. */
  private rev = 0;
  /** True while the worker holds a simulation for this.id (running or rested). */
  private running = false;
  private inputs: LayoutInputs = { keys: [], edges: [], sig: "" };
  private forces: Forces = DEFAULT_FORCES;
  private value: LivePositions | null = null;
  private destroyed = false;
  private reported: { ready: boolean; settled: boolean } | null = null;

  constructor(
    private readonly domain: string,
    private readonly publish: (value: LivePositions | null) => void,
    private readonly report: (ready: boolean, settled: boolean) => void,
  ) {}

  current(): LivePositions | null {
    return this.value;
  }

  /** New notes or links: a fresh simulation warm-started from the notes still present. */
  load(inputs: LayoutInputs, forces: Forces): void {
    this.stopRun();
    this.inputs = inputs;
    this.forces = forces;
    const hit = liveCache.get(cacheKey(this.domain, inputs.sig, forces));
    if (hit) {
      this.show(hit, true);
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
      this.worker.postMessage({
        type: "forces",
        id: this.id,
        rev: this.rev,
        forces,
      } satisfies WorkerRequest);
      this.reportChange(this.value !== null, false);
      return;
    }
    // Nothing running (a cache hit or the synchronous path): start warm from here.
    this.start(this.warmStart(this.inputs.keys));
  }

  destroy(): void {
    this.destroyed = true;
    this.worker?.terminate();
    this.worker = null;
    this.running = false;
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
    if (this.running && this.worker) {
      this.worker.postMessage({ type: "stop", id: this.id } satisfies WorkerRequest);
    }
    this.running = false;
    this.rev = 0;
    this.id = nextRunId;
    nextRunId += 1;
  }

  /** Start positions from the current ones, for the notes still present. */
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
    return any ? { xs, ys, known } : undefined;
  }

  private start(initial: SimulationInput["initial"]): void {
    this.stopRun();
    const { keys, edges } = this.inputs;
    const seed = hashSeed(this.domain);
    const worker = this.ensureWorker();
    if (!worker) {
      this.settleNow(initial);
      return;
    }
    const id = this.id;
    const request: WorkerRequest = {
      type: "start",
      id,
      n: keys.length,
      edges,
      seed,
      forces: this.forces,
      initial,
    };
    worker.postMessage(request);
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

  private settleNow(initial: SimulationInput["initial"]): void {
    const { keys, edges, sig } = this.inputs;
    const { xs, ys } = settle(
      { n: keys.length, edges, seed: hashSeed(this.domain), initial },
      this.forces,
    );
    const value = { keys, xs, ys };
    remember(cacheKey(this.domain, sig, this.forces), value);
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
    if (reply.xs.length !== keys.length) return;
    const value = { keys, xs: reply.xs, ys: reply.ys };
    // Computed under older forces: show the motion, but it is neither settled nor cacheable.
    const settled = reply.settled && reply.rev === this.rev;
    // Under reduced motion the notes do not glide: the worker still runs, but only the
    // settled positions are shown.
    if (!settled && prefersReducedMotion()) {
      this.reportChange(this.value !== null, false);
      return;
    }
    if (settled) remember(cacheKey(this.domain, sig, this.forces), value);
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

/**
 * The live layout of an area: positions reach subscribers outside React (so a running
 * simulation never re-renders the page), while ready and settled are React state. A data
 * change starts a new simulation warm-started from the notes still present; a forces change
 * reheats the running one.
 */
export function useLiveLayout(domain: string, data: GraphData, forces: Forces): LiveLayout {
  const inputs = useMemo(
    (): LayoutInputs => ({ ...layoutInput(data), sig: signature(data) }),
    [data],
  );
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  const forcesRef = useRef(forces);
  forcesRef.current = forces;

  const [store] = useState(() => {
    const listeners = new Set<() => void>();
    return {
      value: null as LivePositions | null,
      listeners,
      set(value: LivePositions | null) {
        this.value = value;
        for (const listener of listeners) listener();
      },
    };
  });
  const [engine, setEngine] = useState<LiveEngine | null>(null);
  const [status, setStatus] = useState({ domain, ready: false, settled: false });

  useEffect(() => {
    const created = new LiveEngine(
      domain,
      (value) => store.set(value),
      (ready, settled) =>
        setStatus((s) =>
          s.domain === domain && s.ready === ready && s.settled === settled
            ? s
            : { domain, ready, settled },
        ),
    );
    store.set(null);
    setEngine(created);
    return () => {
      created.destroy();
      setEngine(null);
    };
  }, [domain, store]);

  // Only a changed shape restarts: a new data object with the same notes and links does not.
  const sig = inputs.sig;
  useEffect(() => {
    if (sig !== inputsRef.current.sig) return;
    engine?.load(inputsRef.current, forcesRef.current);
  }, [engine, sig]);

  const { center, repel, link, distance } = forces;
  useEffect(() => {
    engine?.setForces({ center, repel, link, distance });
  }, [engine, center, repel, link, distance]);

  const fresh = status.domain === domain;
  const ready = fresh && status.ready;
  const settled = fresh && status.settled;
  return useMemo(
    () => ({
      current: () => store.value,
      subscribe: (listener: () => void) => {
        store.listeners.add(listener);
        return () => {
          store.listeners.delete(listener);
        };
      },
      ready,
      settled,
    }),
    [store, ready, settled],
  );
}

/** Forget every cached layout, fitted and live. Tests use it. */
export function clearLayoutCache(): void {
  cache.clear();
  liveCache.clear();
}

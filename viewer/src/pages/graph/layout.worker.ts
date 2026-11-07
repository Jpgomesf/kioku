// Runs the live simulation off the main thread. It ticks in short slices so messages get
// through between them, posts positions at most every 32 ms, and once more when the
// simulation rests, with the separation anchors it rests under. "forces" and "clusters"
// messages update the same simulation and reheat it.
//
// Dragging follows d3: "drag" pins the note and holds alpha at 0.3 so the whole graph stays
// live, and "release" unpins it and lets alpha fall back to 0, so everything settles. From a
// drag until the graph rests again the worker ticks once a frame and posts every tick, as d3
// ticks on each animation frame: the neighbours then lag and spring after the note, the small
// movements Obsidian shows, instead of snapping to their balance in one slice.
//
// Each graph's regions (detectCommunities) are found once, cached per graph, and posted at the
// start of every run, so the page can colour or name them whatever the mode; in "regions" mode
// they are also the clusters the separation force sorts notes into.
import { type Communities, detectCommunities } from "./communities";
import type { ClusterMode, WorkerReply, WorkerRequest } from "./layout";
import { Simulation } from "./simulation";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerReply, transfer: Transferable[]): void;
};

const POST_EVERY_MS = 32;
/** How long one slice ticks before yielding to the message queue. */
const SLICE_MS = 12;
/** One tick per frame while a drag keeps the graph live. */
const FRAME_MS = 16;
/** d3's drag alphaTarget. */
const DRAG_ALPHA = 0.3;
/** Regions of the last few graphs, so a filter switched off and on again costs nothing. */
const REGION_CACHE_SIZE = 8;

interface Run {
  id: number;
  rev: number;
  sim: Simulation;
  regions: Communities;
  /** From a drag until the graph rests after the release: tick once a frame. */
  live: boolean;
}

let current: Run | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastPost = 0;
const regionCache = new Map<string, Communities>();

function postPositions(run: Run): void {
  const { id, rev, sim } = run;
  const settled = sim.settled;
  // Copies, because the simulation keeps moving its own arrays.
  const xs = sim.xs.slice();
  const ys = sim.ys.slice();
  // Settled positions come with the anchors they balance under, for the page to hand back
  // when it restarts the same graph and clustering from them.
  const anchors = settled ? sim.anchors() : null;
  const reply: WorkerReply = {
    type: "positions",
    id,
    rev,
    xs,
    ys,
    settled,
    ...(anchors ? { anchors } : {}),
  };
  const transfer = anchors ? [xs.buffer, ys.buffer, anchors.buffer] : [xs.buffer, ys.buffer];
  scope.postMessage(reply, transfer);
  lastPost = performance.now();
}

function postRegions(run: Run): void {
  const assign = run.regions.assign.slice();
  const reply: WorkerReply = { type: "regions", id: run.id, assign, count: run.regions.count };
  scope.postMessage(reply, [assign.buffer]);
}

/** A key for a graph: its size, seed and links, hashed two ways so a clash is out of reach. */
function graphKey(n: number, edges: ReadonlyArray<readonly [number, number]>, seed: number) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const [a, b] of edges) {
    h1 = Math.imul(h1 ^ a, 0x01000193);
    h1 = Math.imul(h1 ^ b, 0x01000193);
    h2 = Math.imul(h2 ^ b, 0x5bd1e995);
    h2 = Math.imul(h2 ^ a, 0x5bd1e995);
  }
  return `${seed}:${n}:${edges.length}:${h1 >>> 0}:${h2 >>> 0}`;
}

function regionsFor(n: number, edges: ReadonlyArray<readonly [number, number]>, seed: number) {
  const key = graphKey(n, edges, seed);
  const hit = regionCache.get(key);
  if (hit) {
    regionCache.delete(key);
    regionCache.set(key, hit);
    return hit;
  }
  const found = detectCommunities(n, edges, seed);
  regionCache.set(key, found);
  if (regionCache.size > REGION_CACHE_SIZE) {
    const oldest = regionCache.keys().next().value;
    if (oldest !== undefined) regionCache.delete(oldest);
  }
  return found;
}

function clustersFor(mode: ClusterMode, groups: Int32Array | undefined, regions: Communities) {
  if (mode === "regions") return regions.assign;
  if (mode === "groups" && groups) return groups;
  return null;
}

function run(): void {
  timer = null;
  const active = current;
  if (!active) return;
  const { sim } = active;
  if (active.live) {
    const started = performance.now();
    sim.tick();
    postPositions(active);
    if (sim.settled) {
      active.live = false;
      return;
    }
    schedule(Math.max(0, FRAME_MS - (performance.now() - started)));
    return;
  }
  const end = performance.now() + SLICE_MS;
  while (!sim.settled && performance.now() < end) sim.tick();
  if (sim.settled) {
    postPositions(active);
    return;
  }
  if (performance.now() - lastPost >= POST_EVERY_MS) postPositions(active);
  schedule();
}

/** Runs soon, unless a run is already due: a frame-paced tick keeps its own time. */
function schedule(delay = 0): void {
  if (timer === null) timer = setTimeout(run, delay);
}

function cancel(): void {
  if (timer === null) return;
  clearTimeout(timer);
  timer = null;
}

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === "start") {
    const { id, n, edges, seed, forces, initial, clusters, alpha } = message;
    const regions = regionsFor(n, edges, seed);
    const assign = clustersFor(clusters.mode, clusters.groups, regions) ?? undefined;
    const sim = new Simulation({ n, edges, seed, initial, clusters: assign }, forces);
    // A layout woken at rest for a drag stays still until the drag's alpha target warms it.
    if (alpha !== undefined) sim.reheat(alpha);
    current = { id, rev: 0, sim, regions, live: false };
    postRegions(current);
    lastPost = 0;
    cancel();
    schedule();
    return;
  }
  // Everything else is for the current run only: a stale id is a run that has been replaced.
  if (current?.id !== message.id) return;
  const active = current;
  switch (message.type) {
    case "forces":
      active.rev = message.rev;
      active.sim.setForces(message.forces);
      break;
    case "clusters":
      active.rev = message.rev;
      active.sim.setClusters(clustersFor(message.mode, message.groups, active.regions));
      break;
    case "drag":
      if (!active.sim.pin(message.index, message.x, message.y)) return;
      active.sim.setAlphaTarget(DRAG_ALPHA);
      active.live = true;
      break;
    case "release":
      active.sim.unpin(message.index);
      active.sim.setAlphaTarget(0);
      break;
    case "stop":
      current = null;
      cancel();
      return;
  }
  // A settled simulation posts once more, so the page learns it rests under the new revision.
  schedule();
};

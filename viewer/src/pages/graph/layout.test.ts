import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphData, GraphNode } from "../../api";
import { DEFAULT_FORCES, type Forces } from "./forces";
import {
  alignPositions,
  type Clustering,
  clearLayoutCache,
  type LiveLayout,
  matchRegions,
  useLiveLayout,
  type WorkerReply,
  type WorkerRequest,
} from "./layout";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const node = (key: string): GraphNode => ({
  key,
  domain: "t",
  title: key,
  kind: "decision",
  status: "active",
  degree: 0,
  tags: [],
  updatedAt: "2026-11-01T10:00:00Z",
});

const graph = (keys: string[]): GraphData => ({
  nodes: keys.map(node),
  edges: keys
    .slice(1)
    .map((k) => ({ source: k, target: keys[0] ?? k, relation: "related", suggested: false })),
});

/** A stand-in Worker that records messages and lets the test answer them. */
class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((event: { data: WorkerReply }) => void) | null = null;
  onerror: (() => void) | null = null;
  messages: WorkerRequest[] = [];
  terminated = false;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(message: WorkerRequest) {
    this.messages.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  starts() {
    return this.messages.filter((m) => m.type === "start");
  }
  lastStart() {
    const s = this.starts();
    return s[s.length - 1] as Extract<WorkerRequest, { type: "start" }> | undefined;
  }
  sent<T extends WorkerRequest["type"]>(type: T) {
    return this.messages.filter((m): m is Extract<WorkerRequest, { type: T }> => m.type === type);
  }
  /** The settings revision the worker last heard for a run, as the real worker tracks it. */
  rev(id: number) {
    let rev = 0;
    for (const m of this.messages) {
      if (m.type === "start" && m.id === id) rev = 0;
      if ((m.type === "forces" || m.type === "clusters") && m.id === id) rev = m.rev;
    }
    return rev;
  }
  reply(
    id: number,
    settled: boolean,
    n = this.lastStart()?.n ?? 0,
    rev = this.rev(id),
    anchors?: Float64Array,
  ) {
    const xs = Float64Array.from({ length: n }, (_, i) => i * 10);
    const ys = xs.slice();
    this.onmessage?.({ data: { type: "positions", id, rev, xs, ys, settled, anchors } });
  }
  /** Regions in layout order (sorted keys), as the worker posts them at a run's start. */
  regions(id: number, assign: number[]) {
    const count = Math.max(-1, ...assign) + 1;
    this.onmessage?.({ data: { type: "regions", id, assign: Int32Array.from(assign), count } });
  }
}

interface Props {
  domain: string;
  data: GraphData;
  forces: Forces;
  clustering?: Clustering;
}

let seen: LiveLayout[] = [];
let renders = 0;

function Probe(props: Props) {
  renders += 1;
  seen.push(useLiveLayout(props.domain, props.data, props.forces, props.clustering));
  return null;
}

function mountHook(initial: Props) {
  seen = [];
  renders = 0;
  const root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Probe, initial)));
  return {
    rerender: (p: Props) => act(() => root.render(createElement(Probe, p))),
    unmount: () => act(() => root.unmount()),
    last: () => seen[seen.length - 1] as LiveLayout,
  };
}

describe("useLiveLayout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeWorker.all = [];
    clearLayoutCache();
  });

  it("lays out synchronously without Worker", () => {
    vi.stubGlobal("Worker", undefined);
    const h = mountHook({ domain: "demo", data: graph(["a", "b", "c"]), forces: DEFAULT_FORCES });
    expect(h.last().ready).toBe(true);
    expect(h.last().settled).toBe(true);
    const current = h.last().current();
    expect(current?.keys).toEqual(["a", "b", "c"]);
    expect(Array.from(current?.xs ?? []).every(Number.isFinite)).toBe(true);
    // New forces settle again synchronously.
    h.rerender({
      domain: "demo",
      data: graph(["a", "b", "c"]),
      forces: { ...DEFAULT_FORCES, repel: 20 },
    });
    expect(h.last().settled).toBe(true);
    h.unmount();
  });

  it("streams positions outside React and sends forces to the same worker", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const data = graph(["a", "b", "c"]);
    const h = mountHook({ domain: "demo", data, forces: DEFAULT_FORCES });
    expect(h.last().ready).toBe(false);
    const worker = FakeWorker.all[0] as FakeWorker;
    const id = worker.lastStart()?.id ?? 0;
    const heard = vi.fn();
    h.last().subscribe(heard);

    act(() => worker.reply(id, false));
    expect(heard).toHaveBeenCalledTimes(1);
    expect(h.last().ready).toBe(true);
    const before = renders;
    act(() => worker.reply(id, false));
    expect(heard).toHaveBeenCalledTimes(2);
    expect(renders).toBe(before); // a progress post re-renders nothing

    h.rerender({ domain: "demo", data, forces: { ...DEFAULT_FORCES, repel: 15 } });
    expect(FakeWorker.all).toHaveLength(1);
    expect(worker.starts()).toHaveLength(1);
    expect(worker.messages[worker.messages.length - 1]).toEqual({
      type: "forces",
      id,
      rev: 1,
      forces: { ...DEFAULT_FORCES, repel: 15 },
    });
    expect(h.last().settled).toBe(false);
    act(() => worker.reply(id, true));
    expect(h.last().settled).toBe(true);
    h.unmount();
    expect(worker.terminated).toBe(true);
  });

  it("warm-starts a data change and ignores stale replies", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const h = mountHook({ domain: "demo", data: graph(["a", "b", "c"]), forces: DEFAULT_FORCES });
    const worker = FakeWorker.all[0] as FakeWorker;
    const oldId = worker.lastStart()?.id ?? 0;
    act(() => worker.reply(oldId, false));

    h.rerender({ domain: "demo", data: graph(["a", "b", "d"]), forces: DEFAULT_FORCES });
    expect(FakeWorker.all).toHaveLength(1);
    expect(worker.messages).toContainEqual({ type: "stop", id: oldId });
    const next = worker.lastStart();
    expect(next?.id).not.toBe(oldId);
    expect(Array.from(next?.initial?.known ?? [])).toEqual([1, 1, 0]);
    expect(next?.initial?.xs[1]).toBe(10); // b keeps its old spot

    // The warm start is published straight away, aligned with the new keys.
    expect(h.last().ready).toBe(true);
    expect(h.last().current()?.keys).toEqual(["a", "b", "d"]);
    expect(h.last().current()?.xs[1]).toBe(10);

    const heard = vi.fn();
    h.last().subscribe(heard);
    act(() => worker.reply(oldId, true));
    expect(heard).not.toHaveBeenCalled();
    act(() => worker.reply(next?.id ?? 0, true));
    expect(h.last().current()?.keys).toEqual(["a", "b", "d"]);
    h.unmount();
  });

  it("does not trust a settled reply computed under older forces", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const data = graph(["a", "b", "c"]);
    const h = mountHook({ domain: "demo", data, forces: DEFAULT_FORCES });
    const worker = FakeWorker.all[0] as FakeWorker;
    const id = worker.lastStart()?.id ?? 0;
    act(() => worker.reply(id, false));
    const moved = { ...DEFAULT_FORCES, repel: 15 };
    h.rerender({ domain: "demo", data, forces: moved });
    // The old run's settled post arrives after the forces change.
    act(() => worker.reply(id, true, 3, 0));
    expect(h.last().settled).toBe(false);
    h.unmount();

    // Nothing was cached under the new forces: reopening starts a simulation.
    const again = mountHook({ domain: "demo", data, forces: moved });
    expect(again.last().settled).toBe(false);
    expect(FakeWorker.all[1]?.starts()).toHaveLength(1);
    again.unmount();
  });

  it("terminates on area change and reopens a settled area from the cache", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const first = graph(["a", "b"]);
    const h = mountHook({ domain: "demo", data: first, forces: DEFAULT_FORCES });
    const worker = FakeWorker.all[0] as FakeWorker;
    act(() => worker.reply(worker.lastStart()?.id ?? 0, true));

    h.rerender({ domain: "other", data: graph(["x"]), forces: DEFAULT_FORCES });
    expect(worker.terminated).toBe(true);
    expect(h.last().ready).toBe(false);

    h.rerender({ domain: "demo", data: first, forces: DEFAULT_FORCES });
    expect(h.last().ready).toBe(true);
    expect(h.last().settled).toBe(true);
    expect(FakeWorker.all.slice(2).every((w) => w.starts().length === 0)).toBe(true);
    h.unmount();
  });

  it("falls back to a synchronous settle when the worker fails", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const h = mountHook({ domain: "demo", data: graph(["a", "b"]), forces: DEFAULT_FORCES });
    act(() => FakeWorker.all[0]?.onerror?.());
    expect(h.last().settled).toBe(true);
    expect(h.last().current()?.keys).toEqual(["a", "b"]);
    h.unmount();
  });
});

describe("useLiveLayout dragging", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeWorker.all = [];
    clearLayoutCache();
  });

  it("sends drag and release to the running simulation", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const h = mountHook({ domain: "demo", data: graph(["a", "b", "c"]), forces: DEFAULT_FORCES });
    const worker = FakeWorker.all[0] as FakeWorker;
    const id = worker.lastStart()?.id ?? 0;
    act(() => worker.reply(id, true));
    expect(h.last().settled).toBe(true);

    act(() => h.last().drag("b", 5, -6));
    expect(worker.sent("drag")).toEqual([{ type: "drag", id, index: 1, x: 5, y: -6 }]);
    // Held live while dragged, so the page knows the notes are moving.
    expect(h.last().settled).toBe(false);
    // A settled post sent before the worker heard of the drag does not end it.
    act(() => worker.reply(id, true));
    expect(h.last().settled).toBe(false);
    act(() => h.last().drag("b", 7, -6));
    act(() => h.last().release("b"));
    expect(worker.sent("drag")).toHaveLength(2);
    expect(worker.sent("release")).toEqual([{ type: "release", id, index: 1 }]);
    // Positions keep streaming into the same run, then it settles.
    act(() => worker.reply(id, false));
    act(() => worker.reply(id, true));
    expect(h.last().settled).toBe(true);
    expect(worker.starts()).toHaveLength(1);

    // Unknown notes and broken points are ignored.
    act(() => h.last().drag("zzz", 1, 1));
    act(() => h.last().drag("a", Number.NaN, 1));
    act(() => h.last().release("zzz"));
    expect(worker.sent("drag")).toHaveLength(2);
    expect(worker.sent("release")).toHaveLength(1);
    h.unmount();
  });

  it("wakes a simulation at rest to drag a note of a cached layout", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const data = graph(["a", "b", "c"]);
    const groups: Clustering = { mode: "groups", groups: Int32Array.of(0, 0, 1) };
    const props = { domain: "demo", data, forces: DEFAULT_FORCES, clustering: groups };
    const first = mountHook(props);
    const w0 = FakeWorker.all[0] as FakeWorker;
    const anchors = Float64Array.of(-1, 0, 2, 0);
    act(() => w0.reply(w0.lastStart()?.id ?? 0, true, 3, 0, anchors));
    first.unmount();

    const h = mountHook(props);
    expect(h.last().settled).toBe(true);
    expect(FakeWorker.all).toHaveLength(1); // a cache hit needs no worker
    act(() => h.last().drag("c", 3, 4));
    const worker = FakeWorker.all[1] as FakeWorker;
    const start = worker.lastStart();
    // Warm from the positions on screen and the anchors they settled under, but at rest, so
    // only the drag warms it, then the drag, both for the new run.
    expect(Array.from(start?.initial?.known ?? [])).toEqual([1, 1, 1]);
    expect(start?.initial?.anchors).toEqual(anchors);
    expect(start?.alpha).toBe(0);
    expect(worker.messages.slice(-1)).toEqual([
      { type: "drag", id: start?.id, index: 2, x: 3, y: 4 },
    ]);
    h.unmount();
  });

  it("never settles synchronously for a drag when no worker can start", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const data = graph(["a", "b", "c"]);
    const first = mountHook({ domain: "demo", data, forces: DEFAULT_FORCES });
    const w0 = FakeWorker.all[0] as FakeWorker;
    act(() => w0.reply(w0.lastStart()?.id ?? 0, true));
    first.unmount();

    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw new Error("blocked");
        }
      },
    );
    const h = mountHook({ domain: "demo", data, forces: DEFAULT_FORCES });
    const before = Array.from(h.last().current()?.xs ?? []);
    act(() => h.last().drag("c", 3, 4));
    // Only the note moves; the rest of the cached layout stays as it was.
    expect(Array.from(h.last().current()?.xs ?? [])).toEqual([before[0], before[1], 3]);
    expect(h.last().settled).toBe(true);
    h.unmount();
  });

  it("moves only the note without a worker, leaving the cached layout as it was", () => {
    vi.stubGlobal("Worker", undefined);
    const data = graph(["a", "b", "c"]);
    const h = mountHook({ domain: "demo", data, forces: DEFAULT_FORCES });
    const before = Array.from(h.last().current()?.xs ?? []);
    const heard = vi.fn();
    h.last().subscribe(heard);
    act(() => h.last().drag("b", 999, 777));
    act(() => h.last().drag("b", 1000, 778));
    expect(heard).toHaveBeenCalledTimes(2);
    expect(h.last().current()?.xs[1]).toBe(1000);
    expect(h.last().current()?.ys[1]).toBe(778);
    expect(h.last().current()?.xs[0]).toBe(before[0]);
    act(() => h.last().release("b"));
    h.unmount();

    const again = mountHook({ domain: "demo", data, forces: DEFAULT_FORCES });
    expect(Array.from(again.last().current()?.xs ?? [])).toEqual(before);
    again.unmount();
  });

  it("moves only the note under reduced motion", () => {
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") }));
    const h = mountHook({ domain: "demo", data: graph(["a", "b"]), forces: DEFAULT_FORCES });
    const worker = FakeWorker.all[0] as FakeWorker;
    const id = worker.lastStart()?.id ?? 0;
    act(() => worker.reply(id, true));
    act(() => h.last().drag("a", 50, 60));
    act(() => h.last().drag("a", 51, 60));
    expect(worker.sent("drag")).toHaveLength(0);
    expect([h.last().current()?.xs[0], h.last().current()?.ys[0]]).toEqual([51, 60]);
    // A late reply does not pull the held note back while it is dragged.
    act(() => worker.reply(id, true));
    expect(h.last().current()?.xs[0]).toBe(51);
    // On release the worker learns where the note was left, once.
    act(() => h.last().release("a"));
    expect(worker.sent("drag")).toEqual([{ type: "drag", id, index: 0, x: 51, y: 60 }]);
    expect(worker.sent("release")).toEqual([{ type: "release", id, index: 0 }]);
    h.unmount();
  });

  it("lands a settle held back by a drag under reduced motion", () => {
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") }));
    const data = graph(["a", "b"]);
    const h = mountHook({ domain: "demo", data, forces: DEFAULT_FORCES });
    const worker = FakeWorker.all[0] as FakeWorker;
    const id = worker.lastStart()?.id ?? 0;
    act(() => worker.reply(id, true));
    const moved = { ...DEFAULT_FORCES, repel: 15 };
    h.rerender({ domain: "demo", data, forces: moved });
    expect(h.last().settled).toBe(false);
    act(() => h.last().drag("a", 50, 60));
    // The worker settles under the new forces mid-drag: held back, so the note stays put.
    act(() => worker.reply(id, true));
    expect(h.last().settled).toBe(false);
    act(() => h.last().release("a"));
    expect(worker.sent("drag")).toEqual([{ type: "drag", id, index: 0, x: 50, y: 60 }]);
    // Its next post, with the note where it was left, is the settled layout, kept for later.
    act(() => worker.reply(id, true));
    expect(h.last().settled).toBe(true);
    h.unmount();
    const again = mountHook({ domain: "demo", data, forces: moved });
    expect(again.last().settled).toBe(true);
    expect(FakeWorker.all).toHaveLength(1);
    again.unmount();
  });
});

describe("useLiveLayout regions and clusters", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeWorker.all = [];
    clearLayoutCache();
  });

  it("reports regions in data order and bumps the version only when they change", () => {
    vi.stubGlobal("Worker", FakeWorker);
    // Data order c, a, b; the layout works on sorted keys a, b, c.
    const data = graph(["c", "a", "b"]);
    const h = mountHook({ domain: "demo", data, forces: DEFAULT_FORCES });
    const worker = FakeWorker.all[0] as FakeWorker;
    const id = worker.lastStart()?.id ?? 0;
    expect(h.last().regions()).toBeNull();
    const version = h.last().regionsVersion;
    const heard = vi.fn();
    h.last().subscribe(heard);

    act(() => worker.regions(id + 100, [0, 0, 0])); // a stale run
    expect(h.last().regions()).toBeNull();
    act(() => worker.regions(id, [0, 1, -1]));
    expect(heard).toHaveBeenCalledTimes(1);
    expect(h.last().regionsVersion).toBe(version + 1);
    expect(Array.from(h.last().regions()?.assign ?? [])).toEqual([-1, 0, 1]);
    expect(h.last().regions()?.count).toBe(2);
    expect(h.last().regions()).toBe(h.last().regions()); // the same answer until a change

    // The same graph's regions again (a restart) change nothing.
    act(() => worker.regions(id, [0, 1, -1]));
    expect(h.last().regionsVersion).toBe(version + 1);

    // New notes: the old regions still answer by key until the new ones arrive.
    h.rerender({ domain: "demo", data: graph(["c", "a", "d"]), forces: DEFAULT_FORCES });
    expect(Array.from(h.last().regions()?.assign ?? [])).toEqual([-1, 0, -1]);
    const next = worker.lastStart()?.id ?? 0;
    act(() => worker.regions(next, [0, 0, 0]));
    expect(h.last().regionsVersion).toBe(version + 2);
    expect(Array.from(h.last().regions()?.assign ?? [])).toEqual([0, 0, 0]);
    h.unmount();
  });

  it("starts with the clustering and changes it without a restart", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const data = graph(["c", "a", "b"]);
    const regions: Clustering = { mode: "regions", groups: null };
    const h = mountHook({ domain: "demo", data, forces: DEFAULT_FORCES, clustering: regions });
    const worker = FakeWorker.all[0] as FakeWorker;
    const id = worker.lastStart()?.id ?? 0;
    expect(worker.lastStart()?.clusters).toEqual({ mode: "regions" });
    act(() => worker.reply(id, true));

    // Groups come in data order (c, a, b) and go to the worker in layout order (a, b, c).
    const groups = Int32Array.of(2, 0, -1);
    h.rerender({
      domain: "demo",
      data,
      forces: DEFAULT_FORCES,
      clustering: { mode: "groups", groups },
    });
    expect(worker.starts()).toHaveLength(1);
    expect(worker.sent("clusters")).toEqual([
      { type: "clusters", id, rev: 1, mode: "groups", groups: Int32Array.of(0, -1, 2) },
    ]);
    expect(h.last().settled).toBe(false);
    // The same groups in a new array change nothing.
    h.rerender({
      domain: "demo",
      data,
      forces: DEFAULT_FORCES,
      clustering: { mode: "groups", groups: Int32Array.of(2, 0, -1) },
    });
    expect(worker.sent("clusters")).toHaveLength(1);
    // A settled reply from before the change is not trusted; one after it is.
    act(() => worker.reply(id, true, 3, 0));
    expect(h.last().settled).toBe(false);
    act(() => worker.reply(id, true));
    expect(h.last().settled).toBe(true);

    h.rerender({ domain: "demo", data, forces: DEFAULT_FORCES });
    expect(worker.sent("clusters").at(-1)).toEqual({ type: "clusters", id, rev: 2, mode: "none" });
    expect(worker.starts()).toHaveLength(1);
    h.unmount();
  });

  it("caches positions per clustering, shared by all when there is no separation", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const data = graph(["a", "b", "c"]);
    const groups: Clustering = { mode: "groups", groups: Int32Array.of(0, 0, 1) };
    const settleOnce = (props: Props) => {
      const h = mountHook(props);
      const worker = FakeWorker.all.at(-1) as FakeWorker;
      act(() => worker.reply(worker.lastStart()?.id ?? 0, true));
      h.unmount();
    };
    settleOnce({ domain: "demo", data, forces: DEFAULT_FORCES, clustering: groups });
    const other = mountHook({ domain: "demo", data, forces: DEFAULT_FORCES });
    expect(other.last().settled).toBe(false); // separated by groups is not the plain layout
    other.unmount();
    const same = mountHook({ domain: "demo", data, forces: DEFAULT_FORCES, clustering: groups });
    expect(same.last().settled).toBe(true);
    same.unmount();

    const still = { ...DEFAULT_FORCES, separation: 0 };
    settleOnce({ domain: "demo", data, forces: still, clustering: groups });
    const plain = mountHook({ domain: "demo", data, forces: still });
    expect(plain.last().settled).toBe(true);
    plain.unmount();
  });

  it("keeps region numbers when a filter changes the graph", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const h = mountHook({
      domain: "demo",
      data: graph(["a", "b", "c", "d"]),
      forces: DEFAULT_FORCES,
    });
    const worker = FakeWorker.all[0] as FakeWorker;
    act(() => worker.regions(worker.lastStart()?.id ?? 0, [0, 0, 1, 1]));
    // Without a, and with e joining c and d: found afresh, that region is the largest now.
    h.rerender({ domain: "demo", data: graph(["b", "c", "d", "e"]), forces: DEFAULT_FORCES });
    act(() => worker.regions(worker.lastStart()?.id ?? 0, [1, 0, 0, 0]));
    expect(Array.from(h.last().regions()?.assign ?? [])).toEqual([0, 1, 1, 1]);
    expect(h.last().regions()?.count).toBe(2);
    h.unmount();
  });

  it("hands back a settled layout's anchors only for the same graph and clustering", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const data = graph(["a", "b", "c"]);
    const groups: Clustering = { mode: "groups", groups: Int32Array.of(0, 0, 1) };
    const anchors = Float64Array.of(-1, 0, 2, 0);
    const first = mountHook({ domain: "demo", data, forces: DEFAULT_FORCES, clustering: groups });
    const w0 = FakeWorker.all[0] as FakeWorker;
    act(() => w0.reply(w0.lastStart()?.id ?? 0, true, 3, 0, anchors));
    first.unmount();

    // A slider moved on the cached layout: warm, with the anchors, as a running one keeps them.
    const h = mountHook({ domain: "demo", data, forces: DEFAULT_FORCES, clustering: groups });
    const repel = { ...DEFAULT_FORCES, repel: 15 };
    h.rerender({ domain: "demo", data, forces: repel, clustering: groups });
    const worker = FakeWorker.all[1] as FakeWorker;
    expect(worker.lastStart()?.initial?.anchors).toEqual(anchors);
    expect(worker.lastStart()?.alpha).toBeUndefined();
    h.unmount();

    // Other clusters, or other notes, find their anchors anew.
    const other = mountHook({ domain: "demo", data, forces: DEFAULT_FORCES, clustering: groups });
    other.rerender({
      domain: "demo",
      data,
      forces: DEFAULT_FORCES,
      clustering: { mode: "groups", groups: Int32Array.of(0, 1, 1) },
    });
    const w2 = FakeWorker.all[2] as FakeWorker;
    expect(w2.lastStart()?.initial?.known).toBeDefined();
    expect(w2.lastStart()?.initial?.anchors).toBeUndefined();
    other.rerender({ domain: "demo", data: graph(["a", "b", "d"]), forces: DEFAULT_FORCES });
    expect(w2.lastStart()?.initial?.anchors).toBeUndefined();
    other.unmount();
  });

  it("leaves a cached layout still when the clustering changes with no separation", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const data = graph(["a", "b", "c"]);
    const still = { ...DEFAULT_FORCES, separation: 0 };
    const first = mountHook({ domain: "demo", data, forces: still });
    const w0 = FakeWorker.all[0] as FakeWorker;
    act(() => w0.reply(w0.lastStart()?.id ?? 0, true));
    first.unmount();

    const regions: Clustering = { mode: "regions", groups: null };
    const h = mountHook({ domain: "demo", data, forces: still });
    h.rerender({
      domain: "demo",
      data,
      forces: still,
      clustering: { mode: "groups", groups: Int32Array.of(0, 0, 1) },
    });
    h.rerender({ domain: "demo", data, forces: still, clustering: regions });
    expect(FakeWorker.all).toHaveLength(1); // nothing woken
    expect(h.last().settled).toBe(true);
    // Raising separation starts warm, sorting by the clustering it was given meanwhile.
    h.rerender({ domain: "demo", data, forces: DEFAULT_FORCES, clustering: regions });
    const start = (FakeWorker.all[1] as FakeWorker).lastStart();
    expect(start?.clusters).toEqual({ mode: "regions" });
    expect(Array.from(start?.initial?.known ?? [])).toEqual([1, 1, 1]);
    h.unmount();
  });

  it("finds regions and separates by them without a worker", () => {
    vi.stubGlobal("Worker", undefined);
    // Two triangles joined by one link, listed out of order.
    const keys = ["f", "a", "e", "b", "d", "c"];
    const link = (source: string, target: string) => ({
      source,
      target,
      relation: "related",
      suggested: false,
    });
    const data: GraphData = {
      nodes: keys.map(node),
      edges: [
        link("a", "b"),
        link("b", "c"),
        link("c", "a"),
        link("d", "e"),
        link("e", "f"),
        link("f", "d"),
        link("c", "d"),
      ],
    };
    const h = mountHook({
      domain: "demo",
      data,
      forces: DEFAULT_FORCES,
      clustering: { mode: "regions", groups: null },
    });
    expect(h.last().settled).toBe(true);
    const assign = Array.from(h.last().regions()?.assign ?? []);
    const of = (k: string) => assign[keys.indexOf(k)];
    expect(h.last().regions()?.count).toBe(2);
    expect(new Set(["a", "b", "c"].map(of)).size).toBe(1);
    expect(new Set(["d", "e", "f"].map(of)).size).toBe(1);
    expect(of("a")).not.toBe(of("d"));
    h.unmount();
  });
});

describe("useLiveLayout under reduced motion", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeWorker.all = [];
    clearLayoutCache();
  });

  it("shows only the settled positions", () => {
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") }));
    const h = mountHook({ domain: "demo", data: graph(["a", "b"]), forces: DEFAULT_FORCES });
    const worker = FakeWorker.all[0] as FakeWorker;
    const id = worker.lastStart()?.id ?? 0;
    const heard = vi.fn();
    h.last().subscribe(heard);
    act(() => worker.reply(id, false));
    expect(heard).not.toHaveBeenCalled();
    expect(h.last().settled).toBe(false);
    act(() => worker.reply(id, true));
    expect(heard).toHaveBeenCalledTimes(1);
    expect(h.last().settled).toBe(true);
    h.unmount();
  });
});

describe("matchRegions", () => {
  it("keeps each region's number by the notes it shares with the one before", () => {
    const previous = {
      keys: ["a", "b", "c", "d", "e", "f"],
      assign: Int32Array.of(0, 0, 1, 1, 2, -1),
      count: 3,
    };
    // Found afresh and numbered by size: the old region 1 grew, so it comes first now.
    const next = {
      keys: ["a", "c", "d", "e", "g", "h"],
      assign: Int32Array.of(1, 0, 0, 2, 0, -1),
      count: 3,
    };
    expect(Array.from(matchRegions(previous, next))).toEqual([0, 1, 1, 2, 1, -1]);
  });

  it("gives the free numbers to the rest, within the new count", () => {
    const previous = { keys: ["a", "b", "c", "d"], assign: Int32Array.of(0, 1, 2, 2), count: 3 };
    // Region 1 is gone, and two numbers are left: region 2 cannot keep its number.
    const next = { keys: ["a", "c", "d", "x"], assign: Int32Array.of(1, 0, 0, -1), count: 2 };
    expect(Array.from(matchRegions(previous, next))).toEqual([0, 1, 1, -1]);
    // Nothing shared: the numbers stay as they are.
    const none = { keys: ["p", "q"], assign: Int32Array.of(1, 0), count: 2 };
    expect(Array.from(matchRegions(previous, none))).toEqual([1, 0]);
  });
});

describe("alignPositions", () => {
  it("puts notes the layout does not know next to a linked note, never at 0,0", () => {
    const xs = new Float64Array(3);
    const ys = new Float64Array(3);
    const from = Int32Array.from([0, -1, -1]);
    alignPositions(from, Float64Array.of(50), Float64Array.of(70), [{ a: 0, b: 1 }], xs, ys);
    expect([xs[0], ys[0]]).toEqual([50, 70]);
    expect([xs[1], ys[1]]).toEqual([50, 70]);
    expect(xs[2] !== 0 || ys[2] !== 0).toBe(true);
  });
});

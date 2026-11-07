import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphData, GraphNode } from "../../api";
import { DEFAULT_FORCES, type Forces } from "./forces";
import {
  alignPositions,
  clearLayoutCache,
  type LiveLayout,
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
  /** The forces revision the worker last heard for a run, as the real worker tracks it. */
  rev(id: number) {
    let rev = 0;
    for (const m of this.messages) {
      if (m.type === "start" && m.id === id) rev = 0;
      if (m.type === "forces" && m.id === id) rev = m.rev;
    }
    return rev;
  }
  reply(id: number, settled: boolean, n = this.lastStart()?.n ?? 0, rev = this.rev(id)) {
    const xs = Float64Array.from({ length: n }, (_, i) => i * 10);
    this.onmessage?.({ data: { id, rev, xs, ys: xs.slice(), settled } });
  }
}

interface Props {
  domain: string;
  data: GraphData;
  forces: Forces;
}

let seen: LiveLayout[] = [];
let renders = 0;

function Probe(props: Props) {
  renders += 1;
  seen.push(useLiveLayout(props.domain, props.data, props.forces));
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

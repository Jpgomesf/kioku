import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { detectCommunities } from "./communities";
import { DEFAULT_FORCES } from "./forces";
import type { WorkerReply, WorkerRequest } from "./layout";

// Counted, so the tests can tell a cached graph's regions from freshly found ones.
vi.mock("./communities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./communities")>();
  return { ...actual, detectCommunities: vi.fn(actual.detectCommunities) };
});

type Positions = Extract<WorkerReply, { type: "positions" }>;

let replies: WorkerReply[] = [];
const positions = () => replies.filter((r): r is Positions => r.type === "positions");
const last = () => positions().at(-1) as Positions;

function send(message: WorkerRequest) {
  const handler = self.onmessage as ((event: MessageEvent<WorkerRequest>) => void) | null;
  handler?.({ data: message } as MessageEvent<WorkerRequest>);
}

/** Two triangles joined by one link, and a note with no links. */
const n = 7;
const edges: Array<[number, number]> = [
  [0, 1],
  [1, 2],
  [0, 2],
  [3, 4],
  [4, 5],
  [3, 5],
  [2, 3],
];

let nextId = 1;
function start(clusters: Extract<WorkerRequest, { type: "start" }>["clusters"], graph = edges) {
  const id = nextId;
  nextId += 1;
  send({ type: "start", id, n, edges: graph, seed: 9, forces: DEFAULT_FORCES, clusters });
  return id;
}

/** Runs the worker's timers, as its event loop would, for `ms` of fake time. */
function wait(ms: number) {
  vi.advanceTimersByTime(ms);
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.spyOn(self, "postMessage").mockImplementation((message: unknown) => {
    replies.push(message as WorkerReply);
  });
  await import("./layout.worker");
});

afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(() => {
  replies = [];
});

describe("layout worker", () => {
  it("posts the graph's regions, then positions until the simulation rests", () => {
    const id = start({ mode: "regions" });
    const regions = replies[0];
    expect(regions?.type).toBe("regions");
    if (regions?.type !== "regions") return;
    expect(regions.id).toBe(id);
    expect(regions.count).toBe(2);
    expect(regions.assign[6]).toBe(-1);
    wait(1);
    expect(last()).toMatchObject({ id, rev: 0, settled: true });
  });

  it("keeps the graph live while a note is dragged, posting every frame, then settles", () => {
    const id = start({ mode: "none" });
    wait(1);
    const rest = last();
    replies = [];
    // Note 0 dragged far to the right: its triangle should follow.
    const x = (rest.xs[0] as number) + 2000;
    const y = rest.ys[0] as number;
    send({ type: "drag", id, index: 0, x, y });
    wait(320);
    const live = positions();
    expect(live.length).toBeGreaterThanOrEqual(320 / 32);
    expect(live.every((r) => !r.settled && r.xs[0] === x && r.ys[0] === y)).toBe(true);
    const gap = (r: Positions) => Math.hypot((r.xs[1] as number) - x, (r.ys[1] as number) - y);
    expect(gap(last())).toBeLessThan(gap(rest) * 0.9);
    // Still live long after: a drag never settles on its own.
    send({ type: "drag", id, index: 0, x, y: y + 10 });
    wait(5000);
    expect(last().settled).toBe(false);
    expect(last().ys[0]).toBe(y + 10);

    send({ type: "release", id, index: 0 });
    wait(10000);
    expect(last().settled).toBe(true);
    expect(last().id).toBe(id);
    // Free again, the note was pulled back towards its triangle.
    expect(last().xs[0]).not.toBe(x);
  });

  it("changes clusters and forces in the same run, under a new revision", () => {
    const id = start({ mode: "none" });
    wait(1);
    replies = [];
    send({
      type: "clusters",
      id,
      rev: 1,
      mode: "groups",
      groups: Int32Array.of(0, 0, 0, 1, 1, 1, -1),
    });
    wait(1);
    expect(replies.some((r) => r.type === "regions")).toBe(false);
    expect(last()).toMatchObject({ id, rev: 1, settled: true });
    send({ type: "clusters", id, rev: 2, mode: "regions" });
    send({ type: "forces", id, rev: 3, forces: { ...DEFAULT_FORCES, separation: 0 } });
    wait(1);
    expect(last()).toMatchObject({ id, rev: 3, settled: true });
    // With no separation a clusters change moves nothing, but still reports where it rests.
    replies = [];
    send({ type: "clusters", id, rev: 4, mode: "none" });
    wait(1);
    expect(positions()).toHaveLength(1);
    expect(last()).toMatchObject({ id, rev: 4, settled: true });
  });

  it("ignores messages for a run it has replaced, and stops", () => {
    const old = start({ mode: "none" });
    const id = start({ mode: "none" });
    wait(1);
    replies = [];
    send({ type: "drag", id: old, index: 0, x: 1, y: 1 });
    send({ type: "forces", id: old, rev: 1, forces: DEFAULT_FORCES });
    send({ type: "clusters", id: old, rev: 1, mode: "regions" });
    send({ type: "release", id: old, index: 0 });
    send({ type: "stop", id: old });
    wait(100);
    expect(replies).toHaveLength(0);
    // Bad drags are ignored too.
    send({ type: "drag", id, index: 99, x: 1, y: 1 });
    wait(100);
    expect(replies).toHaveLength(0);
    send({ type: "drag", id, index: 0, x: 1, y: 1 });
    send({ type: "stop", id });
    wait(1000);
    expect(replies).toHaveLength(0);
  });

  it("wakes a layout at rest when asked, so a drag warms it gently", () => {
    start({ mode: "none" });
    wait(1);
    const rest = last();
    const initial = { xs: rest.xs.slice(), ys: rest.ys.slice(), known: new Uint8Array(n).fill(1) };
    const from = (alpha?: number) => {
      const id = nextId;
      nextId += 1;
      replies = [];
      const forces = DEFAULT_FORCES;
      const clusters = { mode: "none" } as const;
      send({ type: "start", id, n, edges, seed: 9, forces, initial, clusters, alpha });
      return id;
    };
    // At rest it posts once, settled, with nothing moved.
    from(0);
    wait(1);
    expect(positions()).toHaveLength(1);
    expect(last().settled).toBe(true);
    expect(Array.from(last().xs)).toEqual(Array.from(initial.xs));

    /** How far the notes away from note 0 move in the first frames of dragging it. */
    const drift = (alpha?: number) => {
      const id = from(alpha);
      const x = (initial.xs[0] as number) + 500;
      send({ type: "drag", id, index: 0, x, y: initial.ys[0] as number });
      wait(48);
      const now = last();
      let moved = 0;
      for (const i of [3, 4, 5, 6]) {
        moved += Math.hypot(
          (now.xs[i] as number) - (initial.xs[i] as number),
          (now.ys[i] as number) - (initial.ys[i] as number),
        );
      }
      send({ type: "stop", id });
      return moved;
    };
    // A warm start begins at alpha 0.3, so the rest of the graph lurches with the first frame.
    expect(drift(0)).toBeLessThan(drift() * 0.3);
  });

  it("posts the anchors with settled positions while separating, and takes them back", () => {
    const id = start({ mode: "regions" });
    wait(1);
    const anchors = last().anchors;
    expect(last()).toMatchObject({ id, settled: true });
    // Two regions, the note with no links in none.
    expect(anchors).toHaveLength(4);

    // A restart handed them carries on with the same ones.
    const again = nextId;
    nextId += 1;
    send({
      type: "start",
      id: again,
      n,
      edges,
      seed: 9,
      forces: DEFAULT_FORCES,
      initial: { xs: last().xs, ys: last().ys, known: new Uint8Array(n).fill(1), anchors },
      clusters: { mode: "regions" },
      alpha: 0,
    });
    wait(1);
    expect(last().id).toBe(again);
    expect(last().anchors).toEqual(anchors);

    // None without clusters, or while separation is off.
    start({ mode: "none" });
    wait(1);
    expect(last().anchors).toBeUndefined();
    const off = start({ mode: "regions" });
    send({ type: "forces", id: off, rev: 1, forces: { ...DEFAULT_FORCES, separation: 0 } });
    wait(1);
    expect(last()).toMatchObject({ id: off, rev: 1, settled: true });
    expect(last().anchors).toBeUndefined();
  });

  it("finds each graph's regions once", () => {
    const calls = () => vi.mocked(detectCommunities).mock.calls.length;
    const other: Array<[number, number]> = [
      [0, 1],
      [1, 2],
      [2, 0],
    ];
    start({ mode: "none" }); // seen by earlier tests
    const before = calls();
    start({ mode: "none" }, other);
    expect(calls()).toBe(before + 1);
    start({ mode: "regions" });
    start({ mode: "regions" }, other);
    expect(calls()).toBe(before + 1);
  });
});

import { describe, expect, it } from "vitest";
import type { GraphData, GraphNode } from "../../api";
import { getGraph } from "../../api/graph/mock";
import {
  centreOn,
  DOT_SPACING,
  dotGrid,
  fitCamera,
  levelFor,
  nextLevel,
  STEPS,
  stepCamera,
  toScreen,
  toWorld,
  wheelFactor,
  zoomAt,
} from "./camera";
import { clearLayoutCache, computeLayout, layoutFor, WORLD } from "./layout";
import { cardSlots, cardsFor, GROUP_AFTER, neighboursOf, neighboursWithin } from "./model";

const node = (key: string, kind: GraphNode["kind"] = "decision"): GraphNode => ({
  key,
  domain: "t",
  title: key,
  kind,
  status: "active",
  degree: 0,
});

function chainAndStar(): GraphData {
  const nodes = Array.from({ length: 30 }, (_, i) => node(`n${i}`));
  const edges = nodes.slice(1).map((n, i) => ({
    source: n.key,
    target: `n${i < 15 ? 0 : 15}`,
    relation: "related",
    suggested: false,
  }));
  return { nodes, edges };
}

describe("layout", () => {
  it("is deterministic per domain and ignores node order", () => {
    const g = chainAndStar();
    const a = computeLayout("demo", g);
    const b = computeLayout("demo", { nodes: [...g.nodes].reverse(), edges: g.edges });
    for (const [key, p] of a.positions) expect(b.positions.get(key)).toEqual(p);
  });

  it("ignores edge order, and the cache does too", () => {
    clearLayoutCache();
    const g = chainAndStar();
    const shuffled = { nodes: g.nodes, edges: [...g.edges].reverse() };
    const a = computeLayout("demo", g);
    const b = computeLayout("demo", shuffled);
    for (const [key, p] of a.positions) expect(b.positions.get(key)).toEqual(p);
    expect(layoutFor("demo", shuffled)).toBe(layoutFor("demo", g));
  });

  it("lays out empty and one-note areas", () => {
    expect(computeLayout("demo", { nodes: [], edges: [] }).positions.size).toBe(0);
    const one = computeLayout("demo", { nodes: [node("a")], edges: [] });
    expect(one.positions.get("a")).toEqual({ x: WORLD.width / 2, y: WORLD.height / 2 });
  });

  it("lays out a big area on the grid path inside the world box", () => {
    const nodes = Array.from({ length: 600 }, (_, i) => node(`b${i}`));
    const edges = nodes.slice(1).map((n, i) => ({
      source: n.key,
      target: `b${Math.floor(i / 4)}`,
      relation: "related",
      suggested: false,
    }));
    const l = computeLayout("big", { nodes, edges });
    expect(l.positions.size).toBe(600);
    for (const p of l.positions.values()) {
      expect(Number.isFinite(p.x) && p.x >= 0 && p.x <= WORLD.width).toBe(true);
    }
  });

  it("seeds each domain differently", () => {
    const g = chainAndStar();
    const a = computeLayout("demo", g);
    const b = computeLayout("other", g);
    expect(b.positions.get("n3")).not.toEqual(a.positions.get("n3"));
  });

  it("fits the world box", () => {
    const l = computeLayout("demo", chainAndStar());
    for (const p of l.positions.values()) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(WORLD.width);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(WORLD.height);
    }
  });

  it("keeps linked notes nearer than unlinked ones", () => {
    const g = getGraph({ domain: "demo" });
    const l = computeLayout("demo", g);
    const dist = (a: string, b: string) => {
      const p = l.positions.get(a);
      const q = l.positions.get(b);
      return p && q ? Math.hypot(p.x - q.x, p.y - q.y) : 0;
    };
    const linked = g.edges.map((e) => dist(e.source, e.target));
    const keys = g.nodes.map((n) => n.key);
    const random = keys
      .slice(0, 200)
      .map((k, i) => dist(k, keys[(i * 37 + 11) % keys.length] ?? k));
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean(linked)).toBeLessThan(mean(random) * 0.75);
  });

  it("caches per domain and recomputes when the graph changes", () => {
    clearLayoutCache();
    const g = chainAndStar();
    const first = layoutFor("demo", g);
    expect(layoutFor("demo", { nodes: [...g.nodes], edges: [...g.edges] })).toBe(first);
    expect(layoutFor("demo", { nodes: g.nodes.slice(1), edges: g.edges })).not.toBe(first);
  });
});

describe("canvas dot grid", () => {
  it("keeps an even density at every zoom", () => {
    for (const s of [0.05, 0.3, 0.94, 1, 2.2, 3.5, 7, 12.5, 40]) {
      const { gap } = dotGrid({ x: 0, y: 0, s });
      expect(gap).toBeGreaterThanOrEqual(16);
      expect(gap).toBeLessThan(32);
    }
  });

  it("stays anchored to the world, so it pans and scales with the view", () => {
    for (const c of [
      { x: 30, y: -12, s: 0.94 },
      { x: -400, y: 220, s: 7 },
    ]) {
      const grid = dotGrid(c);
      expect([grid.x, grid.y]).toEqual([c.x, c.y]);
      // The world spacing is the base spacing halved or doubled a whole number of times.
      const k = Math.log2(DOT_SPACING / (grid.gap / c.s));
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-9);
    }
  });

  it("falls back to the base spacing for a broken camera", () => {
    for (const s of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(dotGrid({ x: 5, y: 5, s })).toEqual({ gap: DOT_SPACING, x: 0, y: 0 });
    }
  });
});

describe("camera", () => {
  const view = { width: 1000, height: 600 };
  const bounds = { minX: 0, minY: 0, maxX: 1000, maxY: 640 };

  it("fits the whole area inside the view, centred", () => {
    const c = fitCamera(bounds, view, 20);
    const tl = toScreen(c, { x: 0, y: 0 });
    const br = toScreen(c, { x: 1000, y: 640 });
    expect(tl.x).toBeGreaterThanOrEqual(19.99);
    expect(tl.y).toBeGreaterThanOrEqual(19.99);
    expect(br.x).toBeLessThanOrEqual(980.01);
    expect(br.y).toBeLessThanOrEqual(580.01);
    expect((tl.x + br.x) / 2).toBeCloseTo(500);
    expect((tl.y + br.y) / 2).toBeCloseTo(300);
  });

  it("keeps areas with 0, 1 or 2 notes at a sane scale", () => {
    const sizes = [0, 1, 2].map((count) => {
      const nodes = Array.from({ length: count }, (_, i) => node(`s${i}`));
      const edges =
        count === 2 ? [{ source: "s0", target: "s1", relation: "related", suggested: false }] : [];
      return fitCamera(computeLayout("demo", { nodes, edges }).bounds, { width: 900, height: 640 })
        .s;
    });
    for (const s of sizes) expect(s).toBeLessThan(3);
  });

  it("round-trips screen and world points", () => {
    const c = { x: 12, y: -40, s: 2.5 };
    const w = toWorld(c, toScreen(c, { x: 300, y: 200 }));
    expect(w.x).toBeCloseTo(300);
    expect(w.y).toBeCloseTo(200);
  });

  it("keeps the anchor still when zooming", () => {
    const c = { x: 30, y: 10, s: 1 };
    const anchor = { x: 420, y: 260 };
    const before = toWorld(c, anchor);
    const z = zoomAt(c, 1.8, anchor, 1);
    const after = toWorld(z, anchor);
    expect(z.s).toBeCloseTo(1.8);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("clamps the zoom range", () => {
    expect(zoomAt({ x: 0, y: 0, s: 1 }, 100, { x: 0, y: 0 }, 1).s).toBe(10);
    expect(zoomAt({ x: 0, y: 0, s: 1 }, 0.01, { x: 0, y: 0 }, 1).s).toBe(0.6);
  });

  it("centres the focus at each step and maps steps back to their level", () => {
    const fit = fitCamera(bounds, view);
    const focus = { x: 428, y: 379 };
    for (const level of [1, 2, 3] as const) {
      const c = stepCamera(level, focus, fit, view);
      const s = toScreen(c, focus);
      expect(s.x).toBeCloseTo(500);
      expect(s.y).toBeCloseTo(300);
      expect(c.s).toBeCloseTo(fit.s * STEPS[level]);
      expect(levelFor(c.s, fit.s)).toBe(level);
    }
    expect(stepCamera(0, focus, fit, view)).toEqual(fit);
    expect(levelFor(fit.s, fit.s)).toBe(0);
    expect(centreOn(focus, 2, view).s).toBe(2);
  });

  it("steps within range and turns wheel deltas into factors", () => {
    expect(nextLevel(0, -1)).toBe(0);
    expect(nextLevel(3, 1)).toBe(3);
    expect(nextLevel(1, 1)).toBe(2);
    expect(wheelFactor(-100)).toBeGreaterThan(1);
    expect(wheelFactor(100)).toBeLessThan(1);
    expect(wheelFactor(100) * wheelFactor(-100)).toBeCloseTo(1);
  });
});

describe("neighbourhood cards", () => {
  it("folds busy kinds into a group and opens it on request", () => {
    const nodes = [
      node("f"),
      ...Array.from({ length: 6 }, (_, i) => node(`d${i}`)),
      node("q", "question"),
    ];
    const edges = nodes.slice(1).map((n) => ({
      source: "f",
      target: n.key,
      relation: "narrows",
      suggested: false,
    }));
    const ns = neighboursOf({ nodes, edges }, "f");
    const cards = cardsFor(ns, new Set());
    const group = cards.find((c) => c.type === "group");
    expect(group?.type === "group" && group.members.length).toBe(6 - (GROUP_AFTER - 1));
    expect(cards).toHaveLength(GROUP_AFTER + 1);
    expect(cardsFor(ns, new Set(["decision"]))).toHaveLength(7);
  });

  it("keeps recorded links on cards ahead of suggested ones", () => {
    const nodes = [node("f"), node("a"), node("b"), node("c"), node("d"), node("e")];
    const edges = nodes.slice(1).map((n) => ({
      source: "f",
      target: n.key,
      relation: "related",
      suggested: n.key < "c",
    }));
    const cards = cardsFor(neighboursOf({ nodes, edges }, "f"), new Set());
    const shown = cards.flatMap((c) => (c.type === "note" ? [c.neighbour.node.key] : []));
    expect(shown).toEqual(["c", "d", "e"].slice(0, GROUP_AFTER - 1));
  });

  it("does not walk two hops through a note or link the filter drops", () => {
    const nodes = [node("f"), node("d", "topic"), node("s"), node("x"), node("y")];
    const link = (source: string, target: string, suggested = false) => ({
      source,
      target,
      relation: "related",
      suggested,
    });
    const edges = [link("f", "d"), link("d", "x"), link("f", "s", true), link("s", "y")];
    const keep = (n: { node: GraphNode; edge: { suggested: boolean } }) =>
      n.node.key !== "d" && !n.edge.suggested;
    const keys = neighboursWithin({ nodes, edges }, "f", 2, undefined, keep).map((n) => n.node.key);
    expect(keys).toEqual([]);
    expect(
      neighboursWithin({ nodes, edges }, "f", 2)
        .map((n) => n.node.key)
        .sort(),
    ).toEqual(["d", "s", "x", "y"]);
  });

  it("gives every card its own slot", () => {
    const slots = cardSlots(12);
    const seen = new Set(slots.map((p) => `${p.x},${p.y}`));
    expect(seen.size).toBe(12);
  });

  it("shrinks the slots to fit a narrow stage", () => {
    const view = { width: 412, height: 600 };
    for (const p of cardSlots(8, view)) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(view.width / 2);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(view.height / 2);
    }
    expect(cardSlots(8, { width: 2000, height: 1200 })).toEqual(cardSlots(8));
  });
});

describe("neighbour order", () => {
  it("lists coloured types in slot order, then the rest by label, then by title", () => {
    const nodes = [
      node("f"),
      node("r", "runbook"),
      node("d2"),
      node("q", "question"),
      node("a", "document"),
      node("d1"),
    ];
    const edges = nodes
      .slice(1)
      .map((n) => ({ source: "f", target: n.key, relation: "related", suggested: false }));
    const keys = (slots: Parameters<typeof neighboursOf>[2]) =>
      neighboursOf({ nodes, edges }, "f", slots).map((n) => n.node.key);
    expect(keys(["decision", "question", null])).toEqual(["d1", "d2", "q", "a", "r"]);
    expect(keys(["runbook", null, "decision"])).toEqual(["r", "d1", "d2", "a", "q"]);
  });
});

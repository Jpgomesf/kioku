import { describe, expect, it } from "vitest";
import { demoGraph } from "../fixtures";
import { getGraph } from "./mock";

function directNeighbours(key: string): Set<string> {
  const out = new Set<string>([key]);
  for (const e of demoGraph.edges) {
    if (e.source === key) out.add(e.target);
    if (e.target === key) out.add(e.source);
  }
  return out;
}

describe("graph mock", () => {
  it("returns only direct neighbours at depth 1", () => {
    const g = getGraph({ domain: "demo", focus: "demo-search-000", depth: 1 });
    expect(new Set(g.nodes.map((n) => n.key))).toEqual(directNeighbours("demo-search-000"));
    expect(g.nodes.length).toBeLessThan(20);
  });
  it("grows one hop per depth step", () => {
    const one = getGraph({ domain: "demo", focus: "demo-search-000", depth: 1 });
    const two = getGraph({ domain: "demo", focus: "demo-search-000", depth: 2 });
    expect(two.nodes.length).toBeGreaterThan(one.nodes.length);
    expect(two.nodes.length).toBeLessThan(demoGraph.nodes.length / 2);
  });
});

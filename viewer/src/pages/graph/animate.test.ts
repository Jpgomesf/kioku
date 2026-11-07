import { describe, expect, it } from "vitest";
import { partialScene, revealRanks } from "./animate";
import type { Scene } from "./scene";

const n = (key: string) => ({
  key,
  x: 0,
  y: 0,
  size: 1,
  color: "#000",
  topic: false,
  tag: false,
  legacy: false,
  label: key,
});

describe("animate", () => {
  it("ranks nodes by update time, ties in scene order", () => {
    expect([...revealRanks(["2026-03", "2026-01", "2026-03", "2026-02"])]).toEqual([2, 0, 3, 1]);
  });

  it("shows a link once both its ends are shown", () => {
    const scene: Scene = {
      nodes: [n("a"), n("b"), n("c")],
      edges: [
        { a: 0, b: 1, suggested: false },
        { a: 1, b: 2, suggested: true },
      ],
    };
    const ranks = revealRanks(["2026-01", "2026-03", "2026-02"]);
    const two = partialScene(scene, ranks, 2);
    expect(two.nodes.map((x) => x.key)).toEqual(["a", "c"]);
    expect(two.edges).toEqual([]);
    const all = partialScene(scene, ranks, 3);
    expect(all).toBe(scene);
  });
});

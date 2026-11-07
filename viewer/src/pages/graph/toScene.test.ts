import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../api";
import { OverlayPlacer } from "./placer";
import { toScene } from "./toScene";

const node = (key: string, kind: string, degree = 0, legacy = false): GraphNode => ({
  key,
  domain: "demo",
  title: key,
  kind,
  status: legacy ? "legacy" : "active",
  degree,
  tags: [],
  updatedAt: "2026-11-01T10:00:00Z",
});

describe("toScene", () => {
  it("colours, sizes and labels notes, marks topics and legacy, and drops dangling links", () => {
    const scene = toScene(
      [node("a", "decision", 4), node("b", "fix", 0, true), node("t", "topic")],
      [
        { source: "a", target: "b", relation: "related", suggested: true },
        { source: "a", target: "gone", relation: "related", suggested: false },
      ],
      (n) => (n.kind === "decision" ? "#2a78d6" : "#8a8b93"),
    );
    expect(scene.nodes.map((n) => [n.key, n.size, n.legacy, n.topic, n.color, n.label])).toEqual([
      ["a", 5, false, false, "#2a78d6", "a"],
      ["b", 1, true, false, "#8a8b93", "b"],
      ["t", 1, false, true, "#8a8b93", "t"],
    ]);
    expect(scene.edges).toEqual([{ a: 0, b: 1, suggested: true }]);
  });
});

describe("OverlayPlacer", () => {
  it("places marked elements in screen space for the camera", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<span data-x="10" data-y="20"></span><span data-x="0" data-y="0" data-scale="detail" data-anchor="top" data-dy="5"></span>';
    let cam = { x: 100, y: 50, s: 2 };
    const placer = new OverlayPlacer(root, {
      camera: () => cam,
      detailScale: () => 4,
      growMs: () => 0,
    });
    placer.place();
    const [label, card] = [...root.querySelectorAll<HTMLElement>("span")];
    expect(label?.style.transform).toBe("translate(120px, 90px) translate(-50%, -50%) scale(1)");
    expect(card?.style.transform).toBe("translate(100px, 55px) translate(-50%, 0) scale(0.5)");
    cam = { x: 0, y: 0, s: 1 };
    placer.place();
    expect(label?.style.transform).toBe("translate(10px, 20px) translate(-50%, -50%) scale(1)");
  });

  it("puts a hidden element at the dot it grows from, shrunk", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<span data-x="10" data-y="0" data-fx="0" data-fy="0" data-on="0" data-grow="1"></span>';
    const placer = new OverlayPlacer(root, {
      camera: () => ({ x: 0, y: 0, s: 1 }),
      detailScale: () => 1,
      growMs: () => 0,
    });
    placer.place();
    expect(root.querySelector("span")?.style.transform).toBe(
      "translate(0px, 0px) translate(-50%, -50%) scale(0.05)",
    );
  });

  it("follows a note's live position by key, with a world offset", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<span data-k="a" data-x="5" data-y="0"></span><span data-k="missing"></span><svg><line data-k1="a" data-k="b"></line></svg>';
    let a = { x: 10, y: 20 };
    const placer = new OverlayPlacer(root, {
      camera: () => ({ x: 0, y: 0, s: 1 }),
      detailScale: () => 1,
      growMs: () => 0,
      point: (key) => (key === "a" ? a : key === "b" ? { x: 0, y: 0 } : null),
    });
    placer.place();
    const [follower, missing] = [...root.querySelectorAll<HTMLElement>("span")];
    expect(follower?.style.transform).toBe("translate(15px, 20px) translate(-50%, -50%) scale(1)");
    // No position yet: left alone rather than put at the origin.
    expect(missing?.style.transform).toBe("");
    expect(root.querySelector("line")?.getAttribute("x1")).toBe("10");
    a = { x: 30, y: 40 };
    placer.place();
    expect(follower?.style.transform).toBe("translate(35px, 40px) translate(-50%, -50%) scale(1)");
  });
});

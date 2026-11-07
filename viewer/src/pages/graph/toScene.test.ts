import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../api";
import { OverlayPlacer } from "./placer";
import { toneOf, toScene } from "./toScene";

const node = (key: string, kind: string, degree = 0, legacy = false): GraphNode => ({
  key,
  domain: "demo",
  title: key,
  kind,
  status: legacy ? "legacy" : "active",
  degree,
});

describe("toScene", () => {
  it("maps slots, topics and unpicked types to tones", () => {
    const slots = ["decision", null, "runbook"] as const;
    expect(toneOf(slots, "decision")).toBe("slot1");
    expect(toneOf(slots, "runbook")).toBe("slot3");
    expect(toneOf(slots, "gotcha")).toBe("other");
    expect(toneOf(slots, "topic")).toBe("topic");
  });

  it("sizes by links, marks legacy and drops notes without a position", () => {
    const positions = new Map([
      ["a", { x: 1, y: 2 }],
      ["b", { x: 3, y: 4 }],
    ]);
    const scene = toScene(
      [node("a", "decision", 4), node("b", "fix", 0, true), node("c", "fix")],
      [
        { source: "a", target: "b", relation: "related", suggested: true },
        { source: "a", target: "c", relation: "related", suggested: false },
      ],
      positions,
      ["decision", null, null],
    );
    expect(scene.nodes.map((n) => [n.key, n.size, n.legacy, n.tone])).toEqual([
      ["a", 5, false, "slot1"],
      ["b", 1, true, "other"],
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
});

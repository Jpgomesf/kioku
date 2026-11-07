import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../api";
import { withTags } from "./tags";

const note = (key: string, tags: string[], updatedAt: string): GraphNode => ({
  key,
  domain: "demo",
  title: key,
  kind: "decision",
  status: "active",
  degree: 0,
  tags,
  updatedAt,
});

describe("withTags", () => {
  it("adds one node per tag, linked to each note that has it", () => {
    const data = withTags({
      nodes: [
        note("a", ["Search", "#ops"], "2026-03-01T00:00:00Z"),
        note("b", ["search", "search"], "2026-01-01T00:00:00Z"),
      ],
      edges: [],
    });
    const tags = data.nodes.filter((n) => n.kind === "tag");
    expect(tags.map((n) => [n.key, n.title, n.degree])).toEqual([
      ["tag:ops", "#ops", 1],
      ["tag:search", "#search", 2],
    ]);
    // A tag appears with its earliest note in Animate.
    expect(tags[1]?.updatedAt).toBe("2026-01-01T00:00:00Z");
    expect(data.edges.map((e) => `${e.source}>${e.target}`).sort()).toEqual([
      "a>tag:ops",
      "a>tag:search",
      "b>tag:search",
    ]);
  });

  it("leaves untagged data as it is", () => {
    const data = { nodes: [note("a", [], "2026-01-01T00:00:00Z")], edges: [] };
    expect(withTags(data)).toBe(data);
  });
});

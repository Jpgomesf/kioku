import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "../../api";
import { groupLabel, groupNames, MAX_NAMED_REGIONS, regionNames } from "./regions";
import { LABEL_MAX } from "./renderer-math";

const note = (key: string, kind = "decision", tags: string[] = []): GraphNode => ({
  key,
  domain: "t",
  title: `Title ${key}`,
  kind,
  status: "active",
  degree: 0,
  tags,
  updatedAt: "2026-11-01T10:00:00Z",
});

const link = (source: string, target: string): GraphEdge => ({
  source,
  target,
  relation: "related",
  suggested: false,
});

/** Names for notes given as [note, region] pairs. */
function names(members: Array<[GraphNode, number]>, edges: GraphEdge[] = []): string[] {
  const nodes = members.map(([n]) => n);
  const assign = Int32Array.from(members, ([, r]) => r);
  const count = Math.max(-1, ...assign) + 1;
  return regionNames(nodes, edges, assign, count);
}

/** `size` notes in `region`, keyed prefix0, prefix1, ... */
function region(
  prefix: string,
  size: number,
  regionIndex: number,
  make: (key: string, i: number) => GraphNode = (key) => note(key),
): Array<[GraphNode, number]> {
  return Array.from({ length: size }, (_, i) => [make(`${prefix}${i}`, i), regionIndex]);
}

describe("region names", () => {
  it("names a region by a tag a quarter of its notes carry, with its size", () => {
    // Two of eight carry billing (a quarter); tags compare without case or a leading #.
    const members = region("a", 8, 0, (key, i) =>
      note(key, "decision", i === 0 ? ["#Billing"] : i === 1 ? ["billing"] : []),
    );
    expect(names(members)).toEqual(["billing · 8"]);
  });

  it("falls back to the most common type when no tag is shared enough", () => {
    const members = region("a", 9, 0, (key, i) =>
      note(key, i < 5 ? "question" : "decision", i === 0 ? ["billing"] : []),
    );
    expect(names(members)).toEqual(["Questions · 9"]);
  });

  it("falls back to the best-linked note when the type says nothing", () => {
    const members = region("a", 4, 0, (key) => note(key, "note"));
    const edges = [link("a0", "a2"), link("a1", "a2"), link("a3", "a2")];
    expect(names(members, edges)).toEqual(["Title a2 · 4"]);
    // Nor does a type fewer than a quarter of the notes have: five types, one note each.
    const mixed = region("m", 5, 0, (key, i) => note(key, `kind-${i}`));
    expect(names(mixed, [link("m1", "m3"), link("m2", "m3")])).toEqual(["Title m3 · 5"]);
  });

  it("gives a shared tag to the region where most notes carry it, not the largest", () => {
    // api is the larger region's most common tag (4 of 9), but all of the smaller one's notes
    // carry it; the larger one moves on to ops (3 of 9).
    const members = [
      ...region("a", 9, 0, (key, i) =>
        note(key, "decision", i < 4 ? ["api"] : i < 7 ? ["ops"] : []),
      ),
      ...region("b", 6, 1, (key) => note(key, "question", ["api"])),
    ];
    expect(names(members)).toEqual(["ops · 9", "api · 6"]);
  });

  it("keeps names apart: on a tie a smaller region skips a tag or type a larger one took", () => {
    const shared = (key: string) => note(key, "decision", ["search"]);
    const members = [
      ...region("a", 7, 0, shared),
      ...region("b", 6, 1, (key, i) => note(key, "decision", i < 2 ? ["search", "ops"] : ["ops"])),
      ...region("d", 5, 2),
      ...region("c", 4, 3, shared),
    ];
    // b's search is taken, so its own ops names it; d has no tags, so its type does; c has only
    // search and decisions, both taken, so its best-linked note names it.
    expect(names(members, [link("c1", "c0"), link("c2", "c0")])).toEqual([
      "search · 7",
      "ops · 6",
      "Decisions · 5",
      "Title c0 · 4",
    ]);
  });

  it("leaves tag nodes out of a region's size and name", () => {
    const tagNode: GraphNode = { ...note("tag:ops", "tag"), title: "#ops", tags: ["ops"] };
    const members: Array<[GraphNode, number]> = [
      ...region("a", 4, 0, (key) => note(key, "question")),
      [tagNode, 0],
    ];
    expect(names(members)).toEqual(["Questions · 4"]);
  });

  it("names only regions big enough to be parts of the area, and only the largest", () => {
    // 5 notes is under 1% of 605; 2 notes is under the 3 a region needs in any area.
    const members = [...region("big", 600, 0), ...region("small", 5, 1, (k) => note(k, "fix"))];
    expect(names(members)).toEqual(["Decisions · 600", ""]);
    const pair = [...region("a", 4, 0), ...region("b", 2, 1, (k) => note(k, "fix"))];
    expect(names(pair)).toEqual(["Decisions · 4", ""]);
    // Big enough, all of them, but only the largest are named.
    const many = Array.from({ length: MAX_NAMED_REGIONS + 3 }, (_, r) =>
      region(`r${r}x`, 10 + r, r, (key) => note(key, `kind-${r}`)),
    ).flat();
    const named = names(many);
    expect(named.filter((name) => name !== "")).toHaveLength(MAX_NAMED_REGIONS);
    // The smallest go unnamed.
    expect(named.slice(0, 3)).toEqual(["", "", ""]);
  });

  it("cuts a long name so the size still fits the label", () => {
    const long = { ...note("a0", "note"), title: "A very long note title that goes on and on" };
    const members: Array<[GraphNode, number]> = [
      [long, 0],
      ...region("a", 3, 0, (k) => note(k, "note")).slice(1),
    ];
    const [name = ""] = names(members, [link("a1", "a0"), link("a2", "a0")]);
    expect(name.length).toBeLessThanOrEqual(LABEL_MAX);
    expect(name.endsWith("… · 3")).toBe(true);
    expect(name.startsWith("A very long")).toBe(true);
  });

  it("gives regions with no notes on the canvas no name", () => {
    expect(regionNames([note("a")], [], Int32Array.from([-1]), 2)).toEqual(["", ""]);
  });
});

describe("groupNames", () => {
  it("names each colour group for what it matches, with its size", () => {
    const nodes = [
      ...["d0", "d1", "d2"].map((k) => note(k)),
      ...["q0", "q1", "q2", "q3"].map((k) => note(k, "question")),
      ...["b0", "b1", "b2"].map((k) => note(k, "fix", ["Billing"])),
    ];
    const groupOf = Int32Array.from([0, 0, 0, 1, 1, 1, 1, 2, 2, 2]);
    expect(groupNames(nodes, groupOf, ["type:decision", "type:question", "tag:#Billing"])).toEqual([
      "Decisions · 3",
      "Questions · 4",
      "billing · 3",
    ]);
  });

  it("leaves small and empty groups unnamed, and tag nodes out of a group's size", () => {
    const tagNode: GraphNode = { ...note("tag:ops", "tag"), title: "#ops", tags: ["ops"] };
    const nodes = [note("a0"), note("a1"), tagNode, note("x")];
    const groupOf = Int32Array.from([0, 0, 0, -1]);
    expect(groupNames(nodes, groupOf, ["type:decision", ""])).toEqual(["", ""]);
  });
});

describe("groupLabel", () => {
  it("reads a one-type or one-tag query in words, and any other query as typed", () => {
    expect(groupLabel("type:design-review")).toBe("Design reviews");
    expect(groupLabel("tag:#Roadmap")).toBe("roadmap");
    expect(groupLabel("  launch plan ")).toBe("launch plan");
    expect(groupLabel("type:decision -tag:old")).toBe("type:decision -tag:old");
    expect(groupLabel("-type:decision")).toBe("-type:decision");
  });
});

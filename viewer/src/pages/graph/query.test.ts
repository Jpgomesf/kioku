import { describe, expect, it } from "vitest";
import { groupColour, matchesQuery, parseQuery, type QueryTarget } from "./query";

const note: QueryTarget = {
  key: "projects/alpha-plan",
  title: "Alpha launch plan",
  kind: "design-review",
  tags: ["Idea", "#roadmap"],
};
const m = (q: string, n: QueryTarget = note) => matchesQuery(parseQuery(q), n);

describe("query", () => {
  it("matches everything when empty", () => {
    expect(m("")).toBe(true);
    expect(m("   ")).toBe(true);
  });

  it("matches plain words against title or key, ignoring case", () => {
    expect(m("LAUNCH")).toBe(true);
    expect(m("projects")).toBe(true);
    expect(m("launch missing")).toBe(false);
  });

  it("matches type by id or label words", () => {
    expect(m("type:design-review")).toBe(true);
    expect(m('type:"Design review"')).toBe(true);
    expect(m("type:decision")).toBe(false);
  });

  it("matches path prefixes", () => {
    expect(m("path:projects/")).toBe(true);
    expect(m("path:alpha")).toBe(false);
  });

  it("negates terms", () => {
    expect(m("-type:decision")).toBe(true);
    expect(m("-launch")).toBe(false);
    expect(m("-path:projects")).toBe(false);
  });

  it("keeps quoted phrases whole", () => {
    expect(m('"launch plan"')).toBe(true);
    expect(m('"plan launch"')).toBe(false);
  });

  it("never throws on junk", () => {
    for (const junk of ['"', "type:", "-", '"""', 'path:"', "((*[", "\u0000"]) {
      expect(() => m(junk)).not.toThrow();
    }
    expect(m("type:")).toBe(true);
    expect(() => parseQuery(undefined as unknown as string)).not.toThrow();
  });

  it("colours by the first matching group", () => {
    const groups = [
      { query: parseQuery(""), color: "#000000" },
      { query: parseQuery("type:design-review"), color: "#111111" },
      { query: parseQuery("launch"), color: "#222222" },
    ];
    expect(groupColour(groups, note)).toBe("#111111");
    expect(groupColour(groups, { ...note, kind: "x", title: "y", key: "z" })).toBeNull();
  });

  it("matches tag: against a whole tag, ignoring case and a leading #", () => {
    expect(m("tag:idea")).toBe(true);
    expect(m("tag:#IDEA")).toBe(true);
    expect(m("tag:roadmap")).toBe(true);
    expect(m("tag:ide")).toBe(false);
    expect(m("-tag:idea")).toBe(false);
    expect(m("-tag:other")).toBe(true);
    expect(m("tag:idea", { ...note, tags: [] })).toBe(false);
  });

  it("ignores an empty tag: still being typed", () => {
    expect(m("tag:")).toBe(true);
    expect(m("tag:#")).toBe(true);
  });
});

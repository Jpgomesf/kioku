import { describe, expect, it } from "vitest";
import { isKindId, kindCounts, kindLabel, kindLabelPlural, kindNoun } from "./kinds";

describe("kindLabel", () => {
  it("turns an id into sentence case", () => {
    expect(kindLabel("decision")).toBe("Decision");
    expect(kindLabel("design-review")).toBe("Design review");
    expect(kindLabel("pull-request")).toBe("Pull request");
  });

  it("names an empty or malformed id as a note", () => {
    expect(kindLabel("")).toBe("Note");
    expect(kindLabel("--")).toBe("Note");
  });

  it("keeps letters outside ASCII", () => {
    expect(kindLabel("éclair-note")).toBe("Éclair note");
    expect(kindLabel("議事録")).toBe("議事録");
  });
});

describe("plurals", () => {
  it("pluralises the last word only", () => {
    expect(kindLabelPlural("design-review")).toBe("Design reviews");
    expect(kindLabelPlural("pull-request")).toBe("Pull requests");
  });

  it("follows the common English endings", () => {
    expect(kindLabelPlural("fix")).toBe("Fixes");
    expect(kindLabelPlural("glossary")).toBe("Glossaries");
    expect(kindLabelPlural("day")).toBe("Days");
    expect(kindLabelPlural("person")).toBe("People");
    expect(kindLabelPlural("class")).toBe("Classes");
  });

  it("leaves a last word already ending in s alone", () => {
    expect(kindLabelPlural("release-notes")).toBe("Release notes");
  });

  it("gives a lowercase noun for running text", () => {
    expect(kindNoun("decision", 1)).toBe("decision");
    expect(kindNoun("decision", 0)).toBe("decisions");
    expect(kindNoun("design-review", 12)).toBe("design reviews");
    expect(kindNoun("", 2)).toBe("notes");
  });
});

describe("isKindId", () => {
  it("accepts lowercase words joined by single hyphens", () => {
    expect(isKindId("decision")).toBe(true);
    expect(isKindId("design-review")).toBe(true);
    expect(isKindId("議事録")).toBe(true);
    expect(isKindId("v2-plan")).toBe(true);
  });

  it("rejects anything else", () => {
    for (const bad of ["", "Decision", "design review", "-a", "a-", "a--b", "a_b", "a/b", "<b>"]) {
      expect(isKindId(bad)).toBe(false);
    }
    expect(isKindId("a".repeat(513))).toBe(false);
  });
});

describe("kindCounts", () => {
  it("orders by count, then by label", () => {
    const items = ["note", "decision", "question", "decision", "design-review", "question"].map(
      (kind) => ({ kind }),
    );
    expect(kindCounts(items)).toEqual([
      { kind: "decision", count: 2 },
      { kind: "question", count: 2 },
      { kind: "design-review", count: 1 },
      { kind: "note", count: 1 },
    ]);
  });

  it("is empty for no items", () => {
    expect(kindCounts([])).toEqual([]);
  });
});

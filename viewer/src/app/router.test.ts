import { describe, expect, it } from "vitest";
import { graphHref, libraryHref, noteHref, parseHash } from "./router";

describe("parseHash", () => {
  it("defaults to the library", () => {
    expect(parseHash("")).toEqual({ name: "library", params: {} });
  });
  it("parses notes in nested domains", () => {
    expect(parseHash(noteHref("personal/kioku", "memory-stack"))).toEqual({
      name: "note",
      domain: "personal/kioku",
      key: "memory-stack",
    });
  });
  it("parses guide sub-routes and the vault review", () => {
    expect(parseHash("#/guide/whats-new")).toEqual({ name: "guide", section: "whats-new" });
    expect(parseHash("#/vaults/review")).toEqual({ name: "vaults-review" });
  });
  it("reports unknown routes and sub-paths", () => {
    expect(parseHash("#/nope")).toEqual({ name: "not-found", path: "nope" });
    expect(parseHash("#/vaults/whatever").name).toBe("not-found");
    expect(parseHash("#/library/extra").name).toBe("not-found");
  });
  it("shows not-found for a malformed escape instead of throwing", () => {
    expect(parseHash("#/note/demo/%E0%A4%A")).toEqual({
      name: "not-found",
      path: "note/demo/%E0%A4%A",
    });
  });
  it("reads library filters from the query", () => {
    expect(parseHash("#/library?kind=decision&q=touch%20id")).toEqual({
      name: "library",
      params: { kind: "decision", q: "touch id" },
    });
    expect(parseHash(libraryHref({ status: "legacy" }))).toEqual({
      name: "library",
      params: { status: "legacy" },
    });
  });
  it("round-trips the graph around a note", () => {
    expect(parseHash(graphHref("personal/kioku", "memory-stack"))).toEqual({
      name: "graph",
      domain: "personal/kioku",
      focus: "memory-stack",
    });
    expect(parseHash("#/graph")).toEqual({ name: "graph" });
  });
});

import { describe, expect, it } from "vitest";
import type { ReleaseNote } from "../../api";
import { compareVersions, formatReleaseDate, groupReleaseNotes, isIsoDate } from "./releases";

const note = (version: string, date: string, changes: string[], title = ""): ReleaseNote => ({
  version,
  date,
  title,
  changes,
});

describe("compareVersions", () => {
  it("compares numerically, not as text", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
  });
  it("puts a pre-release before its release", () => {
    expect(compareVersions("0.2.0-beta.1", "0.2.0")).toBeLessThan(0);
  });
  it("orders pre-release identifiers by SemVer rules", () => {
    expect(compareVersions("0.2.0-beta.10", "0.2.0-beta.9")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0-alpha", "0.2.0-beta")).toBeLessThan(0);
    expect(compareVersions("0.2.0-beta", "0.2.0-rc")).toBeLessThan(0);
    expect(compareVersions("0.2.0-beta", "0.2.0-beta.1")).toBeLessThan(0);
    expect(compareVersions("0.2.0-1", "0.2.0-alpha")).toBeLessThan(0);
  });
});

describe("groupReleaseNotes", () => {
  it("orders versions newest first", () => {
    const out = groupReleaseNotes(
      [
        note("0.1.0", "2026-10-01", ["a"]),
        note("0.10.0", "2026-12-01", ["c"]),
        note("0.2.0", "2026-11-01", ["b"]),
      ],
      null,
    );
    expect(out.map((e) => e.version)).toEqual(["0.10.0", "0.2.0", "0.1.0"]);
  });

  it("merges notes that share a version and keeps change order", () => {
    const out = groupReleaseNotes(
      [
        note("0.2.0", "2026-11-01", ["a", "b"], "Preview"),
        note("v0.2.0", "2026-11-03", ["b", "c"]),
      ],
      null,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.changes).toEqual(["a", "b", "c"]);
    expect(out[0]?.date).toBe("2026-11-03");
    expect(out[0]?.title).toBe("Preview");
  });

  it("marks only the current version", () => {
    const out = groupReleaseNotes(
      [note("0.2.0", "2026-11-01", []), note("0.1.0", "2026-10-01", [])],
      "v0.1.0",
    );
    expect(out.map((e) => e.isCurrent)).toEqual([false, true]);
  });

  it("drops repeated changes within and across notes", () => {
    const out = groupReleaseNotes(
      [note("0.1.0", "2026-10-01", ["Docs", "Docs"]), note("0.1.0", "2026-10-02", ["b", "b"])],
      null,
    );
    expect(out[0]?.changes).toEqual(["Docs", "b"]);
  });

  it("does not change its input", () => {
    const input = [note("0.1.0", "2026-10-01", ["a"]), note("0.1.0", "2026-10-02", ["b"])];
    groupReleaseNotes(input, null);
    expect(input[0]?.changes).toEqual(["a"]);
  });
});

describe("formatReleaseDate", () => {
  it("formats ISO dates and passes others through", () => {
    const now = new Date(2026, 10, 6);
    expect(formatReleaseDate("2026-11-06", now)).toBe("6 Nov");
    expect(formatReleaseDate("2025-10-28", now)).toBe("28 Oct 2025");
    expect(formatReleaseDate("soon", now)).toBe("soon");
  });
  it("tells ISO dates from labels", () => {
    expect(isIsoDate("2026-11-06")).toBe(true);
    expect(isIsoDate("Unreleased")).toBe(false);
  });
});

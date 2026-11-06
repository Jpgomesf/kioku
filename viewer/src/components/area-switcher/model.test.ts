import { describe, expect, it } from "vitest";
import type { Area } from "../../api";
import {
  type AreaEntry,
  areaKey,
  countLabel,
  countWords,
  flatOptions,
  groupAreas,
  matchesArea,
} from "./model";

const area = (domain: string, label: string, vault: string, noteCount = 1): Area => ({
  domain,
  label,
  vault,
  noteCount,
  legacyCount: 0,
  source: null,
});

const entries: AreaEntry[] = [
  {
    area: area("personal/kioku", "kioku", "personal", 4),
    paths: ["~/projects/personal/mcp/kioku"],
  },
  { area: area("local", "local", "personal", 0), paths: [] },
  { area: area("work/notes", "notes", "work", 2), paths: ["~/work/notes"] },
];

describe("matchesArea", () => {
  it("matches names, vaults and folders", () => {
    expect(matchesArea(entries[0] as AreaEntry, "kio")).toBe(true);
    expect(matchesArea(entries[2] as AreaEntry, "work")).toBe(true);
    expect(matchesArea(entries[0] as AreaEntry, "mcp/kioku")).toBe(true);
    expect(matchesArea(entries[1] as AreaEntry, "mcp")).toBe(false);
  });
});

describe("groupAreas", () => {
  it("puts Recent first, then vault groups", () => {
    const groups = groupAreas(entries, "", ["work/notes", "gone"]);
    // work/notes is in Recent, so the work group is empty and dropped.
    expect(groups.map((g) => g.title)).toEqual(["Recent", "personal"]);
    expect(groups[0]?.areas.map((a) => a.domain)).toEqual(["work/notes"]);
  });
  it("hides Recent while searching", () => {
    const groups = groupAreas(entries, "notes", ["work/notes"]);
    expect(groups.map((g) => g.title)).toEqual(["work"]);
  });
  it("keeps option ids unique across groups", () => {
    const ids = flatOptions(groupAreas(entries, "", ["local"])).map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(3);
  });
});

describe("countLabel", () => {
  it("says empty or counts notes", () => {
    expect(countLabel({ noteCount: 0 })).toBe("empty");
    expect(countLabel({ noteCount: 1594 })).toBe("1,594");
    expect(countWords({ noteCount: 1 })).toBe("1 note");
    expect(countWords({ noteCount: 1594 })).toBe("1,594 notes");
  });
});

describe("areaKey", () => {
  it("maps keys and leaves input-method keys alone", () => {
    expect(areaKey({ key: "ArrowDown", altKey: false })).toBe("down");
    expect(areaKey({ key: "ArrowUp", altKey: false })).toBe("up");
    expect(areaKey({ key: "Enter", altKey: false })).toBe("open");
    expect(areaKey({ key: "Enter", altKey: false, isComposing: true })).toBeNull();
    expect(areaKey({ key: "Enter", altKey: true })).toBeNull();
    expect(areaKey({ key: "a", altKey: false })).toBeNull();
  });
});

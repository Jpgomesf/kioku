import { describe, expect, it } from "vitest";
import { getVaultsConfig } from "../../api/vaults/mock";
import { setDrafted } from "./draft";
import {
  askedProviders,
  draftChangesVault,
  filterVaults,
  isFiltered,
  NO_FILTERS,
  providerColumns,
  vaultMatches,
} from "./matrix";

const config = getVaultsConfig();
const [personal, work] = config.vaults;
if (!personal || !work) throw new Error("mock has no personal and work vaults");

describe("access matrix", () => {
  it("makes one column per provider, naming the apps on it", () => {
    const columns = providerColumns(config);
    expect(columns.map((c) => c.title)).toEqual([
      "Anthropic",
      "This Mac",
      "OpenAI",
      "Google",
      "Moonshot",
      "DeepSeek",
      "Other",
    ]);
    expect(columns[0]?.apps).toEqual(["Claude Code", "Claude Desktop"]);
  });

  it("matches every word against names, folders, remotes and areas", () => {
    expect(vaultMatches(work, "")).toBe(true);
    expect(vaultMatches(work, "WORK handbook")).toBe(true);
    expect(vaultMatches(work, "example-work")).toBe(true);
    expect(vaultMatches(personal, "handbook")).toBe(false);
  });

  it("filters by an app that can read, by request and by the draft", () => {
    const asked = askedProviders(config, [
      { id: "r", app: "codex", vault: "personal", reason: "", requestedAt: "" },
    ]);
    expect(asked.get("personal")).toEqual(new Set(["openai"]));
    const names = (draft = {}, filters = NO_FILTERS) =>
      filterVaults(config, filters, draft, asked).map((v) => v.name);
    expect(names(undefined, { ...NO_FILTERS, readableBy: "openai" })).toEqual(["work"]);
    expect(names(undefined, { ...NO_FILTERS, asking: true })).toEqual(["personal"]);
    // The readable filter follows the draft, not the saved file.
    const draft = setDrafted({}, personal, "openai", true);
    expect(names(draft, { ...NO_FILTERS, readableBy: "openai" })).toEqual(["personal", "work"]);
    expect(names(draft, { ...NO_FILTERS, changed: true })).toEqual(["personal"]);
    expect(draftChangesVault(work, draft)).toBe(false);
  });

  it("says when any filter is on", () => {
    expect(isFiltered(NO_FILTERS)).toBe(false);
    expect(isFiltered({ ...NO_FILTERS, query: "  " })).toBe(false);
    expect(isFiltered({ ...NO_FILTERS, changed: true })).toBe(true);
  });
});

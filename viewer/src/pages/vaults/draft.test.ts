import { beforeEach, describe, expect, it } from "vitest";
import { getVaultsConfig, previewVisibility } from "../../api/vaults/mock";
import {
  type DraftRequest,
  declineRequest,
  discardDraft,
  dismissRequest,
  draftChanges,
  draftedCanRead,
  getDraftState,
  listNames,
  openRequests,
  PROVIDER_WORDS,
  providerWords,
  resetDraftStore,
  setDraft,
  setDrafted,
} from "./draft";
import { unchangedLines, warningLines } from "./index";

const config = getVaultsConfig();
const personal = config.vaults.find((v) => v.name === "personal");
if (!personal) throw new Error("mock has no personal vault");

describe("visibility draft", () => {
  beforeEach(resetDraftStore);

  it("starts with no changes", () => {
    expect(draftChanges(config, {})).toEqual([]);
  });

  it("switches every app on the same provider together", () => {
    const draft = setDrafted({}, personal, "anthropic", false);
    expect(draftChanges(config, draft)).toEqual([
      { vault: "personal", app: "claude-code", canRead: false },
      { vault: "personal", app: "claude-desktop", canRead: false },
    ]);
    expect(draftedCanRead(personal, "local", draft)).toBe(true);
  });

  it("drops a switch set back to the saved value", () => {
    const on = setDrafted({}, personal, "openai", true);
    expect(Object.keys(on)).toHaveLength(1);
    expect(setDrafted(on, personal, "openai", false)).toEqual({});
  });

  const asked: DraftRequest = { id: "req-1", vault: "personal", app: "codex", provider: "openai" };

  it("keeps the request only while the draft has changes", () => {
    setDraft(setDrafted({}, personal, "openai", true), asked);
    expect(getDraftState().request).toEqual(asked);
    setDraft({});
    expect(getDraftState().request).toBeNull();
  });

  it("drops the request once its change is gone, even with other changes left", () => {
    setDraft(setDrafted({}, personal, "openai", true), asked);
    setDraft(setDrafted(getDraftState().draft, personal, "anthropic", false));
    expect(getDraftState().request).toEqual(asked);
    setDraft(setDrafted(getDraftState().draft, personal, "openai", false));
    expect(getDraftState().request).toBeNull();
    expect(draftChanges(config, getDraftState().draft).map((c) => c.app)).toEqual([
      "claude-code",
      "claude-desktop",
    ]);
  });

  it("declining a request keeps the person's other changes", () => {
    setDraft(setDrafted({}, personal, "anthropic", false));
    setDraft(setDrafted(getDraftState().draft, personal, "openai", true), asked);
    declineRequest(personal, asked);
    const state = getDraftState();
    expect(state.request).toBeNull();
    expect(state.dismissed).toEqual(["req-1"]);
    expect(state.draft).toEqual({ "personal\nanthropic": false });
  });

  it("counts only requests from apps that can't read yet and aren't put off", () => {
    const req = {
      id: "r",
      app: "codex",
      vault: "personal",
      reason: "",
      requestedAt: "",
    };
    const reads = { ...req, id: "s", app: "claude-code" };
    expect(openRequests(config, [req, reads], []).map((r) => r.id)).toEqual(["r"]);
    expect(openRequests(config, [req], ["r"])).toEqual([]);
  });

  it("names every kioku provider in words", () => {
    for (const id of ["local", "anthropic", "openai", "moonshot", "deepseek", "google", "other"]) {
      expect(PROVIDER_WORDS[id]).toBeDefined();
      expect(providerWords(id)).not.toBe(id);
    }
  });

  it("joins names as a list", () => {
    expect(listNames(["A"])).toBe("A");
    expect(listNames(["A", "B"])).toBe("A and B");
    expect(listNames(["A", "B", "C"])).toBe("A, B and C");
  });

  it("discards the draft but remembers put-off requests", () => {
    dismissRequest("req-1");
    setDraft(setDrafted({}, personal, "openai", true), asked);
    discardDraft();
    expect(getDraftState()).toEqual({ draft: {}, request: null, dismissed: ["req-1"] });
  });

  it("explains a change in plain words", () => {
    const changes = draftChanges(config, setDrafted({}, personal, "openai", true));
    expect(previewVisibility(changes).summary).toEqual([
      "Codex could read every note in personal.",
    ]);
    expect(warningLines(config, changes)).toEqual(["Codex sends what it reads to OpenAI."]);
    const lines = unchangedLines(config, changes);
    expect(lines).toContain("work: nothing changes.");
    expect(lines).toContain(
      "Claude Code, Claude Desktop and Kilo with local models can still read personal.",
    );
    expect(lines).toContain("Gemini CLI, Kimi, DeepSeek and Other apps still can't read personal.");
  });

  it("gives no warning for apps on this Mac", () => {
    const changes = draftChanges(config, setDrafted({}, personal, "local", false));
    expect(warningLines(config, changes)).toEqual([]);
  });

  it("keeps the review short when a column changes many vaults", () => {
    // Ten vaults like personal, all given to Codex at once, as a column's All would.
    const many = {
      vaults: Array.from({ length: 10 }, (_, i) => ({ ...personal, name: `client-${i}` })),
    };
    let draft = {};
    for (const vault of many.vaults.slice(0, 6)) draft = setDrafted(draft, vault, "openai", true);
    const changes = draftChanges(many, draft);
    expect(changes).toHaveLength(6);
    // One warning per app, not one per vault.
    expect(warningLines(many, changes)).toEqual(["Codex sends what it reads to OpenAI."]);
    // The untouched vaults are counted, and per-vault lines give way to one.
    expect(unchangedLines(many, changes)).toEqual([
      "Nothing changes in the other 4 vaults.",
      "Every other app keeps the access it has.",
    ]);
  });
});
